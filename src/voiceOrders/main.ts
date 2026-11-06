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
import { glossaryPath, projectDir, settingsPath } from './paths.js';
import { BridgePremierePort } from './premiere.js';
import { OrderStore } from './store.js';
import { SttWorker } from './stt.js';
import { DEFAULT_SETTINGS, type Settings } from './types.js';

export const DAEMON_PORT = 47613;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(): Promise<void> {
  const saved = await readJsonOr<Partial<Settings>>(settingsPath(), {});
  const settings: Settings = { ...DEFAULT_SETTINGS, ...saved, zoomDefaults: { ...DEFAULT_SETTINGS.zoomDefaults, ...(saved.zoomDefaults ?? {}) } };
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

  const stores = new Map<string, Promise<OrderStore>>();
  const daemon = new VoiceOrdersDaemon({
    premiere: new BridgePremierePort(bridge, tools, () => settings),
    stt,
    interpreter: new Interpreter({ client: new Anthropic(), model: settings.model, glossary }),
    storeFor: (p) => {
      if (!stores.has(p)) stores.set(p, OrderStore.load(projectDir(p)));
      return stores.get(p)!;
    },
    settings,
    glossary,
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
