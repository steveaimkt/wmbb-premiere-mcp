import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrderStore, newOrder } from '../../voiceOrders/store.js';
import type { VoiceOrder } from '../../voiceOrders/types.js';

function order(p: Partial<VoiceOrder>): VoiceOrder {
  return newOrder({ sequenceId: 'seqA', timeSec: 0, recordingPath: '/x.wav', ...p });
}

describe('OrderStore', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'vo-store-'));

  test('list sorts by timeSec, nulls last, ties by createdAt', () => {
    const s = new OrderStore(dir());
    s.add(order({ id: 'c', timeSec: null, createdAt: '2026-01-01T00:00:00Z' }));
    s.add(order({ id: 'b2', timeSec: 5, createdAt: '2026-01-01T00:00:02Z' }));
    s.add(order({ id: 'a', timeSec: 1, createdAt: '2026-01-01T00:00:09Z' }));
    s.add(order({ id: 'b1', timeSec: 5, createdAt: '2026-01-01T00:00:01Z' }));
    expect(s.list().map((o) => o.id)).toEqual(['a', 'b1', 'b2', 'c']);
  });

  test('list(sequenceId) filters', () => {
    const s = new OrderStore(dir());
    s.add(order({ id: 'a', sequenceId: 'seqA' }));
    s.add(order({ id: 'b', sequenceId: 'seqB' }));
    expect(s.list('seqA').map((o) => o.id)).toEqual(['a']);
  });

  test('save then load round-trips', async () => {
    const d = dir();
    const s = new OrderStore(d);
    s.add(order({ id: 'a', timeSec: 3, status: 'ready' }));
    s.add(order({ id: 'b', timeSec: 1, status: 'applied' }));
    await s.save();
    const back = await OrderStore.load(d);
    expect(back.list()).toEqual(s.list());
  });

  test('an order left processing by a restart loads as failed/interrupted (retry and delete work)', async () => {
    const d = dir();
    const s = new OrderStore(d);
    s.add(order({ id: 'p', status: 'processing' }));
    s.add(order({ id: 'r', status: 'ready' }));
    await s.save();
    const back = await OrderStore.load(d);
    expect(back.get('p')).toMatchObject({ status: 'failed', error: expect.stringMatching(/중단/) });
    expect(back.get('r')!.status).toBe('ready');
  });

  test('load of missing dir starts empty', async () => {
    const back = await OrderStore.load(join(dir(), 'nope'));
    expect(back.list()).toEqual([]);
  });

  test('new orders are checked by default and get an id', () => {
    const o = newOrder({ sequenceId: null, timeSec: null, recordingPath: '/x.wav' });
    expect(o.checked).toBe(true);
    expect(o.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(o.status).toBe('processing');
  });

  test('update patches and returns the order; unknown id throws', () => {
    const s = new OrderStore(dir());
    s.add(order({ id: 'a' }));
    expect(s.update('a', { checked: false }).checked).toBe(false);
    expect(s.get('a')?.checked).toBe(false);
    expect(() => s.update('zz', {})).toThrow();
  });

  test('remove deletes', () => {
    const s = new OrderStore(dir());
    s.add(order({ id: 'a' }));
    s.remove('a');
    expect(s.list()).toEqual([]);
  });
});
