/**
 * Live check against the real API. Costs money: runs only with VOICE_ORDERS_LIVE=1.
 *   VOICE_ORDERS_LIVE=1 npx jest interpreter.live
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Interpreter } from '../../voiceOrders/interpreter.js';
import { Glossary } from '../../voiceOrders/glossary.js';

const live = process.env.VOICE_ORDERS_LIVE === '1' ? describe : describe.skip;

type Want = { kind: 'caption' | 'zoom'; style?: string; placement?: string };
const CASES: [string, Want[]][] = [
  ['여기서 상자 열었는데 아무것도 없었다고 적어서 다듬어', [{ kind: 'caption', style: 'narration', placement: 'playhead' }]],
  ['적이 세 명이나 있어서 숨어있기로 했다', [{ kind: 'caption', style: 'narration', placement: 'playhead' }]],
  ['탈출구까지 겨우 도착했다고 적어서 다듬어', [{ kind: 'caption', style: 'narration', placement: 'playhead' }]],
  ['돈이 다 떨어져서 맨몸으로 들어갔다', [{ kind: 'caption', style: 'narration', placement: 'playhead' }]],
  ['괄호치고 누가 밖에서 빠르게 뛰어온다', [{ kind: 'caption', style: 'situation', placement: 'playhead' }]],
  ['괄호치고 총알이 하나도 안 남음', [{ kind: 'caption', style: 'situation', placement: 'playhead' }]],
  ['괄호 치고 문 뒤에 누가 있음', [{ kind: 'caption', style: 'situation', placement: 'playhead' }]],
  ['아 이거 대박 웃기다 ㅋㅋㅋ', [{ kind: 'caption', style: 'reaction', placement: 'playhead' }]],
  ['헐 미쳤다', [{ kind: 'caption', style: 'reaction', placement: 'playhead' }]],
  ['아니 이게 왜 죽어', [{ kind: 'caption', style: 'reaction', placement: 'playhead' }]],
  ['아이템 이름 에이케이에스 세븐', [{ kind: 'caption', style: 'item', placement: 'playhead' }]],
  ['아이템 이름 군용 배터리', [{ kind: 'caption', style: 'item', placement: 'playhead' }]],
  ['앞 자막 뒤에 바로 괄호치고 결국 도망감', [{ kind: 'caption', style: 'situation', placement: 'after_previous' }]],
  ['앞 자막 뒤에 바로 그래도 살아서 나왔다고 적어서 다듬어', [{ kind: 'caption', style: 'narration', placement: 'after_previous' }]],
  ['여기 확대해줘', [{ kind: 'zoom' }]],
  ['인벤토리 쪽 크게 확대해줘', [{ kind: 'zoom' }]],
  ['왼쪽 위 3초 동안 확대', [{ kind: 'zoom' }]],
  ['여기 확대하고 괄호치고 적 발견 자막도 넣어줘', [{ kind: 'zoom' }, { kind: 'caption', style: 'situation' }]],
  ['오른쪽 아래 확대하고 아이템 이름 에이케이에스 세븐', [{ kind: 'zoom' }, { kind: 'caption', style: 'item' }]],
  ['크게 확대하고 앞 자막 뒤에 바로 ㅋㅋㅋ 이게 되네 리액션 넣어줘', [{ kind: 'zoom' }, { kind: 'caption', style: 'reaction', placement: 'after_previous' }]],
];

live('Interpreter (live API)', () => {
  let it: Interpreter;
  beforeAll(async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'vo-live-')), 'g.json');
    writeFileSync(f, JSON.stringify({ 'AKS.7': ['에이케이에스 세븐', '에이케이 세븐'] }));
    it = new Interpreter({ client: new Anthropic(), model: process.env.VOICE_ORDERS_MODEL || 'claude-haiku-5-5', glossary: await Glossary.load(f) });
  });

  test.each(CASES)('%s', async (sentence, want) => {
    const r = await it.interpret(sentence);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('ready');
    expect(r.payloads).toHaveLength(want.length);
    want.forEach((w, i) => expect(r.payloads[i]).toMatchObject(w));
  }, 60000);
});
