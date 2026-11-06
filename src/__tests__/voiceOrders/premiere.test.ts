import { BridgePremierePort } from '../../voiceOrders/premiere.js';
import { DEFAULT_SETTINGS } from '../../voiceOrders/types.js';
import { zoomKeyframes } from '../../voiceOrders/timing.js';

function fakeTools(responses: Record<string, any>) {
  const calls: { name: string; args: any }[] = [];
  return {
    calls,
    tools: { executeTool: async (name: string, args: any) => { calls.push({ name, args }); return JSON.stringify(responses[name] ?? { success: true }); } } as any,
  };
}
const bridge = { executeScript: async () => '{}' } as any;
const settings = () => ({ ...DEFAULT_SETTINGS, captionTemplatePath: '/t.mogrt' });

describe('BridgePremierePort', () => {
  test('zoom looks up V1 in the given sequence and keys that clip in it', async () => {
    const f = fakeTools({ list_sequence_tracks: { success: true, videoTracks: [{ name: 'V1', clips: [{ id: 'c1', startTime: 0, endTime: 60 }] }] } });
    const p = new BridgePremierePort(bridge, f.tools, settings);
    const r = await p.zoom('seqA', 12, zoomKeyframes(12, 120, 2, 'center'));
    expect(r.ok).toBe(true);
    expect(f.calls[0]).toMatchObject({ name: 'list_sequence_tracks', args: { sequenceId: 'seqA' } });
    expect(f.calls[1]).toMatchObject({ name: 'set_clip_motion', args: { sequenceId: 'seqA', clipId: 'c1', timeBase: 'sequence' } });
  });

  test('marker colors match 26.5.2 indices: orange=3, green=0, unchecked=white(5) — 26.5.2 has no gray', async () => {
    const f = fakeTools({ set_marker: { success: true, markerId: 'm1' } });
    const p = new BridgePremierePort(bridge, f.tools, settings);
    const o = { id: 'o1', sequenceId: 'seqA', timeSec: 3, transcript: 't', payload: null, markerId: null } as any;
    await p.setMarker(o, 'orange');
    await p.setMarker(o, 'green');
    await p.setMarker(o, 'white');
    expect(f.calls.map((c) => c.args.colorIndex)).toEqual([3, 0, 5]);
  });

  test('zoom that runs past the end of the V1 clip is pulled back to end inside it', async () => {
    const f = fakeTools({ list_sequence_tracks: { success: true, videoTracks: [{ name: 'V1', clips: [{ id: 'c1', startTime: 126, endTime: 130 }] }] } });
    const p = new BridgePremierePort(bridge, f.tools, settings);
    const r = await p.zoom('seqA', 128, zoomKeyframes(128, 120, 2, 'center')); // would end at 130.6
    expect(r.ok).toBe(true);
    const times = f.calls[1].args.keyframes.map((k: any) => k.time);
    expect(times[0]).toBe(128);
    expect(times[3]).toBeLessThan(130);
    expect(times[3] - times[2]).toBeCloseTo(0.3, 5);
    expect(times[2]).toBeGreaterThan(times[1]);
  });

  test('zoom refuses when the clip ends too soon for both ramps', async () => {
    const f = fakeTools({ list_sequence_tracks: { success: true, videoTracks: [{ name: 'V1', clips: [{ id: 'c1', startTime: 126, endTime: 128.4 }] }] } });
    const p = new BridgePremierePort(bridge, f.tools, settings);
    const r = await p.zoom('seqA', 128, zoomKeyframes(128, 120, 2, 'center'));
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  test('placeCaption targets the given sequence', async () => {
    const f = fakeTools({});
    const p = new BridgePremierePort(bridge, f.tools, settings);
    await p.placeCaption('seqA', { orderId: 'o1234567890', startSec: 1, endSec: 2.5, text: 'A "q"\n\\ 😀' });
    expect(f.calls[0]).toMatchObject({ name: 'place_mogrt_text', args: { sequenceId: 'seqA', text: 'A "q"\n\\ 😀', templatePath: '/t.mogrt', trackName: 'AI 자막', clipName: 'A "q"\n\\ 😀' } });
  });

  test('placeCaption reports verify problems when the tool fails its re-read', async () => {
    const f = fakeTools({ place_mogrt_text: { success: false, verifyProblems: ['text reads ""'] } });
    const p = new BridgePremierePort(bridge, f.tools, settings);
    const r = await p.placeCaption('seqA', { orderId: 'o1', startSec: 1, endSec: 2, text: 'x' });
    expect(r).toEqual({ ok: false, error: 'text reads ""' });
  });
});
