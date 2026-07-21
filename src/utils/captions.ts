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
  /** A pause longer than this starts a new cue. Without it a cue can span a
   *  long silence, leaving one subtitle parked on screen across the gap and
   *  joining two thoughts the speaker clearly separated. */
  maxGapSec: number;
}

export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = {
  maxCharsPerLine: 20,
  maxLines: 2,
  maxDurationSec: 6,
  minDurationSec: 1,
  gapSec: 0.04,
  maxGapSec: 1,
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

/** Greedy wrap that never exceeds maxCharsPerLine unless a single token is
 *  itself longer than the limit. */
function wrap(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
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
  const charBudget = Math.max(1, opt.maxCharsPerLine * opt.maxLines);

  const cues: Cue[] = [];
  let buf: WhisperWord[] = [];

  const flush = () => {
    if (!buf.length) return;
    const first = buf[0]!;
    const last = buf[buf.length - 1]!;
    const text = buf.map((w) => w.word.trim()).join(' ').replace(/\s+/g, ' ').trim();
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
