/**
 * Silence-gap detection over a word-level transcript.
 *
 * Split out of speechAnalysis.ts so it can be unit tested. That module pulls in
 * whisperRunner, which uses `import.meta` and therefore cannot be parsed by the
 * CJS test transform — importing it from a test takes the whole suite down. This
 * file depends on the transcript SHAPE only, and a type-only import is erased at
 * compile time, so nothing is loaded at runtime.
 */

import type { WhisperSegment, WhisperWord } from './whisperRunner.js';

export interface Span {
  start: number;
  end: number;
  duration: number;
}

/** Where a gap sits relative to the speech.
 *
 *  `head`/`tail` are the intro and outro margins — the material before the first
 *  word and after the last one. They are NOT interchangeable with the pauses
 *  between words: they are where a title card sits, or where the demo keeps
 *  running after the narration stops. Cutting them is an editorial decision
 *  about the top and tail of the piece, so they are reported but never
 *  recommended. See EXCLUDED_GAP_KINDS in speechAnalysis.ts.
 */
export type GapKind = 'head' | 'inner' | 'tail';

export interface SilenceGap extends Span {
  /** Text just before the gap, for context. */
  afterText?: string;
  /** head = before the first word, tail = after the last, inner = between two. */
  kind: GapKind;
}

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Marks the leading gap, which has no preceding word to name. */
export const HEAD_MARKER = '(head)';

/** Gaps longer than minGapSec = silence to trim.
 *
 *  `padding` seconds are left in place at each end of the gap. Removing the
 *  whole gap butts the words straight against each other, which strips out the
 *  breath and makes the edit sound rushed — the same reason the ffmpeg analyzer
 *  keeps padding around its speech segments. A gap that is not longer than the
 *  padding it would keep is left alone entirely.
 *
 *  Covers three kinds of silence: before the first word, between two words, and
 *  after the last word. The head and tail are not gaps *between* words, so a
 *  word-pair loop cannot see them — yet on a real take they are usually the
 *  longest silences present (the seconds spent reaching for the record button),
 *  and leaving them out ships a cut that still opens and closes on dead air.
 *
 *  @param duration Length of the media, needed to measure the tail. Pass 0 when
 *                  it is unknown; no tail gap is reported rather than one that
 *                  runs to an arbitrary point.
 */
export function findSilenceGaps(
  segments: WhisperSegment[],
  minGapSec: number,
  padding: number,
  duration = 0,
): SilenceGap[] {
  const words: WhisperWord[] = [];
  for (const seg of segments) {
    if (seg.words && seg.words.length) words.push(...seg.words);
  }

  const gaps: SilenceGap[] = [];

  const first = words[0];
  if (first && first.start - padding > minGapSec) {
    gaps.push({
      start: 0,
      end: round(first.start - padding),
      duration: round(first.start - padding),
      afterText: HEAD_MARKER,
      kind: 'head',
    });
  }

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
      kind: 'inner',
    });
  }

  const last = words[words.length - 1];
  if (last && duration > 0 && duration - (last.end + padding) > minGapSec) {
    gaps.push({
      start: round(last.end + padding),
      end: round(duration),
      duration: round(duration - (last.end + padding)),
      afterText: last.word,
      kind: 'tail',
    });
  }

  return gaps.sort((a, b) => a.start - b.start);
}
