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
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_BIN = process.env.PYTHON_PATH || 'python3';

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

  const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [scriptPath(), file, '--model', model, '--language', language]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

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
  return { success: true, language: parsed.language, duration, segments };
}
