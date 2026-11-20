/**
 * Read caption tracks back out of a Premiere project file.
 *
 * ExtendScript can create a caption track (Sequence.createCaptionTrack) but has
 * no way to read one: caption tracks are not in sequence.videoTracks, there is
 * no getCaptionTracks(), and QE does not count them either (checked on 26.5.2).
 * The only re-readable record is the project itself, so add_caption_track exports
 * the sequence with Sequence.exportAsProject() and parses that file here.
 *
 * A .prproj is gzipped XML. Each caption track is a <CaptionDataClipTrack> and
 * each cue a <CaptionDataClipTrackItem> carrying <Start>/<End> in ticks. Cue text
 * and the track style live in base64 binary blobs, so only timing is read.
 */

import { gunzipSync } from 'zlib';

export const TICKS_PER_SECOND = 254016000000;

export interface CaptionCueTiming {
  start: number;
  end: number;
}

export interface ProjectCaptionSummary {
  trackCount: number;
  cues: CaptionCueTiming[];
}

/** Accepts the raw .prproj bytes (gzipped) or already-inflated XML. */
export function parseProjectCaptions(input: Buffer | string): ProjectCaptionSummary {
  let xml: string;
  if (typeof input === 'string') {
    xml = input;
  } else if (input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b) {
    xml = gunzipSync(input).toString('utf8');
  } else {
    xml = input.toString('utf8');
  }

  const trackCount = (xml.match(/<CaptionDataClipTrack\s/g) || []).length;

  const cues: CaptionCueTiming[] = [];
  const itemRe = /<CaptionDataClipTrackItem\b[\s\S]*?<\/CaptionDataClipTrackItem>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const start = /<Start>(\d+)<\/Start>/.exec(m[0]);
    const end = /<End>(\d+)<\/End>/.exec(m[0]);
    if (!start || !end) continue;
    cues.push({
      start: Number(start[1]) / TICKS_PER_SECOND,
      end: Number(end[1]) / TICKS_PER_SECOND,
    });
  }
  cues.sort((a, b) => a.start - b.start);
  return { trackCount, cues };
}

/**
 * Cues present in `after` but not in `before`, matched by timing. Used to tell
 * which cues a createCaptionTrack call added when the sequence already had some.
 */
export function newCues(before: CaptionCueTiming[], after: CaptionCueTiming[]): CaptionCueTiming[] {
  const key = (c: CaptionCueTiming) => `${c.start.toFixed(4)}-${c.end.toFixed(4)}`;
  const remaining = new Map<string, number>();
  for (const c of before) remaining.set(key(c), (remaining.get(key(c)) ?? 0) + 1);
  const added: CaptionCueTiming[] = [];
  for (const c of after) {
    const k = key(c);
    const n = remaining.get(k) ?? 0;
    if (n > 0) remaining.set(k, n - 1);
    else added.push(c);
  }
  return added;
}

/** Number of cues in an SRT body — the count add_caption_track expects to land. */
export function countSrtCues(srt: string): number {
  return (srt.replace(/^﻿/, '').match(/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/g) || []).length;
}
