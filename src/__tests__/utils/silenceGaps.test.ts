/**
 * Unit tests for silence-gap detection.
 *
 * The gap finder decides what gets ripple-deleted from a timeline, so the
 * boundaries matter: a gap that is really a breath must survive, and the dead
 * air at the head and tail of a take — which is not a gap *between* words and so
 * was invisible to the original word-pair loop — must be found.
 */

import { findSilenceGaps } from '../../utils/silenceGaps.js';
import type { WhisperSegment } from '../../utils/whisperRunner.js';

/** One segment from explicit [word, start, end] triples. */
function seg(...words: [string, number, number][]): WhisperSegment {
  return {
    start: words[0]![1],
    end: words[words.length - 1]![2],
    text: words.map((w) => w[0]).join(' '),
    words: words.map(([word, start, end]) => ({ word, start, end, prob: 0.9 })),
  } as WhisperSegment;
}

describe('findSilenceGaps', () => {
  const minGap = 0.6;
  const padding = 0.15;

  it('finds silence before the first word', () => {
    const segments = [seg(['안녕', 5.0, 5.4], ['하세요', 5.4, 6.0])];
    const gaps = findSilenceGaps(segments, minGap, padding, 10);

    const head = gaps.find((g) => g.afterText === '(head)');
    expect(head).toBeDefined();
    expect(head!.start).toBe(0);
    expect(head!.end).toBeCloseTo(4.85, 3); // 5.0 minus the breath we keep
  });

  it('finds silence after the last word, using the media duration', () => {
    const segments = [seg(['끝', 2.0, 2.5])];
    const gaps = findSilenceGaps(segments, minGap, padding, 20);

    const tail = gaps[gaps.length - 1]!;
    expect(tail.start).toBeCloseTo(2.65, 3);
    expect(tail.end).toBe(20);
  });

  it('reports no tail when the duration is unknown', () => {
    // duration=0 means the caller could not measure the file; inventing a tail
    // there would cut to an arbitrary point. The head is still measurable, so it
    // is still reported.
    const segments = [seg(['끝', 2.0, 2.5])];
    const gaps = findSilenceGaps(segments, minGap, padding, 0);

    expect(gaps.every((g) => g.start < 2.5)).toBe(true);
    expect(gaps.some((g) => g.start >= 2.5)).toBe(false);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.afterText).toBe('(head)');
  });

  it('leaves a short head alone', () => {
    // 0.4s before the first word is a breath, not dead air.
    const segments = [seg(['시작', 0.4, 1.0])];
    const gaps = findSilenceGaps(segments, minGap, padding, 5);

    expect(gaps.some((g) => g.afterText === '(head)')).toBe(false);
  });

  it('still finds gaps between words, and returns everything in time order', () => {
    const segments = [
      seg(['하나', 4.0, 4.5]),
      seg(['둘', 9.0, 9.5]), // 4.5s gap in the middle
    ];
    const gaps = findSilenceGaps(segments, minGap, padding, 30);

    expect(gaps).toHaveLength(3); // head, middle, tail
    expect(gaps.map((g) => g.start)).toEqual([...gaps.map((g) => g.start)].sort((a, b) => a - b));

    const middle = gaps[1]!;
    expect(middle.start).toBeCloseTo(4.65, 3);
    expect(middle.end).toBeCloseTo(8.85, 3);
    expect(middle.afterText).toBe('하나');
  });

  it('handles a transcript with no words at all', () => {
    expect(findSilenceGaps([], minGap, padding, 10)).toEqual([]);
  });
});
