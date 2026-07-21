/**
 * Transcript proofreading (typo review) after Whisper transcription.
 *
 * Two complementary strategies:
 *
 *   1. Confidence flagging  — words below a probability threshold are likely
 *      misrecognitions (e.g. "크로도" @0.57 for "클로드"). Always available.
 *   2. Script-anchored fix  — when a reference script is provided, each
 *      transcript segment is matched to its closest script line; a close-but-
 *      not-equal match yields a deterministic correction (the script is ground
 *      truth). Highly accurate, no LLM guessing.
 *
 * Returns flagged suspects + corrections + a corrected transcript, so the caller
 * can build clean captions/subtitles.
 */

import { existsSync, readFileSync } from 'fs';
import { transcribeAudio, WhisperSegment } from './whisperRunner.js';

export interface SuspectWord {
  word: string;
  start: number;
  end: number;
  prob: number;
  segmentIndex: number;
}

export interface Correction {
  segmentIndex: number;
  start: number;
  end: number;
  heard: string;       // what Whisper produced
  suggested: string;   // closest script line
  similarity: number;
  /** Characters the suggestion would add (+) or drop (-) vs what was heard. */
  contentDelta: number;
  /** True when the fix was applied to correctedText. False = suggestion only,
   *  withheld because it would change the amount of spoken content. */
  applied: boolean;
}

export interface ProofreadResult {
  success: boolean;
  file: string;
  language?: string | undefined;
  duration: number;
  usedScript: boolean;
  params: {
    model: string;
    confidenceThreshold: number;
    correctionThreshold: number;
  };
  segments: WhisperSegment[];
  suspects: SuspectWord[];       // low-confidence words to eyeball
  corrections: Correction[];     // script-anchored fixes
  correctedText: string;         // full transcript after applying corrections
  stats: {
    segmentCount: number;
    suspectCount: number;
    correctionCount: number;
  };
  error?: string;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s.,!?…"'`~\-—()[\]{}·、。！？，]/g, '')
    .trim();
}

/** Dice coefficient over character bigrams (0..1). */
function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na.length || !nb.length) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) || 0) + 1);
    }
    return m;
  };
  const ma = bigrams(na);
  const mb = bigrams(nb);
  let overlap = 0;
  for (const [bg, countA] of ma) overlap += Math.min(countA, mb.get(bg) || 0);
  return (2 * overlap) / (na.length - 1 + (nb.length - 1));
}

/** Turn a reference script (may be markdown with directions) into plain
 *  narration lines: strip markdown, timecode markers, and non-spoken lines. */
function extractScriptLines(raw: string): string[] {
  const lines: string[] = [];
  for (let line of raw.split(/\r?\n/)) {
    line = line
      .replace(/`[^`]*`/g, ' ')          // inline code
      .replace(/[*_#>|]/g, ' ')          // markdown emphasis/heading/quote/table
      .replace(/\[[^\]]*\]/g, ' ')       // [TC markers] / [directions]
      .replace(/\([0-9:\-~\s]+\)/g, ' ') // (0:00-0:05) timecodes
      .replace(/^\s*[-–]\s*/, ' ')       // list bullets
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '') // stray quote marks
      .trim();
    if (!line) continue;
    // Drop lines that are clearly metadata, not narration.
    if (/^(주제|화면|자막|섹션|section|screen|tc|時|http)/i.test(line)) continue;
    // Split into sentence-ish units.
    for (const s of line.split(/(?<=[.!?。])\s+/)) {
      const t = s.trim();
      if (t.length >= 2) lines.push(t);
    }
  }
  return lines;
}

/** Find the best-matching script line for a heard segment. */
function bestMatch(heard: string, scriptLines: string[]): { line: string; sim: number } {
  let best = { line: '', sim: 0 };
  for (const line of scriptLines) {
    const sim = similarity(heard, line);
    if (sim > best.sim) best = { line, sim };
  }
  return best;
}

/**
 * Proofread a media file's transcript.
 *
 * @param file                Absolute path to a media file.
 * @param scriptPath          Optional path to a reference script (ground truth).
 * @param model               Whisper model size. Default 'base'.
 * @param language            Language code or 'auto'. Default 'ko'.
 * @param confidenceThreshold Words below this probability are flagged. Default 0.6.
 * @param correctionThreshold Min similarity to accept a script line as the fix. Default 0.6.
 */
export async function proofreadTranscript(
  file: string,
  scriptPath?: string,
  model = 'base',
  language = 'ko',
  confidenceThreshold = 0.6,
  correctionThreshold = 0.6,
): Promise<ProofreadResult> {
  const base: ProofreadResult = {
    success: false,
    file,
    duration: 0,
    usedScript: false,
    params: { model, confidenceThreshold, correctionThreshold },
    segments: [],
    suspects: [],
    corrections: [],
    correctedText: '',
    stats: { segmentCount: 0, suspectCount: 0, correctionCount: 0 },
  };

  if (!file) return { ...base, error: 'file path is required' };
  if (!existsSync(file)) return { ...base, error: `file not found: ${file}` };

  const transcription = await transcribeAudio(file, model, language);
  if (!transcription.success) {
    return { ...base, error: transcription.error || 'whisper transcription failed' };
  }
  const segments = transcription.segments;

  // 1. Confidence flagging.
  const suspects: SuspectWord[] = [];
  segments.forEach((seg, si) => {
    for (const w of seg.words || []) {
      if (w.prob !== undefined && w.prob < confidenceThreshold) {
        suspects.push({ word: w.word, start: w.start, end: w.end, prob: w.prob, segmentIndex: si });
      }
    }
  });

  // 2. Script-anchored correction.
  let usedScript = false;
  const corrections: Correction[] = [];
  let scriptLines: string[] = [];
  if (scriptPath) {
    if (!existsSync(scriptPath)) {
      return { ...base, segments, error: `script not found: ${scriptPath}` };
    }
    usedScript = true;
    scriptLines = extractScriptLines(readFileSync(scriptPath, 'utf-8'));
  }

  const correctedParts: string[] = [];
  segments.forEach((seg, si) => {
    let finalText = seg.text;
    if (usedScript && scriptLines.length) {
      const { line, sim } = bestMatch(seg.text, scriptLines);
      // Guard against truncating corrections: a script line much shorter than
      // what was heard would silently drop spoken content.
      const heardLen = normalize(seg.text).length;
      const lineLen = normalize(line).length;
      const lengthRatio = heardLen && lineLen ? Math.min(heardLen, lineLen) / Math.max(heardLen, lineLen) : 0;
      if (line && sim >= correctionThreshold && sim < 0.999 && lengthRatio >= 0.7) {
        // Only auto-apply when the two texts carry the same amount of content.
        // A shorter/longer script line means the segment spans a different unit,
        // so we surface it as a suggestion rather than silently dropping words.
        const applied = lengthRatio >= 0.9;
        corrections.push({
          segmentIndex: si,
          start: seg.start,
          end: seg.end,
          heard: seg.text,
          suggested: line,
          similarity: Math.round(sim * 1000) / 1000,
          contentDelta: lineLen - heardLen,
          applied,
        });
        if (applied) finalText = line; // script wins
      }
    }
    correctedParts.push(finalText);
  });

  return {
    success: true,
    file,
    language: transcription.language,
    duration: transcription.duration,
    usedScript,
    params: { model, confidenceThreshold, correctionThreshold },
    segments,
    suspects,
    corrections,
    correctedText: correctedParts.join(' '),
    stats: {
      segmentCount: segments.length,
      suspectCount: suspects.length,
      correctionCount: corrections.length,
    },
  };
}
