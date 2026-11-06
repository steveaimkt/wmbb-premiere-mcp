import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { VoiceOrdersDaemon } from '../../voiceOrders/daemon.js';
import { OrderStore } from '../../voiceOrders/store.js';
import type { PremierePort } from '../../voiceOrders/premiere.js';
import { DEFAULT_SETTINGS, type OrderPayload, type VoiceOrder } from '../../voiceOrders/types.js';
import type { InterpretResult } from '../../voiceOrders/interpreter.js';

const CAP = (text: string): OrderPayload => ({ kind: 'caption', style: 'narration', text, placement: 'playhead' });
const ZOOM: OrderPayload = { kind: 'zoom', scale: 120, anchor: 'center', holdSec: 2 };

class FakePremiere implements PremierePort {
  seq: { id: string; projectPath: string } | null = { id: 'seqA', projectPath: '/p.prproj' };
  head: number | null = 12;
  markers: { orderId: string; time: number | null; color: string; markerId: string | null }[] = [];
  placed: string[] = [];
  zooms: number[] = [];
  backupOk = true;
  failText = new Set<string>();
  existing: { startSec: number; endSec: number }[] = [];
  async activeSequence() { return this.seq; }
  async playhead() { return this.head; }
  async setMarker(o: VoiceOrder, color: 'orange' | 'green' | 'white') {
    this.markers.push({ orderId: o.id, time: o.timeSec, color, markerId: o.markerId ?? null });
    return o.markerId ?? `m${this.markers.length}`;
  }
  async existingCaptions() { return this.existing; }
  async backup() { return this.backupOk; }
  async placeCaption(_seq: string, c: { text: string }) {
    if (this.failText.has(c.text)) return { ok: false, error: 'mogrt failed' };
    this.placed.push(c.text);
    return { ok: true };
  }
  async zoom(_seq: string, atSec: number) { this.zooms.push(atSec); return { ok: true }; }
}

function setupWithToken(token: string) {
  const s = setup();
  (s.d as any).deps.token = token;
  return s;
}

function setup(over: { stt?: string | null; result?: InterpretResult } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vo-daemon-'));
  const premiere = new FakePremiere();
  let interpretCalls = 0;
  const stores = new Map<string, OrderStore>();
  const d = new VoiceOrdersDaemon({
    premiere,
    stt: {
      transcribe: async () => (over.stt === null ? { ok: false as const, error: 'stt down' } : { ok: true as const, text: over.stt ?? '상자를 열었다' }),
    },
    interpreter: {
      interpret: async (t: string) => { interpretCalls++; return over.result ?? { status: 'ready', payloads: [CAP(t)] }; },
    },
    storeFor: async (p: string) => {
      if (!stores.has(p)) stores.set(p, await OrderStore.load(join(dir, encodeURIComponent(p))));
      return stores.get(p)!;
    },
    settings: { ...DEFAULT_SETTINGS },
  });
  return { d, premiere, calls: () => interpretCalls };
}

async function record(d: VoiceOrdersDaemon, dur = 1.2) {
  const id = await d.onKeyDown();
  await d.onKeyUp(id, '/rec/a.wav', dur);
  return id;
}

describe('VoiceOrdersDaemon pipeline', () => {
  test('playhead at key-down becomes timeSec; immediate mode drops an orange marker', async () => {
    const { d, premiere } = setup();
    await record(d);
    const [o] = await d.orders();
    expect(o).toMatchObject({ timeSec: 12, sequenceId: 'seqA', status: 'ready', checked: true, transcript: '상자를 열었다' });
    expect(premiere.markers).toEqual([expect.objectContaining({ time: 12, color: 'orange' })]);
    expect(o!.markerId).toBe('m1');
  });

  test('playhead uses key-down time even if the playhead moved before key-up', async () => {
    const { d, premiere } = setup();
    const id = await d.onKeyDown();
    premiere.head = 99;
    await d.onKeyUp(id, '/rec/a.wav', 1);
    expect((await d.orders())[0]!.timeSec).toBe(12);
  });

  test('bridge off: no position, excluded from apply', async () => {
    const { d, premiere } = setup();
    premiere.head = null;
    premiere.seq = null;
    await record(d);
    premiere.seq = { id: 'seqA', projectPath: '/p.prproj' };
    const [o] = await d.orders();
    expect(o).toMatchObject({ timeSec: null, status: 'no_position' });
    expect(premiere.markers).toEqual([]);
    const r = await d.apply();
    expect(r.applied).toEqual([]);
    expect(premiere.placed).toEqual([]);
  });

  test('setting time on a no_position order makes it applicable', async () => {
    const { d, premiere } = setup();
    premiere.head = null;
    premiere.seq = null;
    await record(d);
    premiere.seq = { id: 'seqA', projectPath: '/p.prproj' };
    const [o] = await d.orders();
    const u = await d.patch(o!.id, { timeSec: 30 });
    expect(u).toMatchObject({ timeSec: 30, sequenceId: 'seqA', status: 'ready' });
    expect((await d.apply()).applied).toEqual([o!.id]);
  });

  test('short tap (<0.4s) creates nothing', async () => {
    const { d, calls } = setup();
    await record(d, 0.3);
    expect(await d.orders()).toEqual([]);
    expect(calls()).toBe(0);
  });

  test('empty transcript -> no_speech, interpreter not called', async () => {
    const { d, calls } = setup({ stt: '' });
    await record(d);
    expect((await d.orders())[0]).toMatchObject({ status: 'no_speech', payload: null });
    expect(calls()).toBe(0);
  });

  test('stt failure -> failed, retry re-runs the pipeline', async () => {
    const s = setup({ stt: null });
    await record(s.d);
    const [o] = await s.d.orders();
    expect(o).toMatchObject({ status: 'failed', error: 'stt down' });
    (s.d as any).deps.stt.transcribe = async () => ({ ok: true, text: '다시' });
    await s.d.retry(o!.id);
    expect((await s.d.orders())[0]).toMatchObject({ status: 'ready', transcript: '다시' });
  });

  test('two payloads -> two orders sharing groupId and time', async () => {
    const { d } = setup({ result: { status: 'ready', payloads: [ZOOM, CAP('적 발견')] } });
    await record(d);
    const list = await d.orders();
    expect(list).toHaveLength(2);
    expect(list[0]!.groupId).toBe(list[1]!.groupId);
    expect(list.map((o) => o.timeSec)).toEqual([12, 12]);
    expect(list.map((o) => o.payload?.kind)).toEqual(['zoom', 'caption']);
  });

  test('unpolished interpreter result keeps unpolished status', async () => {
    const { d } = setup({ result: { status: 'unpolished', payloads: [CAP('raw')], error: 'offline' } });
    await record(d);
    expect((await d.orders())[0]).toMatchObject({ status: 'unpolished', error: 'offline' });
  });
});

describe('VoiceOrdersDaemon apply', () => {
  test('only the active sequence orders are applied', async () => {
    const { d, premiere } = setup({ stt: 'A' });
    await record(d);
    premiere.seq = { id: 'seqB', projectPath: '/p.prproj' };
    const r = await d.apply();
    expect(r.applied).toEqual([]);
    expect(premiere.placed).toEqual([]);
    premiere.seq = { id: 'seqA', projectPath: '/p.prproj' };
    expect((await d.apply()).applied).toHaveLength(1);
  });

  test('backup failure applies nothing', async () => {
    const { d, premiere } = setup();
    await record(d);
    premiere.backupOk = false;
    const r = await d.apply();
    expect(r).toMatchObject({ success: false, backupOk: false, applied: [] });
    expect(premiere.placed).toEqual([]);
  });

  test('partial failure: applied ones go green, failures marked, success false', async () => {
    const s = setup({ result: { status: 'ready', payloads: [CAP('ok'), CAP('bad'), ZOOM] } });
    await record(s.d);
    s.premiere.failText.add('bad');
    const r = await s.d.apply();
    expect(r.success).toBe(false);
    expect(r.applied).toHaveLength(2);
    expect(r.failed).toEqual([expect.objectContaining({ error: 'mogrt failed' })]);
    const list = await s.d.orders();
    expect(list.map((o) => o.status).sort()).toEqual(['applied', 'applied', 'apply_failed']);
    expect(s.premiere.zooms).toEqual([12]);
    expect(s.premiere.markers.some((m) => m.color === 'green')).toBe(true);
  });

  test('unchecked orders are skipped; applied ones are not re-applied', async () => {
    const { d, premiere } = setup();
    await record(d);
    await record(d);
    const [a] = await d.orders();
    await d.patch(a!.id, { checked: false });
    expect((await d.apply()).applied).toHaveLength(1);
    expect((await d.apply()).applied).toHaveLength(0);
    expect(premiere.placed).toHaveLength(1);
  });
});

describe('VoiceOrdersDaemon apply safety', () => {
  test('concurrent apply calls place each caption once', async () => {
    const { d, premiere } = setup();
    await record(d);
    const [r1, r2] = await Promise.all([d.apply(), d.apply()]);
    expect(premiere.placed).toHaveLength(1);
    expect([r1.applied.length, r2.applied.length].sort()).toEqual([0, 1]);
    expect([r1, r2].some((r) => r.error === 'apply already running')).toBe(true);
  });

  test('retry and repolish refuse applied orders', async () => {
    const { d } = setup();
    await record(d);
    await d.apply();
    const [o] = await d.orders();
    await expect(d.retry(o!.id)).rejects.toThrow(/applied/);
    await expect(d.repolish(o!.id)).rejects.toThrow(/applied/);
    expect((await d.orders())[0]!.status).toBe('applied');
  });

  test('an order deleted mid-apply does not abort the rest', async () => {
    const s = setup({ result: { status: 'ready', payloads: [CAP('one'), CAP('two')] } });
    await record(s.d);
    const list = await s.d.orders();
    const orig = s.premiere.placeCaption.bind(s.premiere);
    s.premiere.placeCaption = async (seq: string, c: any) => {
      const r = await orig(seq, c);
      if (c.text === 'one') await s.d.remove(list[0]!.id);
      return r;
    };
    const r = await s.d.apply();
    expect(s.premiere.placed).toEqual(['one', 'two']);
    expect(r.applied).toContain(list[1]!.id);
    expect((await s.d.orders()).find((o) => o.id === list[1]!.id)!.status).toBe('applied');
  });
});

describe('VoiceOrdersDaemon with a dead bridge', () => {
  test('key-up does not wait for the marker before transcribing', async () => {
    const { d, premiere } = setup();
    premiere.setMarker = () => new Promise(() => {}); // bridge hangs
    const id = await d.onKeyDown();
    const done = d.onKeyUp(id, '/rec/a.wav', 1).then(() => 'done');
    const r = await Promise.race([done, new Promise((res) => setTimeout(() => res('stalled'), 200))]);
    expect(r).toBe('done');
    expect((await d.orders())[0]!.status).toBe('ready');
  });

  test('ticking a checkbox with the bridge down skips the marker call', async () => {
    const { d, premiere } = setup();
    await record(d);
    const [o] = await d.orders();
    let markerCalls = 0;
    premiere.setMarker = async () => { markerCalls++; return null; };
    premiere.seq = null; // bridge went away
    const u = await d.patch(o!.id, { checked: false });
    expect(u.checked).toBe(false);
    expect(markerCalls).toBe(0);
  });
});

describe('VoiceOrdersDaemon edits', () => {
  test('PATCH timeSec moves the marker and re-sorts', async () => {
    const { d, premiere } = setup();
    await record(d);
    premiere.head = 20;
    await record(d);
    const [first] = await d.orders();
    await d.patch(first!.id, { timeSec: 25 });
    const list = await d.orders();
    expect(list.map((o) => o.timeSec)).toEqual([20, 25]);
    const last = premiere.markers[premiere.markers.length - 1]!;
    expect(last).toMatchObject({ orderId: first!.id, time: 25, markerId: 'm1' });
  });

  test('PATCH payload rejects invalid payloads', async () => {
    const { d } = setup();
    await record(d);
    const [o] = await d.orders();
    await expect(d.patch(o!.id, { payload: { kind: 'zoom', scale: 999, anchor: 'center', holdSec: 2 } as any })).rejects.toThrow();
  });

  test('repolish re-interprets the transcript', async () => {
    const s = setup({ result: { status: 'unpolished', payloads: [CAP('raw')] } });
    await record(s.d);
    const [o] = await s.d.orders();
    (s.d as any).deps.interpreter.interpret = async () => ({ status: 'ready', payloads: [CAP('다듬음')] });
    await s.d.repolish(o!.id);
    const list = await s.d.orders();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'ready', payload: CAP('다듬음') });
  });
});

describe('VoiceOrdersDaemon HTTP auth', () => {
  function raw(port: number, method: string, path: string, headers: Record<string, string>) {
    return new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject);
      req.end();
    });
  }

  test('token required; Origin null without token refused; foreign Host refused', async () => {
    const { d } = setupWithToken('s3cret');
    const port = await d.listen(0);
    try {
      expect(await raw(port, 'GET', '/orders', {})).toBe(401);
      expect(await raw(port, 'POST', '/apply', { origin: 'null' })).toBe(401);
      expect(await raw(port, 'GET', '/orders', { 'x-voice-orders-token': 'wrong' })).toBe(401);
      expect(await raw(port, 'GET', '/orders', { 'x-voice-orders-token': 's3cret' })).toBe(200);
      expect(await raw(port, 'GET', '/orders', { 'x-voice-orders-token': 's3cret', host: `evil.example:${port}` })).toBe(403);
      expect(await raw(port, 'GET', '/orders', { 'x-voice-orders-token': 's3cret', host: `localhost:${port}` })).toBe(200);
    } finally {
      await d.close();
    }
  });
});

describe('VoiceOrdersDaemon HTTP', () => {
  function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
    return new Promise<{ status: number; json: any }>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve({ status: res.statusCode!, json: s ? JSON.parse(s) : null }));
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  test('hotkey down/up then GET /orders; web origins are refused', async () => {
    const { d } = setup();
    const port = await d.listen(0);
    try {
      const down = await call(port, 'POST', '/hotkey/down');
      expect(down.status).toBe(200);
      await call(port, 'POST', '/hotkey/up', {}, { pendingId: down.json.pendingId, wavPath: '/rec/a.wav', durationSec: 1 });
      let got = await call(port, 'GET', '/orders');
      for (let i = 0; i < 50 && got.json.orders[0]?.status !== 'ready'; i++) {
        await new Promise((r) => setTimeout(r, 20));
        got = await call(port, 'GET', '/orders');
      }
      expect(got.json.orders).toHaveLength(1);
      expect(got.json.orders[0].status).toBe('ready');
      const evil = await call(port, 'POST', '/apply', { origin: 'https://evil.example' });
      expect(evil.status).toBe(403);
      const missing = await call(port, 'PATCH', '/orders/nope', {}, { checked: false });
      expect(missing.status).toBe(404);
    } finally {
      await d.close();
    }
  });
});
