/**
 * Voice orders daemon: hotkey → recording → Whisper → Claude → order list,
 * then review-and-apply onto the active Premiere sequence.
 * Local HTTP API on 127.0.0.1 only; requests from web origins are refused.
 */
import { timingSafeEqual } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { v4 as uuidv4 } from 'uuid';
import type { Glossary } from './glossary.js';
import type { InterpretResult, Interpreter } from './interpreter.js';
import { validatePayload } from './interpreter.js';
import type { PremierePort } from './premiere.js';
import type { SttWorker } from './stt.js';
import { OrderStore, newOrder } from './store.js';
import { layoutCaptions, zoomKeyframes } from './timing.js';
import type { OrderPayload, Settings, VoiceOrder } from './types.js';

export const MIN_RECORDING_SEC = 0.4;
export const UNKNOWN_PROJECT = '(unknown project)';
export const HELPER_URL = 'http://127.0.0.1:47614';

export interface ApplyReport { success: boolean; applied: string[]; failed: { id: string; error: string }[]; backupOk: boolean; error?: string }

export interface DaemonDeps {
  premiere: PremierePort;
  stt: Pick<SttWorker, 'transcribe'>;
  interpreter: Pick<Interpreter, 'interpret'>;
  storeFor: (projectPath: string) => Promise<OrderStore>;
  settings: Settings;
  glossary?: Glossary;
  /** Shared secret (token file, owner-only). When set, every request must carry it. */
  token?: string;
  /** Hotkey helper base URL (default HELPER_URL). */
  helperUrl?: string;
}

type PendingKey = { sequenceId: string | null; projectPath: string | null; timeSec: number | null; createdAt: string };
type Patch = Partial<Pick<VoiceOrder, 'checked' | 'timeSec' | 'payload'>>;

const APPLICABLE = new Set(['ready', 'unpolished', 'apply_failed']);

export class HttpError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }

export class VoiceOrdersDaemon {
  private pending = new Map<string, PendingKey>();
  private lastProject: string | null = null;
  private bridgeUp = false;
  private sttUp = true;
  private saveChain: Promise<void> = Promise.resolve();
  private clients = new Set<ServerResponse>();
  private server: Server | null = null;

  constructor(private readonly deps: DaemonDeps) {}

  // ---------- store helpers ----------

  private async current(): Promise<{ seq: { id: string; projectPath: string } | null; store: OrderStore }> {
    const seq = await this.deps.premiere.activeSequence();
    this.bridgeUp = seq !== null;
    if (seq) this.lastProject = seq.projectPath;
    const store = await this.deps.storeFor(seq?.projectPath ?? this.lastProject ?? UNKNOWN_PROJECT);
    if (seq) await this.adoptUnknown(store);
    return { seq, store };
  }

  /** Orders recorded before any project was seen (bridge off) move into the first known project. */
  private async adoptUnknown(store: OrderStore): Promise<void> {
    const unknown = await this.deps.storeFor(UNKNOWN_PROJECT);
    if (unknown === store) return;
    const orphans = unknown.list();
    if (orphans.length === 0) return;
    for (const o of orphans) { store.add(o); unknown.remove(o.id); }
    await this.persist(unknown);
    await this.persist(store);
  }

  private persist(store: OrderStore): Promise<void> {
    this.saveChain = this.saveChain.then(() => store.save()).catch(() => { /* next save retries */ });
    this.emit('orders-changed', {});
    return this.saveChain;
  }

  private async findOrder(id: string): Promise<{ store: OrderStore; order: VoiceOrder; seq: { id: string; projectPath: string } | null }> {
    const { seq, store } = await this.current();
    const order = store.get(id);
    if (!order) throw new HttpError(404, `order not found: ${id}`);
    return { store, order, seq };
  }

  /** Orders for the active sequence plus those with no known sequence (need a time). */
  async orders(): Promise<VoiceOrder[]> {
    const { seq, store } = await this.current();
    return store.list().filter((o) => o.sequenceId === null || o.sequenceId === seq?.id);
  }

  // ---------- pipeline ----------

  async onKeyDown(): Promise<string> {
    const createdAt = new Date().toISOString();
    const [seq, timeSec] = await Promise.all([this.deps.premiere.activeSequence(), this.deps.premiere.playhead()]);
    this.bridgeUp = seq !== null;
    if (seq) this.lastProject = seq.projectPath;
    const id = uuidv4();
    this.pending.set(id, { sequenceId: seq?.id ?? null, projectPath: seq?.projectPath ?? null, timeSec: seq ? timeSec : null, createdAt });
    this.emit('status', this.status());
    return id;
  }

  async onKeyUp(pendingId: string, wavPath: string, durationSec: number): Promise<void> {
    const key = this.pending.get(pendingId);
    if (!key) throw new HttpError(404, `unknown pendingId: ${pendingId}`);
    this.pending.delete(pendingId);
    if (!(durationSec >= MIN_RECORDING_SEC)) return;

    const store = await this.deps.storeFor(key.projectPath ?? this.lastProject ?? UNKNOWN_PROJECT);
    const order = newOrder({ id: pendingId, sequenceId: key.sequenceId, timeSec: key.timeSec, recordingPath: wavPath, createdAt: key.createdAt });
    store.add(order);
    await this.persist(store);
    if (order.timeSec !== null && this.deps.settings.markerMode === 'immediate') {
      // Don't hold transcription behind the bridge (up to 60s when it stalls).
      void this.deps.premiere.setMarker(order, 'orange').catch(() => null).then((markerId) => {
        if (!markerId) return;
        for (const o of store.list()) {
          if (o.groupId === order.groupId && !o.markerId) store.update(o.id, { markerId });
        }
        return this.persist(store);
      });
    }
    await this.process(store, order.id, true);
  }

  /** Transcribe (optionally) and interpret one order, filling its group. */
  private async process(store: OrderStore, id: string, transcribe: boolean): Promise<void> {
    let order = store.get(id)!;
    let text = order.transcript ?? '';
    if (transcribe) {
      const r = await this.deps.stt.transcribe(order.recordingPath);
      this.sttUp = r.ok;
      if (!r.ok) {
        store.update(id, { status: 'failed', error: r.error, payload: null });
        await this.persist(store);
        return;
      }
      text = r.text;
      order = store.update(id, { transcript: text });
    }
    if (!text.trim()) {
      store.update(id, { status: 'no_speech', payload: null, error: undefined });
      await this.persist(store);
      return;
    }
    const result = await this.deps.interpreter.interpret(text);
    this.fillGroup(store, store.get(id)!, result);
    await this.persist(store);
  }

  private fillGroup(store: OrderStore, head: VoiceOrder, result: InterpretResult): void {
    for (const o of store.list()) {
      if (o.groupId === head.groupId && o.id !== head.id && o.status !== 'applied') store.remove(o.id);
    }
    const polished = result.status === 'ready';
    const status = (o: { timeSec: number | null }) => (o.timeSec === null ? 'no_position' as const : result.status);
    const common = { polished, error: result.error, status: status(head) };
    const [first, ...rest] = result.payloads;
    store.update(head.id, { ...common, payload: first ?? null });
    rest.forEach((payload, i) => {
      store.add(newOrder({
        sequenceId: head.sequenceId, timeSec: head.timeSec, recordingPath: head.recordingPath,
        groupId: head.groupId, transcript: head.transcript, markerId: head.markerId,
        createdAt: new Date(Date.parse(head.createdAt) + i + 1).toISOString(),
        payload, ...common,
      }));
    });
  }

  private assertReprocessable(order: VoiceOrder): void {
    if (order.status === 'applied') throw new HttpError(409, 'order already applied; delete it from the timeline first');
    if (this.applying) throw new HttpError(409, 'apply is running; try again after it finishes');
  }

  async retry(id: string): Promise<void> {
    const { store, order } = await this.findOrder(id);
    this.assertReprocessable(order);
    store.update(id, { status: 'processing', error: undefined });
    await this.persist(store);
    await this.process(store, id, true);
  }

  async repolish(id: string): Promise<void> {
    const { store, order } = await this.findOrder(id);
    this.assertReprocessable(order);
    if (!order.transcript) throw new HttpError(409, 'no transcript to polish; use retry');
    store.update(id, { status: 'processing', error: undefined });
    await this.persist(store);
    await this.process(store, id, false);
  }

  // ---------- edits ----------

  async patch(id: string, p: Patch): Promise<VoiceOrder> {
    const { store, order, seq } = await this.findOrder(id);
    const next: Partial<VoiceOrder> = {};
    if (p.checked !== undefined) next.checked = Boolean(p.checked);
    if (p.payload !== undefined) {
      const v = validatePayload(p.payload);
      if (!v) throw new HttpError(400, 'invalid payload');
      next.payload = v;
      if (order.status !== 'no_position' && order.status !== 'applied') next.status = 'ready';
      next.polished = true;
    }
    if (p.timeSec !== undefined) {
      if (typeof p.timeSec !== 'number' || !Number.isFinite(p.timeSec) || p.timeSec < 0) throw new HttpError(400, 'invalid timeSec');
      next.timeSec = p.timeSec;
      if (order.sequenceId === null) {
        if (!seq) throw new HttpError(409, 'no active sequence to attach this order to');
        next.sequenceId = seq.id;
      }
      if (order.status === 'no_position') {
        const payload = next.payload ?? order.payload;
        next.status = payload ? ((next.polished ?? order.polished) ? 'ready' : 'unpolished') : 'no_speech';
      }
    }
    let updated = store.update(id, next);
    if (this.bridgeUp && (p.timeSec !== undefined || p.checked !== undefined)) {
      const color = updated.status === 'applied' ? 'green' : updated.checked ? 'orange' : 'white';
      const markerId = await this.deps.premiere.setMarker(updated, color).catch(() => null);
      if (markerId) updated = store.update(id, { markerId });
    }
    await this.persist(store);
    return updated;
  }

  async remove(id: string): Promise<void> {
    const { store, order } = await this.findOrder(id);
    if (this.bridgeUp && order.markerId && order.timeSec !== null) await this.deps.premiere.setMarker(order, 'white').catch(() => null);
    store.remove(id);
    await this.persist(store);
  }

  // ---------- apply ----------

  private applying = false;

  /** One apply at a time: a double click must not place every caption twice. */
  async apply(): Promise<ApplyReport> {
    if (this.applying) return { success: false, applied: [], failed: [], backupOk: false, error: 'apply already running' };
    this.applying = true;
    try {
      return await this.applyOnce();
    } finally {
      this.applying = false;
    }
  }

  private async applyOnce(): Promise<ApplyReport> {
    const { seq, store } = await this.current();
    if (!seq) return { success: false, applied: [], failed: [], backupOk: false, error: 'no active sequence (Start Bridge?)' };
    const targets = store.list(seq.id).filter((o) => o.checked && o.payload && o.timeSec !== null && APPLICABLE.has(o.status));
    if (targets.length === 0) return { success: true, applied: [], failed: [], backupOk: true };

    const backupOk = await this.deps.premiere.backup(seq.id).catch(() => false);
    if (!backupOk) return { success: false, applied: [], failed: [], backupOk: false, error: 'backup_sequence failed; nothing applied' };

    const applied: string[] = [];
    const failed: { id: string; error: string }[] = [];
    const mark = async (o: VoiceOrder, r: { ok: boolean; error?: string }) => {
      if (!store.get(o.id)) {
        // Deleted while apply ran: report what happened on the timeline, keep going.
        if (r.ok) applied.push(o.id); else failed.push({ id: o.id, error: r.error ?? 'failed' });
        return;
      }
      if (r.ok) {
        applied.push(o.id);
        const u = store.update(o.id, { status: 'applied', error: undefined });
        const markerId = await this.deps.premiere.setMarker(u, 'green').catch(() => null);
        if (markerId && store.get(o.id)) store.update(o.id, { markerId });
      } else {
        failed.push({ id: o.id, error: r.error ?? 'failed' });
        store.update(o.id, { status: 'apply_failed', error: r.error });
      }
    };

    try {
      const existing = await this.deps.premiere.existingCaptions(seq.id).catch(() => []);
      const byId = new Map(targets.map((o) => [o.id, o]));
      for (const c of layoutCaptions(targets, existing)) {
        await mark(byId.get(c.orderId)!, await this.deps.premiere.placeCaption(seq.id, c).catch((e) => ({ ok: false, error: String(e?.message ?? e) })));
      }
      for (const o of targets) {
        if (o.payload?.kind !== 'zoom') continue;
        const z = o.payload;
        const keys = zoomKeyframes(o.timeSec!, z.scale, z.holdSec, z.anchor);
        await mark(o, await this.deps.premiere.zoom(seq.id, o.timeSec!, keys).catch((e) => ({ ok: false, error: String(e?.message ?? e) })));
      }
    } finally {
      await this.persist(store);
    }
    return { success: failed.length === 0, applied, failed, backupOk: true };
  }

  // ---------- status & events ----------

  status() {
    return { bridge: this.bridgeUp, stt: this.sttUp, model: this.deps.settings.model };
  }

  private emit(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(msg);
  }

  // ---------- HTTP ----------

  listen(port: number): Promise<number> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        const status = e instanceof HttpError ? e.status : 500;
        this.send(res, status, { success: false, error: String(e?.message ?? e) });
      });
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  }

  close(): Promise<void> {
    for (const c of this.clients) c.end();
    this.clients.clear();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...this.cors(res) });
    res.end(JSON.stringify(body));
  }

  private cors(res: ServerResponse): Record<string, string> {
    const origin = (res as any).__origin as string | undefined;
    return origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
  }

  private async body(req: IncomingMessage): Promise<any> {
    let s = '';
    for await (const chunk of req) {
      s += chunk;
      if (s.length > 1_000_000) throw new HttpError(413, 'body too large');
    }
    if (!s) return {};
    try { return JSON.parse(s); } catch { throw new HttpError(400, 'invalid JSON'); }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The CEP panel and the helper send no Origin, "null" or file://. Any http(s)
    // origin is a web page in a browser — refuse it so a site cannot drive the API.
    const origin = req.headers.origin;
    if (origin && /^https?:/i.test(origin)) return this.send(res, 403, { success: false, error: 'web origins are not allowed' });
    if (origin) (res as any).__origin = origin;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // DNS rebinding: a page on evil.example resolving to 127.0.0.1 still sends its own Host.
    const port = (this.server?.address() as AddressInfo | null)?.port;
    const host = String(req.headers.host ?? '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return this.send(res, 403, { success: false, error: 'bad host' });
    // Origin "null" (sandboxed iframes) cannot be told apart from the CEP panel, so a
    // token is the real gate. EventSource cannot set headers: /events may pass ?token=.
    if (this.deps.token !== undefined && req.method !== 'OPTIONS') {
      const given = String(req.headers['x-voice-orders-token'] ?? (url.pathname === '/events' ? url.searchParams.get('token') ?? '' : ''));
      const a = Buffer.from(given);
      const b = Buffer.from(this.deps.token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return this.send(res, 401, { success: false, error: 'missing or wrong token' });
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const m = req.method ?? 'GET';

    if (m === 'OPTIONS') {
      res.writeHead(204, { ...this.cors(res), 'access-control-allow-methods': 'GET,POST,PATCH,DELETE', 'access-control-allow-headers': 'content-type, x-voice-orders-token' });
      return void res.end();
    }
    if (m === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...this.cors(res) });
      res.write(`event: status\ndata: ${JSON.stringify(this.status())}\n\n`);
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    if (m === 'POST' && url.pathname === '/hotkey/down') return this.send(res, 200, { pendingId: await this.onKeyDown() });
    if (m === 'POST' && url.pathname === '/hotkey/up') {
      const b = await this.body(req);
      // Answer at once; transcription and interpretation continue in the background.
      const key = this.pending.get(String(b.pendingId));
      if (!key) throw new HttpError(404, `unknown pendingId: ${b.pendingId}`);
      const work = this.onKeyUp(String(b.pendingId), String(b.wavPath), Number(b.durationSec));
      work.catch(() => { /* reflected in order status */ });
      return this.send(res, 200, { success: true });
    }
    if (m === 'GET' && url.pathname === '/orders') return this.send(res, 200, { orders: await this.orders(), status: this.status() });
    if (m === 'GET' && url.pathname === '/status') {
      await this.current();
      return this.send(res, 200, this.status());
    }
    if (m === 'POST' && url.pathname === '/apply') return this.send(res, 200, await this.apply());
    if (m === 'POST' && url.pathname === '/glossary') {
      const b = await this.body(req);
      if (!this.deps.glossary) throw new HttpError(501, 'glossary not configured');
      if (typeof b.term !== 'string' || !b.term.trim() || typeof b.heard !== 'string') throw new HttpError(400, 'term and heard required');
      await this.deps.glossary.add(b.term.trim(), b.heard.trim());
      return this.send(res, 200, { success: true });
    }
    if (m === 'POST' && (url.pathname === '/record/start' || url.pathname === '/record/stop')) {
      const r = await fetch(`${this.deps.helperUrl ?? HELPER_URL}/${parts[1] === 'start' ? 'start' : 'stop'}`, {
        method: 'POST', headers: this.deps.token ? { 'x-voice-orders-token': this.deps.token } : {},
      })
        .then((x) => x.ok).catch(() => false);
      return this.send(res, r ? 200 : 502, { success: r, ...(r ? {} : { error: 'hotkey helper not reachable' }) });
    }
    if (parts[0] === 'orders' && parts[1]) {
      const id = decodeURIComponent(parts[1]);
      if (m === 'PATCH' && parts.length === 2) return this.send(res, 200, { order: await this.patch(id, await this.body(req)) });
      if (m === 'DELETE' && parts.length === 2) { await this.remove(id); return this.send(res, 200, { success: true }); }
      if (m === 'POST' && parts[2] === 'retry') { await this.retry(id); return this.send(res, 200, { success: true }); }
      if (m === 'POST' && parts[2] === 'repolish') { await this.repolish(id); return this.send(res, 200, { success: true }); }
    }
    this.send(res, 404, { success: false, error: 'not found' });
  }
}

export type { OrderPayload };
