/**
 * freezeDetect: parse + classify are pure and cover the static/active decision.
 * detectFreeze itself shells out to ffmpeg, so it is validated separately against
 * real footage, not in the unit suite.
 */

import { parseFreezeIntervals, classifyByLongestFreeze } from '../../utils/freezeDetect.js';

describe('parseFreezeIntervals', () => {
  it('reads completed freeze intervals', () => {
    const stderr = [
      'lavfi.freezedetect.freeze_start: 0',
      'lavfi.freezedetect.freeze_duration: 13.783333',
      'lavfi.freezedetect.freeze_end: 13.783333',
      'lavfi.freezedetect.freeze_start: 20',
      'lavfi.freezedetect.freeze_duration: 1.883333',
      'lavfi.freezedetect.freeze_end: 21.883333',
    ].join('\n');
    const r = parseFreezeIntervals(stderr, 29);
    expect(r.durations).toEqual([13.783333, 1.883333]);
    expect(r.longestFreeze).toBeCloseTo(13.783333, 3);
  });

  it('treats a dangling freeze_start (frozen through the end) as a freeze to span end', () => {
    // A 5s title card frozen the whole span: freeze_start printed, never ends.
    const stderr = 'lavfi.freezedetect.freeze_start: 0';
    const r = parseFreezeIntervals(stderr, 5);
    expect(r.durations).toEqual([5]);
    expect(r.longestFreeze).toBe(5);
    expect(r.totalFrozen).toBe(5);
  });

  it('adds the tail freeze after the last completed one (install-wait pattern)', () => {
    // 50.58s freeze ends, then another freeze_start dangles to the 60s span end.
    const stderr = [
      'freeze_start: 0',
      'freeze_duration: 50.583333',
      'freeze_end: 50.583333',
      'freeze_start: 50.583333',
    ].join('\n');
    const r = parseFreezeIntervals(stderr, 60);
    expect(r.longestFreeze).toBeCloseTo(50.583333, 3); // the dominant block
    expect(r.durations.length).toBe(2);
  });

  it('returns nothing frozen when the screen moved the whole time', () => {
    const r = parseFreezeIntervals('', 30);
    expect(r.durations).toEqual([]);
    expect(r.longestFreeze).toBe(0);
  });
});

describe('classifyByLongestFreeze', () => {
  const S = 0.8, A = 0.5;
  it('one dominant freeze reads static (safe to cut)', () => {
    expect(classifyByLongestFreeze(0.84, S, A)).toBe('static'); // install-wait
    expect(classifyByLongestFreeze(1.0, S, A)).toBe('static');  // title card
  });
  it('no dominant freeze reads active (protect the demo)', () => {
    expect(classifyByLongestFreeze(0.48, S, A)).toBe('active'); // fragmented demo
    expect(classifyByLongestFreeze(0.0, S, A)).toBe('active');
  });
  it('the middle is ambiguous — escalate to a frame check', () => {
    expect(classifyByLongestFreeze(0.65, S, A)).toBe('ambiguous');
  });
});
