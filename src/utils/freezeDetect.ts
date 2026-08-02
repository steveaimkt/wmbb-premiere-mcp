/**
 * Freeze detection over a time span, to tell a live on-screen demo from dead air.
 *
 * A silent stretch in a screen recording is ambiguous from the audio alone: it
 * can be the speaker demonstrating something on screen ("실행해볼게요" then a
 * silent action) — which must NOT be cut — or a frozen screen with nothing
 * happening — which is safe to cut. This module answers that visually.
 *
 * It runs ffmpeg's `freezedetect` filter over the span. That filter reports the
 * intervals where the picture stays below a motion floor. The tell is the
 * LONGEST single freeze as a fraction of the span:
 *
 *   longest freeze ≈ span   : one dominant solid freeze = static/dead air → safe to cut
 *   longest freeze ≪ span   : no dominant freeze, motion throughout = live demo → keep
 *
 * Longest-freeze, not total coverage, is the right metric: an install-wait screen
 * is ~85% frozen in ONE block, while an active demo can still be 75% "frozen" in
 * total yet broken into a dozen short stills with motion between — coverage can't
 * tell those apart, the longest block can.
 *
 * Validated on real footage (2026-07-24): a 60s install-wait span = one 50.6s
 * freeze (longest 0.84 → static); a 29s active-demo span = fragmented
 * 13.8/1.9/0.65/4.6s freezes (longest 0.48 → active); a 5s title card = frozen
 * the whole span (longest 1.0 → static).
 *
 * ffmpeg only prints `freeze_duration` when a freeze ENDS, so a span that is
 * frozen straight through emits a `freeze_start` with no duration. That dangling
 * start is treated as a freeze running to the span end — otherwise a fully static
 * screen would read, wrongly, as having no freeze at all.
 *
 * No Premiere needed — operates on any media file, so it can run on the source
 * media or on a rendered sequence-audio+video export.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

export type ScreenState = 'static' | 'active' | 'ambiguous';

export interface FreezeVerdict {
  start: number;
  end: number;
  /** Longest single freeze as a fraction of the span (0..1) — the classifier's input. */
  longestFreezeFraction: number;
  /** Total frozen time / span (0..1), for context. */
  freezeCoverage: number;
  /** Number of distinct freeze intervals — one dominant reads static, many reads active. */
  freezeSegments: number;
  screenState: ScreenState;
  error?: string;
}

export interface FreezeOptions {
  /** Motion tolerance, 0..1 ratio (ffmpeg `noise`). Default 0.004 — above raw
   *  video-noise/anti-alias jitter on a static card, below real UI motion. */
  noise?: number;
  /** Shortest freeze ffmpeg will report, seconds (`duration`). Default 0.5. */
  minFreezeSec?: number;
  /** longest-freeze fraction ≥ this → static (safe to cut). Default 0.8. */
  staticFraction?: number;
  /** longest-freeze fraction ≤ this → active (protect). Default 0.5. Between → ambiguous. */
  activeFraction?: number;
}

export interface FreezeIntervals {
  /** Every freeze interval length in seconds, including a dangling one to span end. */
  durations: number[];
  totalFrozen: number;
  longestFreeze: number;
}

function run(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/**
 * Turn ffmpeg freezedetect stderr into freeze interval lengths.
 *
 * `freeze_duration` is only printed when a freeze ENDS. If there are more
 * `freeze_start` markers than durations, the last freeze never ended inside the
 * span — it ran to the end — so we add (span − lastStart) as its length. Without
 * this a screen frozen straight through would parse as zero freeze.
 *
 * @param span Span length in seconds (ffmpeg timestamps are 0-based within the
 *             -ss/-to window, so the trailing freeze runs from lastStart to span).
 */
export function parseFreezeIntervals(stderr: string, span: number): FreezeIntervals {
  const durations: number[] = [];
  const starts: number[] = [];
  for (const line of stderr.split('\n')) {
    let m = /freeze_duration:\s*([0-9.]+)/.exec(line);
    if (m) { const v = parseFloat(m[1]!); if (!Number.isNaN(v)) durations.push(v); continue; }
    m = /freeze_start:\s*([0-9.]+)/.exec(line);
    if (m) { const v = parseFloat(m[1]!); if (!Number.isNaN(v)) starts.push(v); }
  }
  // Dangling freeze: one more start than completed durations → frozen to span end.
  if (starts.length > durations.length && starts.length > 0) {
    const lastStart = starts[starts.length - 1]!;
    const tail = Math.max(0, span - lastStart);
    if (tail > 0.01) durations.push(tail);
  }
  const totalFrozen = durations.reduce((a, d) => a + d, 0);
  const longestFreeze = durations.length ? Math.max(...durations) : 0;
  return { durations, totalFrozen, longestFreeze };
}

/** Classify a span's screen by its longest single freeze as a fraction of the span. */
export function classifyByLongestFreeze(
  longestFraction: number,
  staticFraction: number,
  activeFraction: number,
): ScreenState {
  if (longestFraction >= staticFraction) return 'static';
  if (longestFraction <= activeFraction) return 'active';
  return 'ambiguous';
}

/**
 * Inspect one span of a media file and decide static vs active.
 *
 * @param file  Absolute path to the media file (source or rendered sequence).
 * @param start Span start, seconds.
 * @param end   Span end, seconds.
 */
export async function detectFreeze(
  file: string,
  start: number,
  end: number,
  opts: FreezeOptions = {},
): Promise<FreezeVerdict> {
  const span = Math.max(0, end - start);
  const base: FreezeVerdict = { start, end, longestFreezeFraction: 0, freezeCoverage: 0, freezeSegments: 0, screenState: 'ambiguous' };

  if (!file) return { ...base, error: 'file path is required' };
  if (!existsSync(file)) return { ...base, error: `file not found: ${file}` };
  if (span <= 0.01) return { ...base, error: 'span is empty' };

  const noise = opts.noise ?? 0.004;
  const minFreeze = opts.minFreezeSec ?? 0.5;
  const staticFraction = opts.staticFraction ?? 0.8;
  const activeFraction = opts.activeFraction ?? 0.5;

  const args = [
    '-hide_banner', '-nostats',
    '-ss', String(start), '-to', String(end),
    '-i', file,
    '-vf', `freezedetect=noise=${noise}:duration=${minFreeze}`,
    '-an', '-f', 'null', '-',
  ];

  let stderr: string;
  try {
    ({ stderr } = await run(FFMPEG_BIN, args));
  } catch (e: any) {
    return { ...base, error: `ffmpeg failed: ${e?.message || e}. Set FFMPEG_PATH if ffmpeg is not on PATH.` };
  }

  const { durations, totalFrozen, longestFreeze } = parseFreezeIntervals(stderr, span);
  const longestFraction = Math.min(1, span > 0 ? longestFreeze / span : 0);
  const coverage = Math.min(1, span > 0 ? totalFrozen / span : 0);
  const screenState = classifyByLongestFreeze(longestFraction, staticFraction, activeFraction);

  return {
    start,
    end,
    longestFreezeFraction: Math.round(longestFraction * 1000) / 1000,
    freezeCoverage: Math.round(coverage * 1000) / 1000,
    freezeSegments: durations.length,
    screenState,
  };
}
