/**
 * Unit tests for the cut-editing helpers.
 *
 * Filler detection and text search decide what gets deleted from a timeline, so
 * their edge cases (a filler that is really a word, a match that runs off the
 * end of the transcript) are worth pinning down without Premiere in the loop.
 */

import { findFillerWords, findTextSpans, DEFAULT_FILLERS } from '../../utils/cutEditing.js';
import type { WhisperSegment } from '../../utils/whisperRunner.js';

/** One segment from explicit [word, start, end] triples. */
function seg(words: Array<[string, number, number]>): WhisperSegment {
  const w = words.map(([word, start, end]) => ({ word, start, end }));
  return {
    start: w[0]!.start,
    end: w[w.length - 1]!.end,
    text: words.map(([t]) => t).join(' '),
    words: w,
  };
}

describe('findFillerWords', () => {
  it('finds a filler surrounded by silence', () => {
    const hits = findFillerWords([
      seg([
        ['그래서', 0.0, 0.5],
        ['음', 1.0, 1.4],
        ['결론은', 2.0, 2.5],
      ]),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.word).toBe('음');
  });

  it('ignores a filler token spoken at speech pace on both sides', () => {
    // No real pause around it => far more likely to be an ordinary word.
    const hits = findFillerWords([
      seg([
        ['그래서', 0.0, 0.5],
        ['음', 0.52, 0.62],
        ['결론은', 0.64, 1.1],
      ]),
    ]);
    expect(hits).toHaveLength(0);
  });

  it('honours minGapSec = 0 by skipping the pause check', () => {
    const hits = findFillerWords(
      [seg([['그래서', 0.0, 0.5], ['음', 0.52, 0.62], ['결론은', 0.64, 1.1]])],
      DEFAULT_FILLERS,
      0.02,
      0,
    );
    expect(hits).toHaveLength(1);
  });

  it('matches despite trailing punctuation', () => {
    const hits = findFillerWords([
      seg([['자', 0, 0.4], ['음,', 1.0, 1.4], ['다음', 2.0, 2.4]]),
    ]);
    expect(hits).toHaveLength(1);
  });

  it('excludes ambiguous Korean words from the default list', () => {
    // "그", "뭐", "이제" are ordinary vocabulary — cutting them by default would
    // delete real speech.
    for (const word of ['그', '뭐', '이제']) {
      expect(DEFAULT_FILLERS).not.toContain(word);
    }
    const hits = findFillerWords([
      seg([['자', 0, 0.4], ['그', 1.0, 1.2], ['다음', 2.0, 2.4]]),
    ]);
    expect(hits).toHaveLength(0);
  });

  it('accepts a caller-supplied filler list', () => {
    const hits = findFillerWords(
      [seg([['자', 0, 0.4], ['그', 1.0, 1.2], ['다음', 2.0, 2.4]])],
      ['그'],
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.word).toBe('그');
  });

  it('never lets padding eat into a neighbouring word', () => {
    const hits = findFillerWords(
      [seg([['자', 0, 0.9], ['음', 1.0, 1.4], ['다음', 1.5, 2.0]])],
      DEFAULT_FILLERS,
      0.5, // padding far larger than the surrounding gaps
      0.05,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.start).toBeGreaterThanOrEqual(0.9);
    expect(hits[0]!.end).toBeLessThanOrEqual(1.5);
  });

  it('returns nothing for an empty transcript', () => {
    expect(findFillerWords([])).toEqual([]);
  });
});

describe('findTextSpans', () => {
  const transcript = [
    seg([
      ['오늘은', 0.0, 0.5],
      ['클로드', 0.6, 1.0],
      ['코드를', 1.1, 1.5],
      ['소개합니다', 1.6, 2.2],
      ['잘못', 3.0, 3.4],
      ['말한', 3.5, 3.8],
      ['부분입니다', 3.9, 4.5],
    ]),
  ];

  it('locates an exact phrase', () => {
    const matches = findTextSpans(transcript, '잘못 말한 부분입니다');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]!.text).toContain('잘못');
    expect(matches[0]!.start).toBeGreaterThan(2.5);
  });

  it('returns spans usable as removals (end after start)', () => {
    const matches = findTextSpans(transcript, '클로드 코드를 소개합니다');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    for (const m of matches) {
      expect(m.end).toBeGreaterThan(m.start);
      expect(m.duration).toBeCloseTo(m.end - m.start, 3);
    }
  });

  it('finds nothing when the phrase was never spoken', () => {
    expect(findTextSpans(transcript, '전혀 다른 이야기입니다', 0.85)).toEqual([]);
  });

  it('respects the threshold', () => {
    const loose = findTextSpans(transcript, '잘못 말한', 0.4);
    const strict = findTextSpans(transcript, '잘못 말한', 0.99);
    expect(loose.length).toBeGreaterThanOrEqual(strict.length);
  });

  it('returns non-overlapping matches', () => {
    const matches = findTextSpans(transcript, '잘못 말한', 0.5);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i]!.start).toBeGreaterThanOrEqual(matches[i - 1]!.end);
    }
  });

  it('handles an empty query and an empty transcript', () => {
    expect(findTextSpans(transcript, '')).toEqual([]);
    expect(findTextSpans([], '무엇이든')).toEqual([]);
  });
});
