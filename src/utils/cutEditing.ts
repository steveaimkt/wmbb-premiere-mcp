/**
 * Cut-editing helpers that work on a word-level transcript.
 *
 * Two operations that talking-head editors do by hand, all day:
 *
 *   1. Filler removal  — "음", "어", "uh" between sentences. Individually a
 *      third of a second, collectively minutes per video.
 *   2. Text-based edit — "cut the part where I said X". Find the span by what
 *      was spoken rather than by scrubbing for a timecode.
 *
 * Both return spans in SOURCE-clip time, matching the analyzers, so their output
 * feeds apply_timeline_removals with sourceTimes=true.
 */

import { WhisperSegment, WhisperWord } from './whisperRunner.js';

export interface Span {
  start: number;
  end: number;
  duration: number;
}

export interface FillerHit extends Span {
  word: string;
  /** Silence on each side. A filler wedged between two words at speech pace is
   *  far more likely to be a real word being used normally. */
  gapBefore: number;
  gapAfter: number;
}

export interface TextMatch extends Span {
  text: string;
  similarity: number;
  /** Word index range within the flattened transcript. */
  wordRange: [number, number];
}

/**
 * Conservative default. Korean is full of single syllables that are both filler
 * and real vocabulary — "그" (that), "뭐" (what), "이제" (now) — so the default
 * list holds only tokens with no ordinary meaning. Add the ambiguous ones
 * yourself when you have listened to the take and know they are filler.
 */
export const DEFAULT_FILLERS = [
  '음', '으음', '흠', '어어', '어어어', '아아', '에에',
  'uh', 'uhh', 'um', 'umm', 'er', 'err', 'hmm', 'mmm',
];

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Strip punctuation/spacing so "음," and "음" compare equal. */
function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s.,!?…"'`~\-—()[\]{}·、。！？，]/g, '')
    .trim();
}

function flattenWords(segments: WhisperSegment[]): WhisperWord[] {
  const words: WhisperWord[] = [];
  for (const seg of segments) {
    if (seg.words && seg.words.length) words.push(...seg.words);
  }
  return words;
}

/**
 * Find filler words to cut.
 *
 * @param segments      Word-level Whisper segments.
 * @param fillers       Tokens treated as filler. Defaults to DEFAULT_FILLERS.
 * @param paddingSec    Kept at each end of the removal so the cut is not abrupt.
 * @param minGapSec     A filler only counts when there is at least this much
 *                      silence on one side of it. 0 disables the check.
 */
export function findFillerWords(
  segments: WhisperSegment[],
  fillers: string[] = DEFAULT_FILLERS,
  paddingSec = 0.05,
  minGapSec = 0.15,
): FillerHit[] {
  const words = flattenWords(segments);
  const set = new Set(fillers.map(normalizeToken).filter(Boolean));
  const hits: FillerHit[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const token = normalizeToken(w.word);
    if (!token || !set.has(token)) continue;

    const prev = words[i - 1];
    const next = words[i + 1];
    const gapBefore = prev ? w.start - prev.end : Infinity;
    const gapAfter = next ? next.start - w.end : Infinity;

    // Surrounded tightly by speech on both sides => probably a real word.
    if (minGapSec > 0 && gapBefore < minGapSec && gapAfter < minGapSec) continue;

    const start = w.start - paddingSec;
    const end = w.end + paddingSec;
    // Never eat into a neighbouring word.
    const safeStart = prev ? Math.max(start, prev.end) : Math.max(0, start);
    const safeEnd = next ? Math.min(end, next.start) : end;
    if (safeEnd - safeStart <= 0.01) continue;

    hits.push({
      start: round(safeStart),
      end: round(safeEnd),
      duration: round(safeEnd - safeStart),
      word: w.word.trim(),
      gapBefore: Number.isFinite(gapBefore) ? round(gapBefore) : -1,
      gapAfter: Number.isFinite(gapAfter) ? round(gapAfter) : -1,
    });
  }

  return hits;
}

/** Dice coefficient over character bigrams. Same measure the duplicate-take
 *  detector uses, so thresholds mean the same thing across the toolset. */
function similarity(a: string, b: string): number {
  const na = normalizeToken(a);
  const nb = normalizeToken(b);
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
    overlap += Math.min(countA, mb.get(bg) || 0);
  }
  return (2 * overlap) / (na.length - 1 + (nb.length - 1));
}

/**
 * Locate spoken phrases by text.
 *
 * Slides a window over the transcript sized to the query and scores each
 * position. Window length is varied around the query length so a match is still
 * found when the delivery was looser than the wording.
 *
 * @param query      The phrase to find.
 * @param threshold  0..1 minimum similarity. Default 0.7.
 * @param paddingSec Added to each end of the returned span.
 */
export function findTextSpans(
  segments: WhisperSegment[],
  query: string,
  threshold = 0.7,
  paddingSec = 0.05,
): TextMatch[] {
  const words = flattenWords(segments);
  if (!words.length || !normalizeToken(query)) return [];

  const queryLen = normalizeToken(query).length;

  // Window sizes to try, in words. Derived from the query length assuming a few
  // characters per word, then widened both ways.
  const approxWords = Math.max(1, Math.round(queryLen / 3));
  const sizes: number[] = [];
  for (let d = -2; d <= 3; d++) {
    const n = approxWords + d;
    if (n >= 1 && !sizes.includes(n)) sizes.push(n);
  }

  // Score every candidate window first, then take them best-first. Accepting
  // the earliest window that merely clears the threshold picks up matches that
  // start a word too soon: a window carrying an extra leading word still scores
  // well above threshold, and it would win purely by being scanned first. The
  // tight window always scores higher, so best-first selects it instead.
  const candidates: Array<{ sim: number; start: number; end: number }> = [];
  for (let i = 0; i < words.length; i++) {
    for (const size of sizes) {
      const endIdx = i + size - 1;
      if (endIdx >= words.length) continue;
      const text = words.slice(i, endIdx + 1).map((w) => w.word).join(' ');
      const sim = similarity(text, query);
      if (sim >= threshold) candidates.push({ sim, start: i, end: endIdx });
    }
  }
  // Ties broken by the shorter window, then by position, so the result is
  // deterministic rather than dependent on scan order.
  candidates.sort((a, b) => b.sim - a.sim || (a.end - a.start) - (b.end - b.start) || a.start - b.start);

  const matches: TextMatch[] = [];
  const used = new Set<number>();

  for (const cand of candidates) {
    let overlaps = false;
    for (let k = cand.start; k <= cand.end; k++) {
      if (used.has(k)) { overlaps = true; break; }
    }
    if (overlaps) continue;

    const first = words[cand.start]!;
    const last = words[cand.end]!;
    const prev = words[cand.start - 1];
    const next = words[cand.end + 1];
    const start = prev ? Math.max(first.start - paddingSec, prev.end) : Math.max(0, first.start - paddingSec);
    const end = next ? Math.min(last.end + paddingSec, next.start) : last.end + paddingSec;

    matches.push({
      start: round(start),
      end: round(end),
      duration: round(end - start),
      text: words.slice(cand.start, cand.end + 1).map((w) => w.word.trim()).join(' '),
      similarity: round(cand.sim),
      wordRange: [cand.start, cand.end],
    });

    for (let k = cand.start; k <= cand.end; k++) used.add(k);
  }

  // Report in playback order, not score order — callers cut along the timeline.
  matches.sort((a, b) => a.start - b.start);
  return matches;
}
