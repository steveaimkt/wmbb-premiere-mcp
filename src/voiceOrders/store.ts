import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { VoiceOrder } from './types.js';
import { readJsonOr, writeJsonAtomic } from './fsutil.js';

export function newOrder(
  p: Pick<VoiceOrder, 'sequenceId' | 'timeSec' | 'recordingPath'> & Partial<VoiceOrder>,
): VoiceOrder {
  const id = p.id ?? uuidv4();
  return {
    groupId: id,
    createdAt: new Date().toISOString(),
    transcript: null,
    payload: null,
    status: 'processing',
    checked: true,
    ...p,
    id,
  };
}

function byTime(a: VoiceOrder, b: VoiceOrder): number {
  if (a.timeSec === null && b.timeSec !== null) return 1;
  if (b.timeSec === null && a.timeSec !== null) return -1;
  if (a.timeSec !== null && b.timeSec !== null && a.timeSec !== b.timeSec) return a.timeSec - b.timeSec;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** Orders for one project, persisted as orders.json in the project directory. */
export class OrderStore {
  private orders = new Map<string, VoiceOrder>();
  constructor(readonly dir: string) {}

  static async load(dir: string): Promise<OrderStore> {
    const s = new OrderStore(dir);
    const data = await readJsonOr<{ orders: VoiceOrder[] }>(join(dir, 'orders.json'), { orders: [] });
    for (const o of data.orders ?? []) {
      // A daemon restart mid-pipeline leaves 'processing' behind with nothing to finish it.
      s.orders.set(o.id, o.status === 'processing' ? { ...o, status: 'failed', error: '처리 중 중단됨 — 다시 처리하세요' } : o);
    }
    return s;
  }

  list(sequenceId?: string): VoiceOrder[] {
    const all = [...this.orders.values()];
    return (sequenceId === undefined ? all : all.filter((o) => o.sequenceId === sequenceId)).sort(byTime);
  }

  get(id: string): VoiceOrder | undefined { return this.orders.get(id); }

  add(o: VoiceOrder): void { this.orders.set(o.id, o); }

  update(id: string, patch: Partial<VoiceOrder>): VoiceOrder {
    const cur = this.orders.get(id);
    if (!cur) throw new Error(`order not found: ${id}`);
    const next = { ...cur, ...patch, id };
    this.orders.set(id, next);
    return next;
  }

  remove(id: string): void { this.orders.delete(id); }

  async save(): Promise<void> {
    await writeJsonAtomic(join(this.dir, 'orders.json'), { orders: this.list() });
  }
}
