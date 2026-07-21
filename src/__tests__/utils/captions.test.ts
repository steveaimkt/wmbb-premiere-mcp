/**
 * Unit tests for caption building and serialization.
 *
 * These run without Premiere and without Whisper — the cue logic is pure, so
 * the readability rules can be pinned down here rather than discovered in an
 * export.
 */

import { buildCues, toSrt, toVtt, toTxt, serializeCues, applyGlossary, DEFAULT_GLOSSARY } from '../../utils/captions.js';
import type { WhisperSegment } from '../../utils/whisperRunner.js';

/** Build a segment whose words are evenly spaced one per `step` seconds. */
function segment(start: number, words: string[], step = 0.4): WhisperSegment {
  const w = words.map((word, i) => ({
    word,
    start: start + i * step,
    end: start + i * step + step * 0.8,
  }));
  return {
    start,
    end: w[w.length - 1]!.end,
    text: words.join(' '),
    words: w,
  };
}

describe('buildCues', () => {
  it('keeps a short segment as a single cue', () => {
    const cues = buildCues([segment(0, ['안녕하세요', '반갑습니다'])]);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe('안녕하세요 반갑습니다');
  });

  it('splits when the character budget is exceeded', () => {
    // 8 words x 5 chars = 40 chars; budget below forces at least two cues.
    const words = Array.from({ length: 8 }, (_, i) => `word${i}`);
    const cues = buildCues([segment(0, words)], { maxCharsPerLine: 10, maxLines: 1 });
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.text.length).toBeLessThanOrEqual(10);
    }
  });

  it('splits when a cue would run longer than maxDurationSec', () => {
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`);
    const cues = buildCues([segment(0, words, 1.0)], { maxDurationSec: 3, maxCharsPerLine: 999, maxLines: 1 });
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.end - cue.start).toBeLessThanOrEqual(3.01);
    }
  });

  it('breaks a cue at sentence-final punctuation', () => {
    const cues = buildCues([segment(0, ['첫문장입니다.', '두번째'])], { maxCharsPerLine: 999, maxLines: 1 });
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe('첫문장입니다.');
  });

  it('wraps text to at most maxLines lines', () => {
    const words = Array.from({ length: 6 }, (_, i) => `word${i}`);
    const cues = buildCues([segment(0, words)], { maxCharsPerLine: 12, maxLines: 2 });
    for (const cue of cues) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
    }
  });

  it('stretches a too-short cue up to minDurationSec', () => {
    const seg: WhisperSegment = {
      start: 0,
      end: 0.2,
      text: '네',
      words: [{ word: '네', start: 0, end: 0.2 }],
    };
    const cues = buildCues([seg], { minDurationSec: 1.5 });
    expect(cues[0]!.end).toBeCloseTo(1.5, 3);
  });

  it('starts a new cue after a long pause', () => {
    const cues = buildCues(
      [
        { start: 0, end: 0.2, text: '네', words: [{ word: '네', start: 0, end: 0.2 }] },
        { start: 4.0, end: 4.6, text: '다음', words: [{ word: '다음', start: 4.0, end: 4.6 }] },
      ],
      { maxGapSec: 1 },
    );
    expect(cues).toHaveLength(2);
  });

  it('never stretches a cue into the next one', () => {
    const cues = buildCues(
      [
        { start: 0, end: 0.2, text: '네', words: [{ word: '네', start: 0, end: 0.2 }] },
        { start: 4.0, end: 5.0, text: '다음', words: [{ word: '다음', start: 4.0, end: 5.0 }] },
      ],
      { minDurationSec: 10, gapSec: 0.04, maxGapSec: 1 },
    );
    expect(cues).toHaveLength(2);
    expect(cues[0]!.end).toBeLessThan(cues[1]!.start);
  });

  it('falls back to segment timing when word timestamps are missing', () => {
    const cues = buildCues([{ start: 2, end: 5, text: '워드 타임스탬프 없음' }]);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.start).toBe(2);
    expect(cues[0]!.end).toBe(5);
  });

  it('returns nothing for empty input', () => {
    expect(buildCues([])).toEqual([]);
  });
});

describe('serialization', () => {
  const cues = buildCues([segment(61.5, ['안녕하세요'])]);

  it('writes SRT with comma milliseconds and 1-based indices', () => {
    const srt = toSrt(cues);
    expect(srt).toMatch(/^1\n00:01:01,500 --> /);
  });

  it('writes VTT with a WEBVTT header and dot milliseconds', () => {
    const vtt = toVtt(cues);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:01:01.500 --> ');
  });

  it('writes txt as "(M:SS) text"', () => {
    expect(toTxt(cues)).toBe('(1:01) 안녕하세요');
  });

  it('numbers SRT entries consecutively', () => {
    const many = buildCues([segment(0, ['하나.', '둘.', '셋.'])], { maxCharsPerLine: 999, maxLines: 1 });
    const srt = toSrt(many);
    expect(srt).toMatch(/^1\n/);
    expect(srt).toContain('\n2\n');
    expect(srt).toContain('\n3\n');
  });

  it('dispatches on format', () => {
    expect(serializeCues(cues, 'vtt').startsWith('WEBVTT')).toBe(true);
    expect(serializeCues(cues, 'txt')).toContain('(1:01)');
    expect(serializeCues(cues, 'srt')).toContain('-->');
  });
});

describe('glossary', () => {
  it('restores written forms Whisper spelled out in Hangul', () => {
    expect(applyGlossary('에이피아이를 호출합니다', DEFAULT_GLOSSARY)).toBe('API를 호출합니다');
  });

  it('replaces the longest key first', () => {
    // "지피티" is also a key; "챗지피티" must win where both could match.
    expect(applyGlossary('챗지피티', DEFAULT_GLOSSARY)).toBe('ChatGPT');
  });

  it('applies caller entries on top of the defaults', () => {
    const merged = { ...DEFAULT_GLOSSARY, 헤르메스: 'Hermes' };
    expect(applyGlossary('헤르메스와 에이피아이', merged)).toBe('Hermes와 API');
  });

  it('leaves text alone when nothing matches', () => {
    expect(applyGlossary('오늘 날씨가 좋습니다', DEFAULT_GLOSSARY)).toBe('오늘 날씨가 좋습니다');
  });

  it('is applied while cues are built', () => {
    const cues = buildCues([segment(0, ['에이피아이', '연동'])]);
    expect(cues[0]!.text).toBe('API 연동');
  });

  it('lets a caller override a built-in entry', () => {
    const cues = buildCues([segment(0, ['클로드'])], { glossary: { 클로드: '클로드' } });
    expect(cues[0]!.text).toBe('클로드');
  });
});

describe('line balancing', () => {
  it('evens out a two-line cue instead of dangling a short tail', () => {
    // Greedy wrapping would fill line 1 and leave one short word on line 2.
    const cues = buildCues([segment(0, ['가나다라마', '바사아자차', '카타파하'])], {
      maxCharsPerLine: 12,
      maxLines: 2,
    });
    const [a, b] = cues[0]!.lines;
    expect(cues[0]!.lines).toHaveLength(2);
    expect(Math.abs(a!.length - b!.length)).toBeLessThanOrEqual(6);
  });

  it('breaks a token longer than the line limit', () => {
    const long = '가'.repeat(30);
    const cues = buildCues([segment(0, [long])], { maxCharsPerLine: 10, maxLines: 2 });
    for (const cue of cues) {
      for (const line of cue.lines) {
        expect(line.length).toBeLessThanOrEqual(10);
      }
    }
  });

  it('keeps a cue on one line when it fits', () => {
    const cues = buildCues([segment(0, ['짧은', '문장'])], { maxCharsPerLine: 20, maxLines: 2 });
    expect(cues[0]!.lines).toHaveLength(1);
  });
});
