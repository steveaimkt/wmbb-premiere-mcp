/**
 * Read caption clips placed on a sequence straight from the saved .prproj file.
 *
 * Why this exists: ExtendScript does not expose Premiere's modern caption tracks
 * (`sequence.getCaptionTracks` / `captionTracks` are absent on current builds), so a
 * sequence with a full caption track read back as "0 captions, success". The saved
 * project file does contain them, so this is the authority when the scripting API is blind.
 *
 * Project file layout (gzip-compressed XML), as observed on Premiere Beta 2026:
 *   <Sequence ObjectUID="{sequenceID}">
 *     <TrackGroups><TrackGroup><First>{media type}</First><Second ObjectRef="N"/>   ← data group = captions
 *   <DataTrackGroup ObjectID="N"> <FrameRate>{ticks per frame}</FrameRate>
 *     <Tracks><Track Index="i" ObjectURef="{track uid}"/>
 *   <CaptionDataClipTrack ObjectUID="{track uid}"> … <TrackItem Index="k" ObjectRef="M"/>
 *   <CaptionDataClipTrackItem ObjectID="M"> … <Start>ticks</Start><End>ticks</End>
 *     <BlockVectorItem Index="0" ObjectRef="B"/>
 *   <Block ObjectID="B"><FormattedTextData Encoding="base64" BinaryHash="H">…</FormattedTextData>
 * Blocks that share a BinaryHash carry the base64 payload only on the first occurrence.
 * The payload is a FlatBuffer; its length-prefixed strings are [style key, font name, caption text],
 * so the caption text is the last string.
 *
 * The file reflects the last save only — callers must say so.
 */

import { gunzipSync } from 'zlib';
import { readFileSync, statSync } from 'fs';

export const TICKS_PER_SECOND = 254016000000;
/** TrackGroups media type for data (caption) tracks. */
export const DATA_TRACK_MEDIA_TYPE = 'd8143ffe-eec4-4d2a-a909-d5f7bf094dc5';

export interface ProjectCaptionClip {
  trackIndex: number;
  start: number;
  end: number;
  startFrame: number | null;
  endFrame: number | null;
  text: string | null;
}

export interface ProjectCaptionRead {
  sequenceFound: boolean;
  sequenceName: string | null;
  ticksPerFrame: number | null;
  trackCount: number;
  captions: ProjectCaptionClip[];
  textAvailable: boolean;
}

/** Map ObjectID → offset of its opening tag, built once per document. */
function indexObjectIds(xml: string): Map<string, number> {
  const idx = new Map<string, number>();
  const re = /<\w+ ObjectID="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) idx.set(m[1]!, m.index);
  return idx;
}

function elementAt(xml: string, pos: number): string {
  const tag = /^<(\w+)/.exec(xml.slice(pos, pos + 200))?.[1];
  if (!tag) return '';
  const openEnd = xml.indexOf('>', pos);
  if (xml[openEnd - 1] === '/') return xml.slice(pos, openEnd + 1);
  const close = xml.indexOf(`</${tag}>`, openEnd);
  return close < 0 ? '' : xml.slice(pos, close + tag.length + 3);
}

function elementByUid(xml: string, tag: string, uid: string): string {
  const pos = xml.indexOf(`<${tag} ObjectUID="${uid}"`);
  return pos < 0 ? '' : elementAt(xml, pos);
}

/** Last length-prefixed UTF-8 string in a caption FlatBuffer payload = the caption text. */
export function decodeCaptionText(base64: string): string | null {
  const buf = Buffer.from(base64, 'base64');
  let last: string | null = null;
  for (let i = 0; i + 4 < buf.length; i++) {
    const n = buf.readUInt32LE(i);
    if (n === 0 || n > 4000 || i + 4 + n >= buf.length || buf[i + 4 + n] !== 0) continue;
    const s = buf.subarray(i + 4, i + 4 + n).toString('utf8');
    if (s.includes('�') || /[\x00-\x1f]/.test(s)) continue;
    last = s;
    i += 3 + n; // skip past this string
  }
  return last;
}

export function readCaptionsFromProjectXml(xml: string, sequenceId: string): ProjectCaptionRead {
  const empty: ProjectCaptionRead = {
    sequenceFound: false, sequenceName: null, ticksPerFrame: null, trackCount: 0, captions: [], textAvailable: false,
  };
  const seq = elementByUid(xml, 'Sequence', sequenceId);
  if (!seq) return empty;

  const groups = seq.slice(seq.indexOf('<TrackGroups'), seq.indexOf('</TrackGroups>'));
  const name = /<\/TrackGroups>\s*<Name>([^<]*)<\/Name>/.exec(seq)?.[1] ?? null;
  const dataRef = [...groups.matchAll(/<First>([^<]+)<\/First>\s*<Second ObjectRef="(\d+)"\/>/g)]
    .find(m => m[1] === DATA_TRACK_MEDIA_TYPE)?.[2];
  const result: ProjectCaptionRead = { ...empty, sequenceFound: true, sequenceName: name };
  if (!dataRef) return result;

  const ids = indexObjectIds(xml);
  const groupPos = ids.get(dataRef);
  if (groupPos === undefined) return result;
  const group = elementAt(xml, groupPos);
  const tpf = Number(/<FrameRate>(\d+)<\/FrameRate>/.exec(group)?.[1]) || null;
  result.ticksPerFrame = tpf;

  // base64 payloads by hash (only the first block with a given hash carries the data)
  const payload = new Map<string, string>();
  for (const m of xml.matchAll(/<FormattedTextData Encoding="base64" BinaryHash="([^"]+)">([^<]+)</g)) {
    if (!payload.has(m[1]!)) payload.set(m[1]!, m[2]!);
  }

  const trackUids = [...group.matchAll(/<Track Index="(\d+)" ObjectURef="([^"]+)"\/>/g)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map(m => m[2]!);
  let textMissing = 0;
  trackUids.forEach((uid, trackIndex) => {
    const track = elementByUid(xml, 'CaptionDataClipTrack', uid);
    if (!track) return;
    result.trackCount++;
    for (const ref of track.matchAll(/<TrackItem Index="\d+" ObjectRef="(\d+)"\/>/g)) {
      const pos = ids.get(ref[1]!);
      if (pos === undefined) continue;
      const item = elementAt(xml, pos);
      const s = Number(/<Start>(-?\d+)<\/Start>/.exec(item)?.[1]);
      const e = Number(/<End>(-?\d+)<\/End>/.exec(item)?.[1]);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      let text: string | null = null;
      const blockRef = /<BlockVectorItem Index="0" ObjectRef="(\d+)"\/>/.exec(item)?.[1];
      const blockPos = blockRef ? ids.get(blockRef) : undefined;
      if (blockPos !== undefined) {
        const hash = /BinaryHash="([^"]+)"/.exec(elementAt(xml, blockPos))?.[1];
        const b64 = hash ? payload.get(hash) : undefined;
        if (b64) text = decodeCaptionText(b64);
      }
      if (text === null) textMissing++;
      result.captions.push({
        trackIndex,
        start: s / TICKS_PER_SECOND,
        end: e / TICKS_PER_SECOND,
        startFrame: tpf ? s / tpf : null,
        endFrame: tpf ? e / tpf : null,
        text,
      });
    }
  });
  result.captions.sort((a, b) => a.trackIndex - b.trackIndex || a.start - b.start);
  result.textAvailable = result.captions.length > 0 && textMissing === 0;
  return result;
}

export function readCaptionsFromProjectFile(projectPath: string, sequenceId: string):
  ProjectCaptionRead & { projectFileSavedAt: string } {
  const raw = readFileSync(projectPath);
  const xml = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8');
  return {
    ...readCaptionsFromProjectXml(xml, sequenceId),
    projectFileSavedAt: statSync(projectPath).mtime.toISOString(),
  };
}
