/**
 * Caption building and export.
 *
 * Whisper segments are shaped by where the speaker paused, not by what reads
 * well on screen — a single segment is regularly a 40-character run that no one
 * can read in the 1.2 seconds it is up. This module re-cuts segments into cues
 * that obey readable-subtitle limits, using the word timestamps so the split
 * times stay true to the audio, then serializes them to SRT / WebVTT / plain
 * text.
 *
 * Pairs with proofread.ts: proofread fixes WHAT the words are, this decides HOW
 * they are laid out in time.
 */

import { WhisperSegment, WhisperWord } from './whisperRunner.js';

export interface Cue {
  index: number;
  start: number;
  end: number;
  /** Display text, already wrapped to at most `maxLines` lines. */
  text: string;
  lines: string[];
}

export interface CaptionOptions {
  /** Hard limit per displayed line. Korean broadcast practice is ~16-20. */
  maxCharsPerLine: number;
  /** Lines allowed per cue before a new cue is started. */
  maxLines: number;
  /** A cue is split once it would run longer than this. */
  maxDurationSec: number;
  /** Cues shorter than this are stretched (never past the next cue's start). */
  minDurationSec: number;
  /** Gap forced between neighbouring cues so they do not visually collide. */
  gapSec: number;
  /** Hangul-to-written-form replacements applied to each cue, e.g.
   *  "에이피아이" -> "API". Merged over DEFAULT_GLOSSARY. */
  glossary: Record<string, string>;
  /** A pause longer than this starts a new cue. Without it a cue can span a
   *  long silence, leaving one subtitle parked on screen across the gap and
   *  joining two thoughts the speaker clearly separated. */
  maxGapSec: number;
}

/**
 * Whisper transcribes Korean speech phonetically, so terms that are written in
 * Latin script come back spelled out in Hangul — "API" is heard and written as
 * "에이피아이". Captions need the written form back.
 *
 * Longest-first replacement, so "에이피아이" is consumed before a shorter entry
 * could match part of it.
 */
export const DEFAULT_GLOSSARY: Record<string, string> = {
  '에이피아이': 'API',
  '엠씨피': 'MCP',
  '유아이': 'UI',
  '유엑스': 'UX',
  '에이아이': 'AI',
  '에스알티': 'SRT',
  '유알엘': 'URL',
  '제이슨': 'JSON',
  '깃허브': 'GitHub',
  '깃헙': 'GitHub',
  '파이썬': 'Python',
  '자바스크립트': 'JavaScript',
  '타입스크립트': 'TypeScript',
  '노드제이에스': 'Node.js',
  '클로드': 'Claude',
  '앤트로픽': 'Anthropic',
  '챗지피티': 'ChatGPT',
  '지피티': 'GPT',
  '유튜브': 'YouTube',
  '노션': 'Notion',
  '피그마': 'Figma',
  '프리미어': 'Premiere',
  '포토샵': 'Photoshop',
  '어도비': 'Adobe',
  '엑셀': 'Excel',
  '슬랙': 'Slack',
};

export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = {
  maxCharsPerLine: 20,
  maxLines: 2,
  maxDurationSec: 6,
  minDurationSec: 1,
  gapSec: 0.04,
  maxGapSec: 1,
  glossary: DEFAULT_GLOSSARY,
};

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Words carry the timing, so prefer them. Segments without word-level data
 *  fall back to one pseudo-word spanning the whole segment. */
function wordsOf(seg: WhisperSegment): WhisperWord[] {
  if (seg.words && seg.words.length) return seg.words;
  return [{ word: seg.text.trim(), start: seg.start, end: seg.end }];
}


/** Apply a Hangul-to-written-form glossary to a line of caption text. */
export function applyGlossary(text: string, glossary: Record<string, string>): string {
  const keys = Object.keys(glossary).filter(Boolean).sort((a, b) => b.length - a.length);
  let out = text;
  for (const k of keys) {
    const replacement = glossary[k];
    if (replacement === undefined) continue;
    out = out.split(k).join(replacement);
  }
  return out;
}

/** Break a token that is itself longer than the line limit. Korean compounds
 *  routinely run past it with no space to break on. */
function hardSplit(token: string, limit: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < token.length; i += limit) parts.push(token.slice(i, i + limit));
  return parts;
}

/**
 * Wrap to at most `maxLines`, then even the lines out.
 *
 * A greedy wrap fills line 1 to the limit and leaves whatever is left on line 2,
 * which is how you end up with a full line above a single dangling syllable.
 * For the two-line case the split point is instead chosen to minimise the
 * difference between the two lines, which is what Korean subtitle practice
 * calls for and what reads better at speed.
 */
function wrap(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const tokens = text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((t) => (t.length > maxCharsPerLine ? hardSplit(t, maxCharsPerLine) : [t]));

  if (!tokens.length) return [text.trim()];

  // Balanced two-line split: try every word boundary, keep the most even one
  // that fits.
  if (maxLines === 2) {
    const whole = tokens.join(' ');
    if (whole.length <= maxCharsPerLine) return [whole];

    let best: { lines: string[]; diff: number } | null = null;
    for (let i = 1; i < tokens.length; i++) {
      const a = tokens.slice(0, i).join(' ');
      const b = tokens.slice(i).join(' ');
      if (a.length > maxCharsPerLine || b.length > maxCharsPerLine) continue;
      const diff = Math.abs(a.length - b.length);
      if (!best || diff < best.diff) best = { lines: [a, b], diff };
    }
    if (best) return best.lines;
    // Nothing fits in two lines; fall through to the greedy path and let the
    // caller's character budget split the cue instead.
  }

  const lines: string[] = [];
  let cur = '';
  for (const tok of tokens) {
    const candidate = cur ? `${cur} ${tok}` : tok;
    if (candidate.length <= maxCharsPerLine || !cur) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = tok;
      if (lines.length >= maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.length ? lines : [text.trim()];
}

/**
 * Re-cut Whisper segments into readable cues.
 *
 * A cue is closed when adding the next word would break the character budget
 * (maxCharsPerLine * maxLines) or the duration budget, or when the speaker
 * clearly finished a sentence.
 */
export function buildCues(
  segments: WhisperSegment[],
  options: Partial<CaptionOptions> = {},
): Cue[] {
  const opt: CaptionOptions = { ...DEFAULT_CAPTION_OPTIONS, ...options };
  // Caller entries win, but the defaults stay in place unless overridden by key.
  const glossary = { ...DEFAULT_GLOSSARY, ...(options.glossary ?? {}) };
  const charBudget = Math.max(1, opt.maxCharsPerLine * opt.maxLines);

  const cues: Cue[] = [];
  let buf: WhisperWord[] = [];

  const flush = () => {
    if (!buf.length) return;
    const first = buf[0]!;
    const last = buf[buf.length - 1]!;
    const raw = buf.map((w) => w.word.trim()).join(' ').replace(/\s+/g, ' ').trim();
    const text = applyGlossary(raw, glossary);
    if (!text) { buf = []; return; }
    cues.push({
      index: cues.length + 1,
      start: round(first.start),
      end: round(last.end),
      text,
      lines: wrap(text, opt.maxCharsPerLine, opt.maxLines),
    });
    buf = [];
  };

  for (const seg of segments) {
    for (const w of wordsOf(seg)) {
      const wordText = w.word.trim();
      if (!wordText) continue;

      const pendingText = buf.map((x) => x.word.trim()).join(' ');
      const wouldBeChars = (pendingText ? pendingText.length + 1 : 0) + wordText.length;
      const wouldBeDur = buf.length ? w.end - buf[0]!.start : w.end - w.start;
      const gapBefore = buf.length ? w.start - buf[buf.length - 1]!.end : 0;

      if (buf.length && (wouldBeChars > charBudget || wouldBeDur > opt.maxDurationSec || gapBefore > opt.maxGapSec)) {
        flush();
      }
      buf.push(w);

      // Sentence-final punctuation is a natural cue boundary.
      if (/[.!?。！？…]$/.test(wordText)) flush();
    }
  }
  flush();

  // Enforce minimum on-screen time without letting a cue run into the next one.
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    if (cue.end - cue.start >= opt.minDurationSec) continue;
    const next = cues[i + 1];
    const wanted = cue.start + opt.minDurationSec;
    cue.end = round(next ? Math.min(wanted, next.start - opt.gapSec) : wanted);
    if (cue.end <= cue.start) cue.end = round(cue.start + 0.2); // degenerate, keep it visible
  }

  return cues;
}

function pad(n: number, width = 2): string {
  return String(Math.floor(n)).padStart(width, '0');
}

/** seconds -> "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" (VTT) */
function stamp(seconds: number, msSeparator: ',' | '.'): string {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSeparator}${pad(ms, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.lines.join('\n')}\n`)
    .join('\n');
}

export function toVtt(cues: Cue[]): string {
  const body = cues
    .map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.lines.join('\n')}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** "(M:SS) text" per cue — the review-friendly format, easy to skim next to a script. */
export function toTxt(cues: Cue[]): string {
  return cues
    .map((c) => {
      const m = Math.floor(c.start / 60);
      const s = Math.floor(c.start % 60);
      return `(${m}:${String(s).padStart(2, '0')}) ${c.text}`;
    })
    .join('\n');
}

export function serializeCues(cues: Cue[], format: 'srt' | 'vtt' | 'txt'): string {
  if (format === 'vtt') return toVtt(cues);
  if (format === 'txt') return toTxt(cues);
  return toSrt(cues);
}
