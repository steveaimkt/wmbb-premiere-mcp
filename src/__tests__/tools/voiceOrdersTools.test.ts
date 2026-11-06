/**
 * get_playhead / set_marker / place_mogrt_text — the three tools voice orders needs.
 * Own file because index.test.ts carries 21 stale catalog expectations from before the tool trim.
 */
import { PremiereProTools } from '../../tools/index.js';
import { PremiereProBridge } from '../../bridge/index.js';

jest.mock('../../bridge/index.js');
jest.mock('../../utils/whisperRunner.js', () => ({ transcribeAudio: jest.fn() }));

function setup(responses: any[]) {
  const bridge = new PremiereProBridge() as jest.Mocked<PremiereProBridge>;
  const scripts: string[] = [];
  bridge.executeScript = jest.fn(async (s: string) => {
    scripts.push(s);
    const r = responses.shift();
    return typeof r === 'string' ? r : JSON.stringify(r ?? { success: false, error: 'no response' });
  }) as any;
  return { tools: new PremiereProTools(bridge), bridge, scripts };
}
const parse = (r: any) => (typeof r === 'string' ? JSON.parse(r) : r);

describe('voice-orders tools', () => {
  test('all three are in the catalog with their required args', () => {
    const { tools } = setup([]);
    const byName = Object.fromEntries(tools.getAvailableTools().map((t) => [t.name, t]));
    expect(byName.get_playhead).toBeDefined();
    expect(byName.set_marker.inputSchema.safeParse({ timeSec: 1, name: 'n' }).success).toBe(true);
    expect(byName.set_marker.inputSchema.safeParse({ name: 'n' }).success).toBe(false);
    const pm = byName.place_mogrt_text.inputSchema;
    expect(pm.safeParse({ templatePath: '/t.mogrt', trackName: 'AI 자막', startSec: 1, endSec: 2, text: 'x' }).success).toBe(true);
    expect(pm.safeParse({ templatePath: '/t.mogrt', trackName: 'AI 자막', startSec: 1, text: 'x' }).success).toBe(false);
  });

  test('get_playhead returns the re-read position', async () => {
    const { tools } = setup([{ success: true, sequenceId: 's1', timeSec: 12.5 }]);
    expect(parse(await tools.executeTool('get_playhead', {}))).toMatchObject({ success: true, sequenceId: 's1', timeSec: 12.5 });
  });

  test('set_marker rejects a negative time without touching the bridge', async () => {
    const { tools, bridge } = setup([]);
    const r = parse(await tools.executeTool('set_marker', { timeSec: -1, name: 'x' }));
    expect(r.success).toBe(false);
    expect(bridge.executeScript).not.toHaveBeenCalled();
  });

  test('set_marker fails when the re-read marker does not match', async () => {
    const { tools } = setup([
      { success: true, sequenceId: 's1', markerId: 'm1' },
      { success: true, found: true, timeSec: 9.0, name: '[AI] 다른 이름', colorIndex: 3 },
    ]);
    const r = parse(await tools.executeTool('set_marker', { timeSec: 5, name: '[AI] 자막', colorIndex: 3 }));
    expect(r.success).toBe(false);
    expect(r.verifyProblems.length).toBeGreaterThan(0);
  });

  test('set_marker succeeds when the re-read marker matches, and can target an existing marker', async () => {
    const { tools, scripts } = setup([
      { success: true, sequenceId: 's1', markerId: 'm1' },
      { success: true, found: true, timeSec: 5.0, name: '[AI] 자막', colorIndex: 0 },
    ]);
    const r = parse(await tools.executeTool('set_marker', { timeSec: 5, name: '[AI] 자막', colorIndex: 0, markerId: 'm1', sequenceId: 's1' }));
    expect(r).toMatchObject({ success: true, markerId: 'm1', verify: { timeSec: 5, name: '[AI] 자막' } });
    expect(scripts[0]).toContain(JSON.stringify('m1'));
    // 26.5.2: marker.start accepts only a number of seconds — a Time object throws "Illegal Parameter type"
    expect(scripts[0]).toMatch(/m\.start = t;/);
    expect(scripts[0]).not.toMatch(/new Time\(\)/);
  });

  test('place_mogrt_text embeds the text via JSON.stringify and the script parses', async () => {
    const text = 'A "따옴표"\n줄바꿈 \\ 😀';
    const { tools, scripts } = setup([
      { success: true, sequenceId: 's1', clipId: 'c1', trackIndex: 9 },
      { success: true, found: true, startSec: 1, endSec: 2.5, text, name: text },
    ]);
    const r = parse(await tools.executeTool('place_mogrt_text', { templatePath: '/t.mogrt', trackName: 'AI 자막', startSec: 1, endSec: 2.5, text }));
    expect(r).toMatchObject({ success: true, clipId: 'c1', trackIndex: 9, verify: { startSec: 1, endSec: 2.5, text } });
    expect(scripts[0]).toContain(JSON.stringify(text));
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  });

  test('place_mogrt_text fails when the re-read text or timing differs', async () => {
    const { tools } = setup([
      { success: true, sequenceId: 's1', clipId: 'c1', trackIndex: 9 },
      { success: true, found: true, startSec: 1, endSec: 11, text: '', name: '그래픽' },
    ]);
    const r = parse(await tools.executeTool('place_mogrt_text', { templatePath: '/t.mogrt', trackName: 'AI 자막', startSec: 1, endSec: 2.5, text: '자막' }));
    expect(r.success).toBe(false);
    expect(r.verifyProblems.join(' ')).toMatch(/text|end/);
  });

  test('place_mogrt_text passes through a placement failure', async () => {
    const { tools } = setup([{ success: false, error: 'template has no editable text (not an After Effects .mogrt?)' }]);
    const r = parse(await tools.executeTool('place_mogrt_text', { templatePath: '/t.mogrt', trackName: 'AI 자막', startSec: 1, endSec: 2, text: 'x' }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/After Effects/);
  });
});
