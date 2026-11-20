#!/usr/bin/env node
/**
 * Entry point: `npm run voice-orders`. Wires the real bridge, Whisper worker
 * and Claude client into the daemon and listens on 127.0.0.1:47613.
 * The bridge must use the same PREMIERE_TEMP_DIR as the CEP "MCP Bridge" panel.
 */
import Anthropic from '@anthropic-ai/sdk';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PremiereProBridge } from '../bridge/index.js';
import { PremiereProTools } from '../tools/index.js';
import { VoiceOrdersDaemon } from './daemon.js';
import { readJsonOr } from './fsutil.js';
import { Glossary } from './glossary.js';
import { Interpreter } from './interpreter.js';
import { glossaryPath, projectDir, settingsPath, tokenPath } from './paths.js';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { BridgePremierePort } from './premiere.js';
import { KEYCHAIN_SERVICE, readMacKeychain, resolveApiKey } from './apiKey.js';
import { OrderStore } from './store.js';
import { SttWorker } from './stt.js';
import { DEFAULT_SETTINGS, type Settings } from './types.js';

export const DAEMON_PORT = 47613;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Owner-only token file shared with the hotkey helper and the review panel. */
async function loadToken(): Promise<string> {
  const file = tokenPath();
  try {
    const t = (await fs.readFile(file, 'utf8')).trim();
    if (t) { await fs.chmod(file, 0o600); return t; }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  const t = randomBytes(24).toString('hex');
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, t, { mode: 0o600 });
  return t;
}

async function main(): Promise<void> {
  const saved = await readJsonOr<Partial<Settings>>(settingsPath(), {});
  const settings: Settings = { ...DEFAULT_SETTINGS, ...saved, zoomDefaults: { ...DEFAULT_SETTINGS.zoomDefaults, ...(saved.zoomDefaults ?? {}) } };
  // Bundled AE template (the Premiere-authored 1말하는자막.mogrt cannot have its text set from script).
  if (!settings.captionTemplatePath) settings.captionTemplatePath = join(repoRoot, 'cep-plugin', 'assets', 'voice-orders-caption.mogrt');
  const glossary = await Glossary.load(glossaryPath());

  const bridge = new PremiereProBridge();
  await bridge.initialize();
  const tools = new PremiereProTools(bridge);

  const stt = new SttWorker({
    pythonBin: process.env.PYTHON_PATH || 'python3',
    scriptPath: join(repoRoot, 'scripts', 'voice_orders_stt.py'),
    glossary,
  });
  stt.start().catch((e) => console.error('[voice-orders] stt worker failed to start:', e.message));

  // launchd gives no shell env: the key comes from the login keychain (see apiKey.ts).
  const apiKey = resolveApiKey(process.env, readMacKeychain);
  if (!apiKey.key) {
    console.error(`[voice-orders] no Anthropic API key — orders stay unpolished. Store one with:\n  security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a anthropic -w`);
  } else console.log(`[voice-orders] API key from ${apiKey.source}`);

  const stores = new Map<string, Promise<OrderStore>>();
  const daemon = new VoiceOrdersDaemon({
    premiere: new BridgePremierePort(bridge, tools, () => settings),
    stt,
    interpreter: new Interpreter({ client: new Anthropic({ apiKey: apiKey.key ?? 'missing-api-key' }), model: settings.model, glossary }),
    storeFor: (p) => {
      if (!stores.has(p)) stores.set(p, OrderStore.load(projectDir(p)));
      return stores.get(p)!;
    },
    settings,
    glossary,
    token: await loadToken(),
  });
  const port = await daemon.listen(Number(process.env.VOICE_ORDERS_PORT || DAEMON_PORT));
  console.log(`[voice-orders] listening on http://127.0.0.1:${port} (model ${settings.model})`);

  const shutdown = () => { stt.stop(); daemon.close().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[voice-orders] fatal:', e);
  process.exit(1);
});
