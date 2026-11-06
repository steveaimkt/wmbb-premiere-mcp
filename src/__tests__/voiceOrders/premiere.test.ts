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

  test('placeCaption targets the given sequence', async () => {
    const f = fakeTools({});
    const p = new BridgePremierePort(bridge, f.tools, settings);
    await p.placeCaption('seqA', { orderId: 'o1234567890', startSec: 1, endSec: 2.5, text: 'A "q"\n\\ 😀' });
    expect(f.calls[0]).toMatchObject({ name: 'place_mogrt_text', args: { sequenceId: 'seqA', text: 'A "q"\n\\ 😀', templatePath: '/t.mogrt', trackName: 'AI 자막' } });
  });
});
