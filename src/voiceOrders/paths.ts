import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';

/** ~/Library/Application Support/wmbb-premiere-mcp/voice-orders (override: VOICE_ORDERS_HOME). */
export function voiceOrdersRoot(): string {
  return process.env.VOICE_ORDERS_HOME
    || join(homedir(), 'Library', 'Application Support', 'wmbb-premiere-mcp', 'voice-orders');
}

/** Per-project directory, keyed by sha1 of the .prproj path. */
export function projectDir(projectPath: string): string {
  const key = createHash('sha1').update(projectPath).digest('hex');
  return join(voiceOrdersRoot(), 'projects', key);
}

export function glossaryPath(): string { return join(voiceOrdersRoot(), 'glossary.json'); }
export function settingsPath(): string { return join(voiceOrdersRoot(), 'settings.json'); }
export function recordingsDir(projectPath: string): string { return join(projectDir(projectPath), 'recordings'); }
