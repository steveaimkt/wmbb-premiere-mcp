/**
 * Shared Whisper transcription runner.
 *
 * Spawns scripts/whisper_transcribe.py (faster-whisper) and returns a parsed,
 * word-level transcription. Used by both the speech-edit-point analyzer and the
 * transcript proofreader so the transcription step lives in one place.
 *
 * The Python interpreter is `process.env.PYTHON_PATH || 'python3'`. When the MCP
 * server runs outside the shell that has faster-whisper installed, set
 * PYTHON_PATH to a Python that has it (e.g. a project .venv).
 */

import { spawn } from 'child_process';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_BIN = process.env.PYTHON_PATH || 'python3';

/** Whisper is the slowest step in the toolchain by a wide margin. Give it a
 *  ceiling so a wedged run cannot hang the MCP call forever. */
const TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS || 30 * 60 * 1000);

/** Transcribing a 20-minute take costs minutes. The edit-point analyzer, the
 *  proofreader and the caption exporter all want the SAME transcript of the
 *  SAME file, so without this every one of them pays that cost again. Cache is
 *  keyed on the file's identity (path + size + mtime) plus the decode settings,
 *  so re-exporting a media file invalidates it automatically. */
const CACHE_DIR = process.env.WHISPER_CACHE_DIR || join(tmpdir(), 'premiere-mcp-whisper-cache');
const CACHE_DISABLED = process.env.WHISPER_CACHE === '0';
const CACHE_MAX_ENTRIES = 50;

function cacheKey(file: string, model: string, language: string): string | null {
  try {
    const st = statSync(file);
    const raw = `${file}|${st.size}|${st.mtimeMs}|${model}|${language}`;
    return createHash('sha1').update(raw).digest('hex');
  } catch {
    return null;
  }
}

function cacheRead(key: string): Transcription | null {
  try {
    const hit = JSON.parse(readFileSync(join(CACHE_DIR, `${key}.json`), 'utf8'));
    return hit && hit.success ? hit : null;
  } catch {
    return null;
  }
}

function cacheWrite(key: string, value: Transcription): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify(value), 'utf8');
    pruneCache();
  } catch {
    // A cache that cannot be written is not an error worth failing the call for.
  }
}

/** Keep the newest CACHE_MAX_ENTRIES files; transcripts of long takes are large. */
function pruneCache(): void {
  try {
    const entries = readdirSync(CACHE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, m: statSync(join(CACHE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const stale of entries.slice(CACHE_MAX_ENTRIES)) {
      unlinkSync(join(CACHE_DIR, stale.f));
    }
  } catch {
    /* best effort */
  }
}

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
  prob?: number;
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  words?: WhisperWord[];
}

export interface Transcription {
  success: boolean;
  language?: string;
  duration: number;
  segments: WhisperSegment[];
  /** True when this came back from the transcript cache instead of a fresh run. */
  cached?: boolean;
  error?: string;
}

function scriptPath(): string {
  return join(__dirname, '..', '..', 'scripts', 'whisper_transcribe.py');
}

/**
 * Transcribe a media file to word-level segments via faster-whisper.
 *
 * @param file     Absolute path to a media file (video or audio).
 * @param model    Whisper model size. Default 'base'.
 * @param language Language code or 'auto'. Default 'ko'.
 */
export async function transcribeAudio(
  file: string,
  model = 'base',
  language = 'ko',
): Promise<Transcription> {
  if (!file) return { success: false, duration: 0, segments: [], error: 'file path is required' };
  if (!existsSync(file)) return { success: false, duration: 0, segments: [], error: `file not found: ${file}` };

  const key = CACHE_DISABLED ? null : cacheKey(file, model, language);
  if (key) {
    const hit = cacheRead(key);
    if (hit) return { ...hit, cached: true };
  }

  const out = await new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [scriptPath(), file, '--model', model, '--language', language]);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, TIMEOUT_MS);

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, timedOut }); });
  });

  if (out.timedOut) {
    return {
      success: false,
      duration: 0,
      segments: [],
      error: `whisper timed out after ${Math.round(TIMEOUT_MS / 1000)}s. Use a smaller --model (e.g. "base" or "tiny"), split the media, or raise WHISPER_TIMEOUT_MS.`,
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(out.stdout.trim());
  } catch {
    return {
      success: false,
      duration: 0,
      segments: [],
      error: `could not parse whisper output: ${out.stderr.slice(-300) || out.stdout.slice(-300)}`,
    };
  }
  if (!parsed.success) {
    return { success: false, duration: 0, segments: [], error: parsed.error || 'whisper transcription failed' };
  }

  const segments: WhisperSegment[] = parsed.segments || [];
  const duration = parsed.duration || (segments.length ? segments[segments.length - 1]!.end : 0);
  const result: Transcription = { success: true, language: parsed.language, duration, segments, cached: false };
  if (key) cacheWrite(key, result);
  return result;
}
