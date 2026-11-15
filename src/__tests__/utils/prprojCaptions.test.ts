import { decodeCaptionText, readCaptionsFromProjectXml, TICKS_PER_SECOND, DATA_TRACK_MEDIA_TYPE } from '../../utils/prprojCaptions.js';

const TPF = 8475667200; // 29.97fps

/** Minimal FlatBuffer-like payload: [len][bytes][0] for each string, like Premiere's caption blob. */
function blob(...strings: string[]): string {
  const parts: Buffer[] = [Buffer.alloc(8, 1)];
  for (const s of strings) {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4); len.writeUInt32LE(b.length);
    parts.push(len, b, Buffer.from([0]), Buffer.alloc(3, 7));
  }
  return Buffer.concat(parts).toString('base64');
}

function item(id: number, startF: number, endF: number, block: number): string {
  return `<CaptionDataClipTrackItem ObjectID="${id}" ClassID="x" Version="3"><DataClipTrackItem Version="1"><ClipTrackItem Version="8">
    <TrackItem Version="4"><Start>${startF * TPF}</Start><End>${endF * TPF}</End></TrackItem></ClipTrackItem></DataClipTrackItem>
    <BlockVector Version="1"><BlockVectorItem Index="0" ObjectRef="${block}"/></BlockVector></CaptionDataClipTrackItem>`;
}

const xml = `<PremiereData>
<Sequence ObjectUID="seq-1" ClassID="x" Version="12"><TrackGroups Version="1">
  <TrackGroup Version="1" Index="0"><First>video-type</First><Second ObjectRef="10"/></TrackGroup>
  <TrackGroup Version="1" Index="2"><First>${DATA_TRACK_MEDIA_TYPE}</First><Second ObjectRef="20"/></TrackGroup>
</TrackGroups><Name>Cut A</Name><Sequence ObjectURef="other"/></Sequence>
<Sequence ObjectUID="seq-empty" ClassID="x" Version="12"><TrackGroups Version="1">
  <TrackGroup Version="1" Index="0"><First>video-type</First><Second ObjectRef="10"/></TrackGroup>
</TrackGroups><Name>No captions</Name></Sequence>
<DataTrackGroup ObjectID="20" ClassID="x" Version="1"><TrackGroup Version="1"><Tracks Version="1">
  <Track Index="0" ObjectURef="trk-1"/></Tracks><FrameRate>${TPF}</FrameRate></TrackGroup></DataTrackGroup>
<CaptionDataClipTrack ObjectUID="trk-1" ClassID="x" Version="1"><Track Version="4"><ID>1</ID></Track>
  <ClipItems Version="3"><TrackItems Version="1">
    <TrackItem Index="0" ObjectRef="101"/><TrackItem Index="1" ObjectRef="102"/><TrackItem Index="2" ObjectRef="103"/>
  </TrackItems></ClipItems></CaptionDataClipTrack>
${item(101, 67, 175, 201)}
${item(102, 175, 210, 202)}
${item(103, 210, 299, 203)}
<Block ObjectID="201" ClassID="x" Version="1"><FormattedTextData Encoding="base64" BinaryHash="h1">${blob('AnimationType', 'LucidaConsole', '복코 수술은 무조건')}</FormattedTextData></Block>
<Block ObjectID="202" ClassID="x" Version="1"><FormattedTextData Encoding="base64" BinaryHash="h2">${blob('AnimationType', 'LucidaConsole', '맞는 건가요?')}</FormattedTextData></Block>
<Block ObjectID="203" ClassID="x" Version="1"><FormattedTextData Encoding="base64" BinaryHash="h1"/></Block>
</PremiereData>`;

describe('prprojCaptions', () => {
  it('decodes the caption text as the last length-prefixed string', () => {
    expect(decodeCaptionText(blob('AnimationType', 'GmarketSansTTFMedium', '그렇게 하면...'))).toBe('그렇게 하면...');
  });

  it('reads caption clips of the requested sequence with frame-exact times and text', () => {
    const r = readCaptionsFromProjectXml(xml, 'seq-1');
    expect(r.sequenceFound).toBe(true);
    expect(r.sequenceName).toBe('Cut A');
    expect(r.ticksPerFrame).toBe(TPF);
    expect(r.trackCount).toBe(1);
    expect(r.captions.map(c => [c.startFrame, c.endFrame])).toEqual([[67, 175], [175, 210], [210, 299]]);
    expect(r.captions[0].start).toBeCloseTo((67 * TPF) / TICKS_PER_SECOND, 9);
    // block 203 shares hash h1 with block 201 and carries no payload of its own
    expect(r.captions.map(c => c.text)).toEqual(['복코 수술은 무조건', '맞는 건가요?', '복코 수술은 무조건']);
    expect(r.textAvailable).toBe(true);
  });

  it('distinguishes "sequence has no caption track" from "sequence not in file"', () => {
    const none = readCaptionsFromProjectXml(xml, 'seq-empty');
    expect(none).toMatchObject({ sequenceFound: true, trackCount: 0, captions: [] });
    expect(readCaptionsFromProjectXml(xml, 'missing').sequenceFound).toBe(false);
  });
});
