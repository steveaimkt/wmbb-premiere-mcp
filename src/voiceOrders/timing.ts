/** Pure timing math for voice orders: caption placement and zoom keyframes. */
import type { Anchor, VoiceOrder } from './types.js';

export const MIN_CAPTION_SEC = 1.5;
export const MAX_CAPTION_SEC = 5;
export const ZOOM_RAMP_SEC = 0.3;

export function captionDurationSec(text: string): number {
  const d = 0.8 + 0.12 * [...text].length;
  return Math.min(MAX_CAPTION_SEC, Math.max(MIN_CAPTION_SEC, d));
}

export interface PlacedCaption { orderId: string; startSec: number; endSec: number; text: string }
type Span = { startSec: number; endSec: number };

/**
 * Lay out checked caption orders in time order.
 * - Same spot or too close to trim: the earlier caption keeps its length and
 *   the next one starts at its end (never stacked on one track).
 * - Otherwise the earlier caption is cut to end where the next one starts.
 * - "after_previous" starts at the end of the latest caption (existing or new)
 *   that ends at or before the order's time; with none, at the order's time.
 */
export function layoutCaptions(orders: VoiceOrder[], existing: Span[]): PlacedCaption[] {
  const eligible = orders
    .filter((o) => o.checked && o.timeSec !== null && o.payload?.kind === 'caption')
    .sort((a, b) => (a.timeSec! - b.timeSec!) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  const placed: PlacedCaption[] = [];
  for (const o of eligible) {
    const p = o.payload as Extract<NonNullable<VoiceOrder['payload']>, { kind: 'caption' }>;
    const t = o.timeSec!;
    let start = t;
    if (p.placement === 'after_previous') {
      const ends = [...existing, ...placed].map((s) => s.endSec).filter((e) => e <= t);
      if (ends.length) start = Math.max(...ends);
    }

    const prev = placed[placed.length - 1];
    if (prev && prev.endSec > start) {
      if (start - prev.startSec >= MIN_CAPTION_SEC) prev.endSec = start;
      else start = prev.endSec;
    }

    // Never start inside an existing caption.
    for (let moved = true; moved;) {
      moved = false;
      for (const s of existing) {
        if (s.startSec <= start && start < s.endSec) { start = s.endSec; moved = true; }
      }
    }

    let end = start + captionDurationSec(p.text);
    const nextExisting = existing.filter((s) => s.startSec > start).map((s) => s.startSec);
    if (nextExisting.length) {
      const limit = Math.min(...nextExisting);
      if (limit < end && limit - start >= MIN_CAPTION_SEC) end = limit;
    }
    placed.push({ orderId: o.id, startSec: start, endSec: end, text: p.text });
  }
  return placed;
}

const ANCHOR_POINT: Record<Anchor, [number, number]> = {
  top_left: [1 / 6, 1 / 6], top: [0.5, 1 / 6], top_right: [5 / 6, 1 / 6],
  left: [1 / 6, 0.5], center: [0.5, 0.5], right: [5 / 6, 0.5],
  bottom_left: [1 / 6, 5 / 6], bottom: [0.5, 5 / 6], bottom_right: [5 / 6, 5 / 6],
};

export interface ZoomKey { time: number; scale: number; position: [number, number] }

/** Four keys (sequence time): ramp in, hold, ramp out. Position is normalized 0..1. */
export function zoomKeyframes(startSec: number, scale: number, holdSec: number, anchor: Anchor): ZoomKey[] {
  const [ax, ay] = ANCHOR_POINT[anchor];
  const k = scale / 100 - 1;
  const zoomed: [number, number] = [0.5 + (0.5 - ax) * k, 0.5 + (0.5 - ay) * k];
  const rest: [number, number] = [0.5, 0.5];
  const t1 = startSec + ZOOM_RAMP_SEC;
  const t2 = t1 + holdSec;
  return [
    { time: startSec, scale: 100, position: rest },
    { time: t1, scale, position: zoomed },
    { time: t2, scale, position: zoomed },
    { time: t2 + ZOOM_RAMP_SEC, scale: 100, position: rest },
  ];
}

/**
 * Re-express zoom keys (built for a clip at 100%, centred) relative to the clip's own framing:
 * rest keys take the clip's scale/position, peak keys scale it by the same factor about the same
 * frame anchor. Otherwise the first/last keys would hold 100%/centre over the whole clip.
 */
export function rebaseZoom(keys: ZoomKey[], base: { scale: number; position: [number, number] }): ZoomKey[] {
  return keys.map((k) => {
    const f = k.scale / 100;
    if (Math.abs(f - 1) < 1e-9) return { time: k.time, scale: base.scale, position: [base.position[0], base.position[1]] as [number, number] };
    // k.position = A + (0.5 - A) * f  →  anchor A per axis
    const anchor = (p: number) => (p - 0.5 * f) / (1 - f);
    const ax = anchor(k.position[0]), ay = anchor(k.position[1]);
    return {
      time: k.time,
      scale: base.scale * f,
      position: [ax + (base.position[0] - ax) * f, ay + (base.position[1] - ay) * f] as [number, number],
    };
  });
}
