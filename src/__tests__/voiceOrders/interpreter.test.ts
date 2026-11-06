import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Interpreter, buildSystemPrompt, ORDERS_SCHEMA } from '../../voiceOrders/interpreter.js';
import { Glossary } from '../../voiceOrders/glossary.js';

function fakeClient(reply: unknown | (() => never), stop_reason = 'end_turn') {
  const calls: any[] = [];
  return {
    calls,
    messages: {
      create: async (req: any) => {
        calls.push(req);
        if (typeof reply === 'function') (reply as () => never)();
        return { stop_reason, content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] };
      },
    },
  } as any;
}

async function glossary() {
  const f = join(mkdtempSync(join(tmpdir(), 'vo-int-')), 'g.json');
  writeFileSync(f, JSON.stringify({ 'AKS.7': ['에이케이 세븐'] }));
  return Glossary.load(f);
}

const T = '괄호치고 누가 밖에서 빠르게 뛰어온다';
const fallback = { kind: 'caption', style: 'narration', text: T, placement: 'playhead' };

describe('Interpreter', () => {
  test('one valid caption -> ready', async () => {
    const order = { kind: 'caption', style: 'situation', text: '(누군가가 밖에서 빠르게 달려오는 중)', placement: 'playhead' };
    const it = new Interpreter({ client: fakeClient({ orders: [order] }), model: 'claude-haiku-5-5', glossary: await glossary() });
    expect(await it.interpret(T)).toEqual({ status: 'ready', payloads: [order] });
  });

  test('two orders keep their order', async () => {
    const z = { kind: 'zoom', scale: 150, anchor: 'top_left', holdSec: 3 };
    const c = { kind: 'caption', style: 'item', text: 'AKS.7', placement: 'after_previous' };
    const it = new Interpreter({ client: fakeClient({ orders: [z, c] }), model: 'm', glossary: await glossary() });
    const r = await it.interpret(T);
    expect(r.status).toBe('ready');
    expect(r.payloads).toEqual([z, c]);
  });

  test.each([
    [{ orders: [{ kind: 'caption', style: 'joke', text: 'x', placement: 'playhead' }] }],
    [{ orders: [{ kind: 'zoom', scale: 900, anchor: 'center', holdSec: 2 }] }],
    [{ orders: [{ kind: 'zoom', scale: 120, anchor: 'center', holdSec: 0.1 }] }],
    [{ orders: [] }],
    ['not json'],
  ])('schema violation %j -> unpolished fallback', async (reply) => {
    const it = new Interpreter({ client: fakeClient(reply), model: 'm', glossary: await glossary() });
    const r = await it.interpret(T);
    expect(r.status).toBe('unpolished');
    expect(r.payloads).toEqual([fallback]);
  });

  test('refusal -> unpolished fallback', async () => {
    const it = new Interpreter({ client: fakeClient('', 'refusal'), model: 'm', glossary: await glossary() });
    const r = await it.interpret(T);
    expect(r).toMatchObject({ status: 'unpolished', payloads: [fallback] });
  });

  test('client throws -> unpolished with error message', async () => {
    const it = new Interpreter({ client: fakeClient(() => { throw new Error('401 unauthorized'); }), model: 'm', glossary: await glossary() });
    const r = await it.interpret(T);
    expect(r.status).toBe('unpolished');
    expect(r.payloads).toEqual([fallback]);
    expect(r.error).toContain('401');
  });

  test('request uses model, cached system prompt and json_schema output', async () => {
    const c = fakeClient({ orders: [fallback] });
    const it = new Interpreter({ client: c, model: 'claude-haiku-5-5', glossary: await glossary() });
    await it.interpret(T);
    const req = c.calls[0];
    expect(req.model).toBe('claude-haiku-5-5');
    expect(req.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(req.output_config.format).toEqual({ type: 'json_schema', schema: ORDERS_SCHEMA });
    expect(req.messages).toEqual([{ role: 'user', content: T }]);
  });
});

describe('buildSystemPrompt', () => {
  test('includes glossary and all four style examples, deterministically', () => {
    const p = buildSystemPrompt('- AKS.7 (들리는 말: 에이케이 세븐)');
    expect(p).toContain('AKS.7 (들리는 말: 에이케이 세븐)');
    for (const s of ['narration', 'situation', 'reaction', 'item']) expect(p).toContain(s);
    expect(p).toContain('ㅋㅋㅋ');
    expect(buildSystemPrompt('- AKS.7 (들리는 말: 에이케이 세븐)')).toBe(p);
  });
});

describe('ORDERS_SCHEMA', () => {
  test('every object forbids additional properties', () => {
    const walk = (n: any): void => {
      if (n && typeof n === 'object') {
        if (n.type === 'object') expect(n.additionalProperties).toBe(false);
        Object.values(n).forEach(walk);
      }
    };
    walk(ORDERS_SCHEMA);
  });
});
