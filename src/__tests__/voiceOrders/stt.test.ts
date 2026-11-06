import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SttWorker } from '../../voiceOrders/stt.js';
import { Glossary } from '../../voiceOrders/glossary.js';

/** Fake worker speaking the same JSONL protocol. The wav path selects behavior. */
const FAKE = `
const rl = require('readline').createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
rl.on('line', (line) => {
  const req = JSON.parse(line);
  const reply = (text, delay) => setTimeout(() => process.stdout.write(JSON.stringify({ id: req.id, ok: true, text }) + '\\n'), delay);
  if (req.wav === 'slow') reply('느림', 200);
  else if (req.wav === 'fast') reply('빠름', 10);
  else if (req.wav === 'hang') { for (;;) {} }
  else if (req.wav === 'die') process.exit(1);
  else if (req.wav === 'fail') process.stdout.write(JSON.stringify({ id: req.id, ok: false, text: '', error: 'boom' }) + '\\n');
  else if (req.wav === 'prompt') reply(req.prompt, 0);
  else reply(req.wav, 0);
});
`;

let dir: string;
let glossary: Glossary;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vo-stt-'));
  writeFileSync(join(dir, 'fake.cjs'), FAKE);
  writeFileSync(join(dir, 'g.json'), JSON.stringify({ 'AKS.7': ['에이케이에스 세븐'], 쿠엔: ['코엔'] }));
  glossary = await Glossary.load(join(dir, 'g.json'));
});

const make = (timeoutMs = 2000) =>
  new SttWorker({ pythonBin: process.execPath, scriptPath: join(dir, 'fake.cjs'), glossary, timeoutMs });

describe('SttWorker', () => {
  let w: SttWorker;
  afterEach(() => w?.stop());

  test('concurrent requests are matched by id', async () => {
    w = make();
    await w.start();
    const [a, b] = await Promise.all([w.transcribe('slow'), w.transcribe('fast')]);
    expect(a).toEqual({ ok: true, text: '느림' });
    expect(b).toEqual({ ok: true, text: '빠름' });
  });

  test('no reply -> timeout error', async () => {
    w = make(300);
    await w.start();
    const r = await w.transcribe('hang');
    expect(r.ok).toBe(false);
  });

  test('glossary applied to result', async () => {
    w = make();
    const r = await w.transcribe('에이케이에스 세븐 주웠다');
    expect(r).toEqual({ ok: true, text: 'AKS.7 주웠다' });
  });

  test('terms are sent as the whisper prompt', async () => {
    w = make();
    const r = await w.transcribe('prompt');
    expect(r.ok && r.text).toContain('AKS.7');
    expect(r.ok && r.text).toContain('쿠엔');
  });

  test('worker error passes through', async () => {
    w = make();
    expect(await w.transcribe('fail')).toEqual({ ok: false, error: 'boom' });
  });

  test('dead worker is restarted on next call', async () => {
    w = make();
    const r1 = await w.transcribe('die');
    expect(r1.ok).toBe(false);
    const r2 = await w.transcribe('살아남');
    expect(r2).toEqual({ ok: true, text: '살아남' });
  });

  test('a hung request kills the worker so the next request gets a fresh one', async () => {
    w = make(300);
    expect((await w.transcribe('hang')).ok).toBe(false);
    expect(await w.transcribe('다음')).toEqual({ ok: true, text: '다음' });
  });

  test('a start that never becomes ready is retried on the next call', async () => {
    const slow = join(dir, 'slow-start.cjs');
    const flag = join(dir, 'started-once');
    writeFileSync(slow, `
      const fs = require('fs');
      const first = !fs.existsSync(${JSON.stringify(flag)});
      fs.writeFileSync(${JSON.stringify(flag)}, '1');
      if (first) { setInterval(() => {}, 1000); }
      else {
        process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
        require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
          const r = JSON.parse(l); process.stdout.write(JSON.stringify({ id: r.id, ok: true, text: 'ok' }) + '\\n');
        });
      }`);
    w = new SttWorker({ pythonBin: process.execPath, scriptPath: slow, glossary, timeoutMs: 1000, startTimeoutMs: 300 });
    const first = await w.transcribe('x');
    expect(first.ok).toBe(false);
    expect(await w.transcribe('x')).toEqual({ ok: true, text: 'ok' });
  });

  test('whitespace-only text becomes empty string', async () => {
    w = make();
    expect(await w.transcribe('   ')).toEqual({ ok: true, text: '' });
  });
});
