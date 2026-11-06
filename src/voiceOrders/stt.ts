/**
 * Resident Whisper worker. The model loads once in scripts/voice_orders_stt.py
 * and requests flow over stdin/stdout as JSON lines, so each hotkey recording
 * costs only decode time, not model load time.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import type { Glossary } from './glossary.js';

export type SttResult = { ok: true; text: string } | { ok: false; error: string };

type Pending = { resolve: (r: SttResult) => void; timer: NodeJS.Timeout };

export class SttWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private readonly timeoutMs: number;

  constructor(private readonly opts: { pythonBin: string; scriptPath: string; glossary: Glossary; timeoutMs?: number; startTimeoutMs?: number }) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  get running(): boolean { return this.proc !== null; }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    const proc = spawn(this.opts.pythonBin, [this.opts.scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    proc.stdin.on('error', () => { /* EPIPE when the worker died; exit handler reports it */ });

    this.ready = new Promise<void>((resolve, reject) => {
      const startTimer = setTimeout(() => {
        reject(new Error('stt worker did not become ready'));
        this.discard(proc, 'stt worker did not become ready');
      }, this.opts.startTimeoutMs ?? 120_000);
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) { clearTimeout(startTimer); resolve(); return; }
        const p = this.pending.get(String(msg.id));
        if (!p) return;
        this.pending.delete(String(msg.id));
        clearTimeout(p.timer);
        if (msg.ok) p.resolve({ ok: true, text: this.opts.glossary.apply(String(msg.text ?? '')).trim() });
        else p.resolve({ ok: false, error: String(msg.error ?? 'stt failed') });
      });
      const onGone = (why: string) => {
        clearTimeout(startTimer);
        if (this.proc !== proc) return;
        this.proc = null;
        this.ready = null;
        const err = `stt worker exited (${why})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`;
        reject(new Error(err));
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: err }); this.pending.delete(id); }
      };
      proc.on('exit', (code, sig) => onGone(`code ${code ?? sig}`));
      proc.on('error', (e) => onGone(e.message));
    });
    this.ready.catch(() => { /* surfaced via transcribe */ });
    return this.ready;
  }

  async transcribe(wavPath: string): Promise<SttResult> {
    try {
      await this.start();
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
    const proc = this.proc;
    if (!proc) return { ok: false, error: 'stt worker not running' };
    const id = String(++this.seq);
    return new Promise<SttResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `stt timed out after ${this.timeoutMs}ms` });
        // The worker decodes one request at a time; a hung decode blocks every later one.
        this.discard(proc, `stt worker restarted after a ${this.timeoutMs}ms timeout`);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      const prompt = this.opts.glossary.promptTerms().join(', ');
      proc.stdin.write(JSON.stringify({ id, wav: wavPath, prompt }) + '\n');
    });
  }

  /** Drop a stuck worker now so the next call starts a fresh one. */
  private discard(proc: ChildProcessWithoutNullStreams, why: string): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.ready = null;
    for (const [, x] of this.pending) { clearTimeout(x.timer); x.resolve({ ok: false, error: why }); }
    this.pending.clear();
    proc.kill('SIGKILL');
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    this.ready = null;
    for (const [, x] of this.pending) { clearTimeout(x.timer); x.resolve({ ok: false, error: 'stt worker stopped' }); }
    this.pending.clear();
    p?.kill();
  }
}
