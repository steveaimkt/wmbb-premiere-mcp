/**
 * Speech-first edit-point analysis (Whisper layer).
 *
 * Runs faster-whisper (via scripts/whisper_transcribe.py) to get a word-level
 * transcription, then derives edit points from the CONTENT of the speech:
 *
 *   1. Duplicate / repeated takes  — the speaker flubbed a line and said it
 *      again. The EARLIER occurrence is flagged for removal (NG take).
 *   2. Silence gaps                — pauses between words longer than a
 *      threshold, computed from the word timestamps.
 *
 * Both become concrete removal spans + razor cut points so cuts land on real
 * spoken content instead of guessed timecodes.
 */

import { existsSync } from 'fs';
import { transcribeAudio, WhisperWord, WhisperSegment } from './whisperRunner.js';
import { findFillerWords, FillerHit, DEFAULT_FILLERS } from './cutEditing.js';
import { findSilenceGaps, round, type Span, type SilenceGap, type GapKind } from './silenceGaps.js';

export type { WhisperWord, WhisperSegment };
export type { Span, SilenceGap, GapKind };
export { findSilenceGaps };

export interface DuplicateTake {
  /** The span to remove (the earlier, flubbed take). */
  removeSpan: Span;
  /** The span that is kept (the clean retake). */
  keepSpan: Span;
  similarity: number;
  removedText: string;
  keptText: string;
}

/** One reviewable group of cut candidates.
 *
 *  The categories exist because these are not the same decision. Trimming a
 *  0.9s pause between two sentences is housekeeping; dropping the intro title
 *  card, or the 60 seconds where an install script runs on screen, changes what
 *  the piece IS. Handing back one flat list invites an editor to approve all of
 *  it at once, which is how a hook gets deleted. Each category carries its own
 *  recommendation so the approval is per-group.
 */
export interface ProposalGroup {
  /** Stable key for the category. */
  kind: 'pauses' | 'duplicates' | 'intro' | 'outro' | 'longGaps' | 'fillers';
  /** One line an editor can read without opening the spans. */
  label: string;
  spans: Span[];
  totalSec: number;
  /** Whether cutting this group is the safe default. */
  recommended: boolean;
  /** Why it is or is not recommended — surface this to the user verbatim. */
  note: string;
}

export interface SpeechEditAnalysis {
  success: boolean;
  file: string;
  language?: string | undefined;
  duration: number;
  params: {
    model: string;
    similarityThreshold: number;
    minGapSec: number;
    paddingSec: number;
    removeFillers: boolean;
    longGapSec: number;
    lookbackSec: number;
  };
  segments: WhisperSegment[];
  duplicateTakes: DuplicateTake[];
  silenceGaps: SilenceGap[];
  fillerWords: FillerHit[];
  /** Cut candidates split into reviewable groups. This is the field to present
   *  to a human; `suggestedRemovals` is only the recommended subset flattened. */
  proposals: ProposalGroup[];
  /** Union of the RECOMMENDED groups' spans, sorted and merged. Intro, outro and
   *  long gaps are deliberately absent — see ProposalGroup. */
  suggestedRemovals: Span[];
  /** All razor times (span boundaries), sorted and de-duped. */
  cutPoints: number[];
  /** Conditions the caller must not silently ignore (e.g. a suspect transcript). */
  warnings: string[];
  stats: {
    segmentCount: number;
    duplicateCount: number;
    silenceGapCount: number;
    fillerCount: number;
    /** Total of the recommended groups only. */
    totalRemovableSec: number;
    /** Total across every group, recommended or not. */
    totalProposedSec: number;
  };
  error?: string;
}

/** Normalize Korean/English text for similarity: strip spaces, punctuation, lowercase. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s.,!?…"'`~\-—()[\]{}·、。！？，]/g, '')
    .trim();
}

/** Dice coefficient over character bigrams — 0..1, no dependencies.
 *  Robust for short Korean phrases and partial repeats. */
function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na.length || !nb.length) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;

  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) || 0) + 1);
    }
    return m;
  };
  const ma = bigrams(na);
  const mb = bigrams(nb);
  let overlap = 0;
  for (const [bg, countA] of ma) {
    const countB = mb.get(bg) || 0;
    overlap += Math.min(countA, countB);
  }
  const total = na.length - 1 + (nb.length - 1);
  return (2 * overlap) / total;
}

/** Find repeated takes: a segment whose text closely matches a nearby earlier
 *  segment means the speaker restarted the line. Remove the earlier one.
 *
 *  The window is measured in SECONDS, not in segments. A segment count only
 *  works for an immediate stumble ("키미 K2.0" → "키미 K2.7"). The other real
 *  pattern is a take that breaks off mid-sentence, a long pause while the
 *  speaker resets the screen, and the same lines delivered again twenty seconds
 *  later — over a gap like that, the retake is still adjacent in segment terms
 *  on one recording and six segments away on another. Time is the honest unit.
 */
function findDuplicateTakes(
  segments: WhisperSegment[],
  threshold: number,
  lookbackSec: number,
): DuplicateTake[] {
  const duplicates: DuplicateTake[] = [];
  const consumed = new Set<number>();

  for (let i = 1; i < segments.length; i++) {
    if (consumed.has(i)) continue;
    const cur = segments[i];
    if (!cur) continue;
    for (let j = i - 1; j >= 0; j--) {
      if (consumed.has(j)) continue;
      const prev = segments[j];
      if (!prev) continue;
      if (cur.start - prev.end > lookbackSec) break; // out of the window
      const sim = similarity(prev.text, cur.text);
      if (sim >= threshold) {
        // prev = flubbed take (remove), cur = clean retake (keep).
        //
        // The removal runs to the START of the retake ONLY when the retake is the
        // very next segment (i === j+1) — i.e. nothing but silence sits between
        // them. Then the gap is the speaker resetting (dead air, sometimes 20s),
        // and taking it with the flub is right: the same words bracket both sides,
        // proof it is not a demo.
        //
        // If any other segment sits between the flub and its retake, that segment
        // is real content (or another take handled on its own turn). Extending
        // across it would swallow speech that must be kept AND overlap the other
        // take's own removal — the over-cut the simulation harness caught. So in
        // that case remove ONLY the flubbed take itself and leave the gap.
        const retakeImmediatelyFollows = i === j + 1;
        const removeEnd = retakeImmediatelyFollows
          ? Math.max(prev.end, Math.min(cur.start, prev.end + lookbackSec))
          : prev.end;
        duplicates.push({
          removeSpan: { start: round(prev.start), end: round(removeEnd), duration: round(removeEnd - prev.start) },
          keepSpan: { start: round(cur.start), end: round(cur.end), duration: round(cur.end - cur.start) },
          similarity: round(sim),
          removedText: prev.text,
          keptText: cur.text,
        });
        consumed.add(j);
        break;
      }
    }
  }
  duplicates.sort((a, b) => a.removeSpan.start - b.removeSpan.start);
  return duplicates;
}

/**
 * Collapse a run of sentence-level retakes into one block removal.
 *
 * When a speaker redoes a whole paragraph, sentence-pair matching finds several
 * duplicates in a row — but only the sentences whose wording survived verbatim.
 * The reworded ones in between match nothing, so removing the block one sentence
 * at a time leaves those middle sentences orphaned: a Swiss-cheese cut that reads
 * as broken speech. Found on real footage (K2.7 explanation recorded twice).
 *
 * When ≥2 duplicate pairs line up — flubs contiguous and ordered, their retakes
 * also contiguous and ordered and sitting after the flubs — that is a retaken
 * BLOCK, not coincidental repeats. Merge the run into a single removal from the
 * first flub to the start of the retake block, taking the whole first take plus
 * the reset gap and keeping the clean second take intact. The ≥2-aligned guard
 * keeps a lone repeated sentence on the safe sentence-level path.
 */
function mergeRetakeBlocks(dups: DuplicateTake[], contigGap = 6): DuplicateTake[] {
  if (dups.length < 2) return dups;
  const sorted = [...dups].sort((a, b) => a.removeSpan.start - b.removeSpan.start);
  const out: DuplicateTake[] = [];
  let run: DuplicateTake[] = [sorted[0]!];

  const flush = () => {
    if (run.length >= 2) {
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const start = first.removeSpan.start;
      // End at the last matched flub's end, but never past where the retake
      // block begins. Two guards in one min():
      //  - vs last flub end: don't extend to the retake start, or the reset gap
      //    (which may hold unique content — the A-B-C-A-B over-cut) gets swallowed.
      //  - vs first retake start: if the flub block interleaves past the retake
      //    start (coincidental matches), clamp so the removal never eats into the
      //    take we keep (the I8 removeSpan-overlaps-keepSpan the sim caught).
      // Interior unmatched sentences (bracketed by matched flubs) are inside
      // [start, end] and get removed; an unmatched tail is left alone, safe.
      const end = Math.min(Math.max(...run.map((d) => d.removeSpan.end)), first.keepSpan.start);
      out.push({
        removeSpan: { start, end, duration: round(end - start) },
        keepSpan: { start: first.keepSpan.start, end: last.keepSpan.end, duration: round(last.keepSpan.end - first.keepSpan.start) },
        similarity: round(Math.min(...run.map((d) => d.similarity))),
        removedText: run.map((d) => d.removedText).join(' / '),
        keptText: run.map((d) => d.keptText).join(' / '),
      });
    } else {
      out.push(run[0]!);
    }
    run = [];
  };

  for (let i = 1; i < sorted.length; i++) {
    const prev = run[run.length - 1]!;
    const cur = sorted[i]!;
    const flubsContig = cur.removeSpan.start >= prev.removeSpan.start && cur.removeSpan.start - prev.removeSpan.end < contigGap;
    const retakesContig = cur.keepSpan.start >= prev.keepSpan.start && cur.keepSpan.start - prev.keepSpan.end < contigGap;
    const retakeAfterFlub = cur.keepSpan.start > cur.removeSpan.end;
    if (flubsContig && retakesContig && retakeAfterFlub) run.push(cur);
    else { flush(); run = [cur]; }
  }
  flush();
  return out.sort((a, b) => a.removeSpan.start - b.removeSpan.start);
}

/** Merge overlapping spans into a clean sorted removal list. */
function mergeSpans(spans: Span[]): Span[] {
  if (!spans.length) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.start <= last.end + 0.001) {
      last.end = Math.max(last.end, cur.end);
      last.duration = round(last.end - last.start);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

export interface AnalyzeSegmentsOptions {
  model?: string;
  similarityThreshold?: number;
  minGapSec?: number;
  paddingSec?: number;
  removeFillers?: boolean;
  fillerList?: string[];
  longGapSec?: number;
  lookbackSec?: number;
}

export interface SegmentAnalysis {
  duplicateTakes: DuplicateTake[];
  silenceGaps: SilenceGap[];
  fillerWords: FillerHit[];
  proposals: ProposalGroup[];
  suggestedRemovals: Span[];
  cutPoints: number[];
  warnings: string[];
  stats: SpeechEditAnalysis['stats'];
}

/**
 * The whole cut-plan analysis, decoupled from Whisper. Given word-level segments
 * and the media duration, produce categorized proposals + the recommended cut.
 *
 * Split out of analyzeSpeechEditPoints so the plan logic can be fuzzed against
 * hundreds of synthetic transcripts with no audio and no Python — the transcription
 * step is the only part that needs whisper, and it is a thin wrapper over this.
 */
export function analyzeSegments(
  segments: WhisperSegment[],
  duration: number,
  opts: AnalyzeSegmentsOptions = {},
): SegmentAnalysis {
  const model = opts.model ?? 'small';
  const similarityThreshold = opts.similarityThreshold ?? 0.75;
  const minGapSec = opts.minGapSec ?? 0.6;
  const paddingSec = opts.paddingSec ?? 0.15;
  const removeFillers = opts.removeFillers ?? false;
  const fillerList = opts.fillerList ?? DEFAULT_FILLERS;
  const longGapSec = opts.longGapSec ?? 5;
  const lookbackSec = opts.lookbackSec ?? 25;

  const warnings: string[] = [];

  // A transcript with a large unheard head is the signature of an
  // under-powered model dropping the opening — the exact failure that once
  // deleted a hook. Warn loudly rather than let the head gap read as silence.
  const firstWord = segments.find((s) => s.words && s.words.length)?.words?.[0];
  if (firstWord && firstWord.start > 8 && /^(tiny|base)$/i.test(model)) {
    warnings.push(
      `Model "${model}" transcribed nothing for the first ${round(firstWord.start)}s. ` +
        `On a real recording that is usually the model missing the opening, not silence — ` +
        `re-run with model "small" or higher before trusting the head gap.`,
    );
  }

  const duplicateTakes = mergeRetakeBlocks(findDuplicateTakes(segments, similarityThreshold, lookbackSec));
  const silenceGaps = findSilenceGaps(segments, minGapSec, paddingSec, duration);
  const fillers = removeFillers ? findFillerWords(segments, fillerList) : [];

  // Duplicate-take spans win any overlap with a plain gap, so a gap that sits
  // inside a retake removal is not double-counted or re-proposed on its own.
  const dupSpans = duplicateTakes.map((d) => d.removeSpan);
  const coveredByDup = (g: SilenceGap) =>
    dupSpans.some((d) => g.start >= d.start - 0.05 && g.end <= d.end + 0.05);

  const innerGaps = silenceGaps.filter((g) => g.kind === 'inner' && !coveredByDup(g));
  const pauseGaps = innerGaps.filter((g) => g.duration < longGapSec);
  const longGaps = innerGaps.filter((g) => g.duration >= longGapSec);
  const headGap = silenceGaps.find((g) => g.kind === 'head');
  const tailGap = silenceGaps.find((g) => g.kind === 'tail');

  const toSpan = (g: SilenceGap): Span => ({ start: g.start, end: g.end, duration: g.duration });
  const sum = (spans: Span[]) => round(spans.reduce((a, s) => a + s.duration, 0));

  const proposals: ProposalGroup[] = [];
  if (dupSpans.length) {
    proposals.push({
      kind: 'duplicates', label: '반복/재테이크 (앞 테이크 + 그 뒤 데드에어)',
      spans: dupSpans, totalSec: sum(dupSpans), recommended: true,
      note: '같은 대사가 다시 나온 앞 테이크. 삭제 안전.',
    });
  }
  if (pauseGaps.length) {
    const spans = pauseGaps.map(toSpan);
    proposals.push({
      kind: 'pauses', label: `문장 사이 정적 (${minGapSec}~${longGapSec}초)`,
      spans, totalSec: sum(spans), recommended: true,
      note: '말과 말 사이 빈 구간. 앞뒤 호흡은 남김.',
    });
  }
  if (removeFillers && fillers.length) {
    const spans = fillers.map((f) => ({ start: f.start, end: f.end, duration: f.duration }));
    proposals.push({
      kind: 'fillers', label: '군더더기 말 (음/어/uh)',
      spans, totalSec: sum(spans), recommended: true,
      note: '명백한 필러만. 판단 애매한 한 음절은 제외됨.',
    });
  }
  if (headGap) {
    proposals.push({
      kind: 'intro', label: '인트로 여백 (첫 대사 이전)',
      spans: [toSpan(headGap)], totalSec: headGap.duration, recommended: false,
      note: '타이틀 카드가 앉는 자리. 앞에 인트로 영상을 붙일 거면 남기는 게 맞다. 자를지는 편집 판단.',
    });
  }
  if (tailGap) {
    proposals.push({
      kind: 'outro', label: '아웃트로 여백 (마지막 대사 이후)',
      spans: [toSpan(tailGap)], totalSec: tailGap.duration, recommended: false,
      note: '말이 끝난 뒤 화면이 도는 자리. 아웃트로를 붙일 거면 남긴다. 자를지는 편집 판단.',
    });
  }
  if (longGaps.length) {
    const spans = longGaps.map(toSpan);
    proposals.push({
      kind: 'longGaps', label: `긴 정적 (${longGapSec}초 이상)`,
      spans, totalSec: sum(spans), recommended: false,
      note: '대개 "실행해볼게요" 직후 화면 시연 구간. 자르면 데모가 사라진다. 배속 처리 검토 대상. 프레임 확인 후 개별 판단.',
    });
  }

  // The recommended cut is only the groups flagged safe. Intro/outro/longGaps
  // are present in `proposals` for the human, absent here on purpose.
  const recommendedSpans = proposals.filter((p) => p.recommended).flatMap((p) => p.spans);
  const suggestedRemovals = mergeSpans(recommendedSpans);

  const cutSet = new Set<number>();
  for (const span of suggestedRemovals) {
    if (span.start > 0.01) cutSet.add(round(span.start));
    if (span.end < duration - 0.01) cutSet.add(round(span.end));
  }
  const cutPoints = Array.from(cutSet).sort((a, b) => a - b);

  const totalRemovableSec = round(suggestedRemovals.reduce((acc, s) => acc + s.duration, 0));
  const totalProposedSec = round(proposals.reduce((acc, p) => acc + p.totalSec, 0));

  return {
    duplicateTakes,
    silenceGaps,
    fillerWords: fillers,
    proposals,
    suggestedRemovals,
    cutPoints,
    warnings,
    stats: {
      segmentCount: segments.length,
      duplicateCount: duplicateTakes.length,
      silenceGapCount: silenceGaps.length,
      fillerCount: fillers.length,
      totalRemovableSec,
      totalProposedSec,
    },
  };
}

/**
 * Analyze speech to find edit points from repeated takes and silence gaps.
 *
 * @param file                Absolute path to a media file (video or audio).
 * @param model               Whisper model size. Default 'base'.
 * @param language            Language code, or 'auto'. Default 'ko'.
 * @param similarityThreshold 0..1 text match to call two takes duplicates. Default 0.75.
 * @param minGapSec           Silence gap (s) between words to flag. Default 0.6.
 * @param paddingSec          Silence (s) kept at each end of a trimmed gap so the
 *                            edit keeps its breath. Default 0.15.
 * @param removeFillers       Also cut filler words ("음", "uh"). Default false.
 * @param fillerList          Filler tokens. Defaults to DEFAULT_FILLERS (only the
 *                            unambiguous ones — see cutEditing.ts).
 * @param longGapSec          Gaps at or above this are their own category, kept
 *                            out of the recommended cut because they are usually
 *                            on-screen demos, not silence. Default 5.
 * @param lookbackSec         Time window for matching a retake to its flubbed
 *                            take. Default 25 — long enough to bridge a mid-take
 *                            break and reset.
 */
export async function analyzeSpeechEditPoints(
  file: string,
  model = 'base',
  language = 'ko',
  similarityThreshold = 0.75,
  minGapSec = 0.6,
  paddingSec = 0.15,
  removeFillers = false,
  fillerList: string[] = DEFAULT_FILLERS,
  longGapSec = 5,
  lookbackSec = 25,
): Promise<SpeechEditAnalysis> {
  const base: SpeechEditAnalysis = {
    success: false,
    file,
    duration: 0,
    params: { model, similarityThreshold, minGapSec, paddingSec, removeFillers, longGapSec, lookbackSec },
    segments: [],
    duplicateTakes: [],
    silenceGaps: [],
    fillerWords: [],
    proposals: [],
    suggestedRemovals: [],
    cutPoints: [],
    warnings: [],
    stats: { segmentCount: 0, duplicateCount: 0, silenceGapCount: 0, fillerCount: 0, totalRemovableSec: 0, totalProposedSec: 0 },
  };

  if (!file) return { ...base, error: 'file path is required' };
  if (!existsSync(file)) return { ...base, error: `file not found: ${file}` };

  let transcription;
  try {
    transcription = await transcribeAudio(file, model, language);
  } catch (e: any) {
    return { ...base, error: `failed to run whisper: ${e?.message || e}` };
  }
  if (!transcription.success) {
    return { ...base, error: transcription.error || 'whisper transcription failed' };
  }

  const segments: WhisperSegment[] = transcription.segments;
  const duration = transcription.duration || (segments.length ? segments[segments.length - 1]!.end : 0);

  const analysis = analyzeSegments(segments, duration, {
    model, similarityThreshold, minGapSec, paddingSec, removeFillers, fillerList, longGapSec, lookbackSec,
  });

  return {
    success: true,
    file,
    language: transcription.language,
    duration: round(duration),
    params: { model, similarityThreshold, minGapSec, paddingSec, removeFillers, longGapSec, lookbackSec },
    segments,
    duplicateTakes: analysis.duplicateTakes,
    silenceGaps: analysis.silenceGaps,
    fillerWords: analysis.fillerWords,
    proposals: analysis.proposals,
    suggestedRemovals: analysis.suggestedRemovals,
    cutPoints: analysis.cutPoints,
    warnings: analysis.warnings,
    stats: analysis.stats,
  };
}
