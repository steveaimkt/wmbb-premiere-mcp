import { captionDurationSec, layoutCaptions, zoomKeyframes } from '../../voiceOrders/timing.js';
import { newOrder } from '../../voiceOrders/store.js';
import type { VoiceOrder } from '../../voiceOrders/types.js';

let n = 0;
function cap(timeSec: number | null, text: string, extra: Partial<VoiceOrder> = {}, placement: 'playhead' | 'after_previous' = 'playhead'): VoiceOrder {
  n += 1;
  return newOrder({
    id: `o${n}`, sequenceId: 's', timeSec, recordingPath: '/x.wav', status: 'ready',
    createdAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`,
    payload: { kind: 'caption', style: 'narration', text, placement },
    ...extra,
  });
}

describe('captionDurationSec', () => {
  test('clamps 1.5..5 on 0.8 + 0.12*len', () => {
    expect(captionDurationSec('')).toBe(1.5);
    expect(captionDurationSec('가나다라마')).toBe(1.5);
    expect(captionDurationSec('가'.repeat(30))).toBeCloseTo(4.4, 6);
    expect(captionDurationSec('가'.repeat(100))).toBe(5);
  });
  test('counts code points, not UTF-16 units', () => {
    expect(captionDurationSec('😀'.repeat(30))).toBeCloseTo(4.4, 6);
  });
});

describe('layoutCaptions', () => {
  test('two captions at the same time: second starts at first end', () => {
    const a = cap(10, '가'.repeat(30));
    const b = cap(10, '나'.repeat(30));
    const out = layoutCaptions([a, b], []);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ orderId: a.id, startSec: 10 });
    expect(out[0]!.endSec).toBeCloseTo(14.4, 6);
    expect(out[1]!.startSec).toBeCloseTo(14.4, 6);
  });

  test('earlier caption is trimmed to the next start when that keeps >=1.5s', () => {
    const a = cap(10, '가'.repeat(30)); // 4.4s -> would end 14.4
    const b = cap(12, '짧다');
    const out = layoutCaptions([a, b], []);
    expect(out[0]!.endSec).toBe(12);
    expect(out[1]!.startSec).toBe(12);
  });

  test('when trimming would break 1.5s, the earlier stays and the next is pushed to its end', () => {
    const a = cap(10, '가'.repeat(30));
    const b = cap(11, '짧다');
    const out = layoutCaptions([a, b], []);
    expect(out[0]!.endSec).toBeCloseTo(14.4, 6);
    expect(out[1]!.startSec).toBeCloseTo(14.4, 6);
  });

  test('a new caption is trimmed so it ends before the next existing caption', () => {
    const a = cap(10, '가'.repeat(30)); // would end 14.4
    const out = layoutCaptions([a], [{ startSec: 13, endSec: 15 }]);
    expect(out[0]!.endSec).toBe(13);
  });

  test('after_previous starts at the latest caption ending before timeSec (existing + new)', () => {
    const a = cap(10, '짧다'); // 10..11.5
    const b = cap(20, '뒤에', {}, 'after_previous');
    const out = layoutCaptions([a, b], [{ startSec: 3, endSec: 6 }]);
    expect(out.find((c) => c.orderId === b.id)!.startSec).toBeCloseTo(11.5, 6);
  });

  test('after_previous uses existing captions too', () => {
    const b = cap(20, '뒤에', {}, 'after_previous');
    const out = layoutCaptions([b], [{ startSec: 15, endSec: 17 }, { startSec: 25, endSec: 27 }]);
    expect(out[0]!.startSec).toBe(17);
  });

  test('after_previous with nothing before falls back to timeSec', () => {
    const b = cap(20, '뒤에', {}, 'after_previous');
    expect(layoutCaptions([b], [])[0]!.startSec).toBe(20);
  });

  test('unchecked, payload-less, null-time and zoom orders are excluded', () => {
    const out = layoutCaptions([
      cap(1, 'a', { checked: false }),
      cap(2, 'b', { payload: null }),
      cap(null, 'c'),
      cap(4, 'd', { payload: { kind: 'zoom', scale: 120, anchor: 'center', holdSec: 2 } }),
      cap(5, 'keep'),
    ], []);
    expect(out.map((c) => c.text)).toEqual(['keep']);
  });

  test('a new caption does not start inside an existing caption', () => {
    const a = cap(10, '짧다');
    const out = layoutCaptions([a], [{ startSec: 9, endSec: 10.8 }]);
    expect(out[0]!.startSec).toBeCloseTo(10.8, 6);
  });
});

describe('zoomKeyframes', () => {
  test('center: 4 keys at in/hold/out', () => {
    const k = zoomKeyframes(10, 120, 2, 'center');
    expect(k.map((x) => +x.time.toFixed(4))).toEqual([10, 10.3, 12.3, 12.6]);
    expect(k.map((x) => x.scale)).toEqual([100, 120, 120, 100]);
    for (const x of k) expect(x.position).toEqual([0.5, 0.5]);
  });

  test('bottom_right keeps its anchor point in place', () => {
    const k = zoomKeyframes(10, 120, 2, 'bottom_right');
    expect(k[0]!.position).toEqual([0.5, 0.5]);
    expect(k[3]!.position).toEqual([0.5, 0.5]);
    for (const i of [1, 2]) {
      expect(k[i]!.position[0]).toBeCloseTo(0.4333, 4);
      expect(k[i]!.position[1]).toBeCloseTo(0.4333, 4);
    }
  });

  test('top_left moves the frame the other way', () => {
    const k = zoomKeyframes(0, 120, 2, 'top_left');
    expect(k[1]!.position[0]).toBeCloseTo(0.5667, 4);
    expect(k[1]!.position[1]).toBeCloseTo(0.5667, 4);
  });
});

describe('rebaseZoom (zoom relative to the clip\'s own scale/position)', () => {
  const { rebaseZoom } = require('../../voiceOrders/timing.js');
  test('identity when the clip is at 100% and centred', () => {
    const k = zoomKeyframes(10, 120, 2, 'bottom_right');
    expect(rebaseZoom(k, { scale: 100, position: [0.5, 0.5] })).toEqual(k);
  });
  test('a clip fitted at 66.7% rests at 66.7% and peaks at 66.7×1.2', () => {
    const r = rebaseZoom(zoomKeyframes(10, 120, 2, 'center'), { scale: 66.7, position: [0.5, 0.5] });
    expect(r.map((x: any) => +x.scale.toFixed(2))).toEqual([66.7, 80.04, 80.04, 66.7]);
    expect(r[0].position).toEqual([0.5, 0.5]);
  });
  test('a reframed clip keeps its position at rest; the anchor point stays fixed at the peak', () => {
    const r = rebaseZoom(zoomKeyframes(10, 150, 2, 'top_left'), { scale: 100, position: [0.6, 0.4] });
    expect(r[0].position).toEqual([0.6, 0.4]);
    expect(r[3].position).toEqual([0.6, 0.4]);
    // anchor (1/6,1/6) fixed: p' = A + (p0 - A) * 1.5
    expect(r[1].position[0]).toBeCloseTo(1 / 6 + (0.6 - 1 / 6) * 1.5, 6);
    expect(r[1].position[1]).toBeCloseTo(1 / 6 + (0.4 - 1 / 6) * 1.5, 6);
  });
});
