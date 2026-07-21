/**
 * Audio-first edit-point analysis.
 *
 * Runs ffmpeg `silencedetect` on a media file (no Premiere required) and turns
 * the result into concrete edit data: silence regions, speech segments, and the
 * exact razor cut points needed to remove the silences.
 *
 * This is the core of the "analyze the audio first, then place cuts on real
 * data" workflow — Claude no longer has to guess timecodes.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';

export interface SilenceRegion {
  start: number;      // seconds
  end: number;        // seconds
  duration: number;   // seconds
}

export interface SpeechSegment {
  start: number;      // seconds
  end: number;        // seconds
  duration: number;   // seconds
}

export interface AudioEditAnalysis {
  success: boolean;
  file: string;
  hasAudio: boolean;
  duration: number;                 // full media duration in seconds
  params: {
    noiseThresholdDb: number;
    minSilenceSec: number;
    paddingSec: number;
  };
  silences: SilenceRegion[];
  speechSegments: SpeechSegment[];
  /**
   * Sorted razor times (seconds). Cutting the timeline at each of these, then
   * deleting the clips that fall inside a silence region, removes the silences.
   */
  cutPoints: number[];
  stats: {
    silenceCount: number;
    speechCount: number;
    totalSilenceSec: number;
    totalSpeechSec: number;
  };
  error?: string;
}

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

function run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function probeDuration(file: string): Promise<number> {
  try {
    const { stdout } = await run(FFPROBE_BIN, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Parse ffmpeg silencedetect stderr into silence regions.
 * Lines look like:
 *   [silencedetect @ 0x..] silence_start: 12.34
 *   [silencedetect @ 0x..] silence_end: 13.5 | silence_duration: 1.16
 */
function parseSilences(stderr: string, mediaDuration: number): SilenceRegion[] {
  const regions: SilenceRegion[] = [];
  let pendingStart: number | null = null;

  for (const line of stderr.split('\n')) {
    const startMatch = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (startMatch && startMatch[1] !== undefined) {
      pendingStart = parseFloat(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (endMatch && endMatch[1] !== undefined && pendingStart !== null) {
      const end = parseFloat(endMatch[1]);
      const start = Math.max(0, pendingStart);
      if (end > start) {
        regions.push({ start: round(start), end: round(end), duration: round(end - start) });
      }
      pendingStart = null;
    }
  }

  // A silence that runs to the very end of the file has no silence_end line.
  if (pendingStart !== null && mediaDuration > pendingStart) {
    const start = Math.max(0, pendingStart);
    regions.push({ start: round(start), end: round(mediaDuration), duration: round(mediaDuration - start) });
  }

  return regions;
}

/** Invert silence regions into speech segments, keeping `padding` seconds of the
 *  surrounding silence so speech is never clipped. */
function buildSpeechSegments(
  silences: SilenceRegion[],
  duration: number,
  padding: number,
): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  let cursor = 0;

  for (const s of silences) {
    const speechEnd = Math.min(duration, s.start + padding); // keep a little silence after speech
    if (speechEnd > cursor) {
      segments.push({ start: round(cursor), end: round(speechEnd), duration: round(speechEnd - cursor) });
    }
    cursor = Math.max(cursor, s.end - padding); // resume slightly before the next speech
  }

  if (duration - cursor > 0.01) {
    segments.push({ start: round(cursor), end: round(duration), duration: round(duration - cursor) });
  }

  return segments;
}

/**
 * Analyze a media file's audio and compute edit points based on silence.
 *
 * @param file             Absolute path to a media file (video or audio).
 * @param noiseThresholdDb Below this level (dB) counts as silence. Default -30.
 * @param minSilenceSec    Ignore silences shorter than this. Default 0.5.
 * @param paddingSec       Keep this much silence around speech so it stays natural. Default 0.1.
 */
export async function analyzeAudioEditPoints(
  file: string,
  noiseThresholdDb = -30,
  minSilenceSec = 0.5,
  paddingSec = 0.1,
): Promise<AudioEditAnalysis> {
  const base: AudioEditAnalysis = {
    success: false,
    file,
    hasAudio: false,
    duration: 0,
    params: { noiseThresholdDb, minSilenceSec, paddingSec },
    silences: [],
    speechSegments: [],
    cutPoints: [],
    stats: { silenceCount: 0, speechCount: 0, totalSilenceSec: 0, totalSpeechSec: 0 },
  };

  if (!file) {
    return { ...base, error: 'file path is required' };
  }
  if (!existsSync(file)) {
    return { ...base, error: `file not found: ${file}` };
  }

  const duration = await probeDuration(file);

  let stderr: string;
  try {
    const filter = `silencedetect=noise=${noiseThresholdDb}dB:d=${minSilenceSec}`;
    const res = await run(FFMPEG_BIN, ['-hide_banner', '-nostats', '-i', file, '-af', filter, '-f', 'null', '-']);
    stderr = res.stderr;
  } catch (e: any) {
    return { ...base, duration, error: `ffmpeg failed: ${e?.message || e}` };
  }

  const hasAudio = /Audio:/.test(stderr) || /silence_start/.test(stderr);
  if (!hasAudio) {
    return { ...base, duration, hasAudio: false, error: 'no audio stream detected in file' };
  }

  const silences = parseSilences(stderr, duration);
  const speechSegments = buildSpeechSegments(silences, duration, paddingSec);

  // Cut points = every speech-segment boundary that is not the media start/end.
  const cutSet = new Set<number>();
  for (const seg of speechSegments) {
    if (seg.start > 0.01) cutSet.add(round(seg.start));
    if (seg.end < duration - 0.01) cutSet.add(round(seg.end));
  }
  const cutPoints = Array.from(cutSet).sort((a, b) => a - b);

  const totalSilenceSec = round(silences.reduce((acc, s) => acc + s.duration, 0));
  const totalSpeechSec = round(speechSegments.reduce((acc, s) => acc + s.duration, 0));

  return {
    success: true,
    file,
    hasAudio: true,
    duration: round(duration),
    params: { noiseThresholdDb, minSilenceSec, paddingSec },
    silences,
    speechSegments,
    cutPoints,
    stats: {
      silenceCount: silences.length,
      speechCount: speechSegments.length,
      totalSilenceSec,
      totalSpeechSec,
    },
  };
}
