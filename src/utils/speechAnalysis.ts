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

export type { WhisperWord, WhisperSegment };

export interface Span {
  start: number;
  end: number;
  duration: number;
}

export interface DuplicateTake {
  /** The span to remove (the earlier, flubbed take). */
  removeSpan: Span;
  /** The span that is kept (the clean retake). */
  keepSpan: Span;
  similarity: number;
  removedText: string;
  keptText: string;
}

export interface SilenceGap extends Span {
  /** Text just before the gap, for context. */
  afterText?: string;
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
  };
  segments: WhisperSegment[];
  duplicateTakes: DuplicateTake[];
  silenceGaps: SilenceGap[];
  fillerWords: FillerHit[];
  /** Union of duplicate-take spans and silence gaps, sorted — the recommended
   *  regions to cut out. */
  suggestedRemovals: Span[];
  /** All razor times (span boundaries), sorted and de-duped. */
  cutPoints: number[];
  stats: {
    segmentCount: number;
    duplicateCount: number;
    silenceGapCount: number;
    fillerCount: number;
    totalRemovableSec: number;
  };
  error?: string;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
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
 *  segment means the speaker restarted the line. Remove the earlier one. */
function findDuplicateTakes(
  segments: WhisperSegment[],
  threshold: number,
  lookback: number,
): DuplicateTake[] {
  const duplicates: DuplicateTake[] = [];
  const consumed = new Set<number>();

  for (let i = 1; i < segments.length; i++) {
    if (consumed.has(i)) continue;
    const cur = segments[i];
    if (!cur) continue;
    for (let j = i - 1; j >= Math.max(0, i - lookback); j--) {
      if (consumed.has(j)) continue;
      const prev = segments[j];
      if (!prev) continue;
      const sim = similarity(prev.text, cur.text);
      if (sim >= threshold) {
        // prev = flubbed take (remove), cur = clean retake (keep)
        duplicates.push({
          removeSpan: { start: round(prev.start), end: round(prev.end), duration: round(prev.end - prev.start) },
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

/** Gaps between consecutive words longer than minGapSec = silence to trim.
 *
 *  `padding` seconds are left in place at each end of the gap. Removing the
 *  whole gap butts the words straight against each other, which strips out the
 *  breath and makes the edit sound rushed — the same reason the ffmpeg analyzer
 *  keeps padding around its speech segments. A gap that is not longer than the
 *  padding it would keep is left alone entirely. */
function findSilenceGaps(segments: WhisperSegment[], minGapSec: number, padding: number): SilenceGap[] {
  const words: WhisperWord[] = [];
  for (const seg of segments) {
    if (seg.words && seg.words.length) words.push(...seg.words);
  }
  const gaps: SilenceGap[] = [];
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const cur = words[i];
    if (!prev || !cur) continue;
    const gap = cur.start - prev.end;
    if (gap < minGapSec) continue;

    const start = prev.end + padding;
    const end = cur.start - padding;
    if (end - start <= 0.01) continue; // nothing left worth cutting

    gaps.push({
      start: round(start),
      end: round(end),
      duration: round(end - start),
      afterText: prev.word,
    });
  }
  return gaps;
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
): Promise<SpeechEditAnalysis> {
  const base: SpeechEditAnalysis = {
    success: false,
    file,
    duration: 0,
    params: { model, similarityThreshold, minGapSec, paddingSec, removeFillers },
    segments: [],
    duplicateTakes: [],
    silenceGaps: [],
    fillerWords: [],
    suggestedRemovals: [],
    cutPoints: [],
    stats: { segmentCount: 0, duplicateCount: 0, silenceGapCount: 0, fillerCount: 0, totalRemovableSec: 0 },
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

  const duplicateTakes = findDuplicateTakes(segments, similarityThreshold, 2);
  const silenceGaps = findSilenceGaps(segments, minGapSec, paddingSec);
  const fillers = removeFillers ? findFillerWords(segments, fillerList) : [];

  const removalSpans: Span[] = [
    ...duplicateTakes.map((d) => d.removeSpan),
    ...silenceGaps.map((g) => ({ start: g.start, end: g.end, duration: g.duration })),
    ...fillers.map((f) => ({ start: f.start, end: f.end, duration: f.duration })),
  ];
  const suggestedRemovals = mergeSpans(removalSpans);

  const cutSet = new Set<number>();
  for (const span of suggestedRemovals) {
    if (span.start > 0.01) cutSet.add(round(span.start));
    if (span.end < duration - 0.01) cutSet.add(round(span.end));
  }
  const cutPoints = Array.from(cutSet).sort((a, b) => a - b);

  const totalRemovableSec = round(suggestedRemovals.reduce((acc, s) => acc + s.duration, 0));

  return {
    success: true,
    file,
    language: transcription.language,
    duration: round(duration),
    params: { model, similarityThreshold, minGapSec, paddingSec, removeFillers },
    segments,
    duplicateTakes,
    silenceGaps,
    fillerWords: fillers,
    suggestedRemovals,
    cutPoints,
    stats: {
      segmentCount: segments.length,
      duplicateCount: duplicateTakes.length,
      silenceGapCount: silenceGaps.length,
      fillerCount: fillers.length,
      totalRemovableSec,
    },
  };
}
