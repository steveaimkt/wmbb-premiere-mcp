/**
 * Unit tests for reading caption tracks back out of a .prproj.
 *
 * The fixture mirrors what Premiere 26.5.2 wrote for a two-cue SRT placed with
 * Sequence.createCaptionTrack, trimmed to the elements the parser reads.
 */

import { gzipSync } from 'zlib';
import { parseProjectCaptions, newCues, countSrtCues } from '../../utils/prprojCaptions.js';

const XML = `
<PremiereData>
  <CaptionDataClipTrack ObjectUID="3a40" ClassID="b9d2" Version="1">
    <DataClipTrack Version="1"></DataClipTrack>
    <CaptionDataTemplateStyle Encoding="base64">cAEAAAAA</CaptionDataTemplateStyle>
  </CaptionDataClipTrack>
  <CaptionDataClipTrackItem ObjectID="1922" Version="3">
    <TrackItem Version="4"><Start>254270016000</Start><End>762810048000</End></TrackItem>
  </CaptionDataClipTrackItem>
  <CaptionDataClipTrackItem ObjectID="1923" Version="3">
    <TrackItem Version="4"><Start>1012842230400</Start><End>1648517270400</End></TrackItem>
  </CaptionDataClipTrackItem>
</PremiereData>`;

describe('parseProjectCaptions', () => {
  it('counts tracks and reads cue timing in seconds', () => {
    const r = parseProjectCaptions(XML);
    expect(r.trackCount).toBe(1);
    expect(r.cues).toHaveLength(2);
    expect(r.cues[0]!.start).toBeCloseTo(1.001, 3);
    expect(r.cues[0]!.end).toBeCloseTo(3.003, 3);
    expect(r.cues[1]!.start).toBeCloseTo(3.987, 3);
  });

  it('inflates a gzipped project', () => {
    const r = parseProjectCaptions(gzipSync(Buffer.from(XML, 'utf8')));
    expect(r.trackCount).toBe(1);
    expect(r.cues).toHaveLength(2);
  });

  it('returns zero for a project without captions', () => {
    const r = parseProjectCaptions('<PremiereData><VideoClip/></PremiereData>');
    expect(r).toEqual({ trackCount: 0, cues: [] });
  });
});

describe('newCues', () => {
  it('returns only the cues that were not there before', () => {
    const before = [{ start: 1, end: 2 }];
    const after = [{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 1, end: 2 }];
    expect(newCues(before, after)).toEqual([{ start: 3, end: 4 }, { start: 1, end: 2 }]);
  });
});

describe('countSrtCues', () => {
  it('counts timing lines, tolerating a BOM and dot separators', () => {
    const srt = '﻿1\n00:00:01,000 --> 00:00:03,000\n하나\n\n2\n00:00:04.000 --> 00:00:06.500\n둘\n';
    expect(countSrtCues(srt)).toBe(2);
  });
});
