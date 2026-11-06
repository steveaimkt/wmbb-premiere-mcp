/**
 * Anthropic API key for the daemon. launchd starts the daemon with no shell env, so the key
 * lives in the login keychain (generic password, service below). The user stores it once with
 *   security add-generic-password -U -s wmbb-voice-orders -a anthropic -w
 * which prompts for the value — it never passes through a file, a log or this process's argv.
 */
import { execFileSync } from 'child_process';

export const KEYCHAIN_SERVICE = 'wmbb-voice-orders';

export type KeyLookup = { key: string | null; source: 'env' | 'keychain' | null };

export function resolveApiKey(
  env: Record<string, string | undefined>,
  readKeychain: (service: string) => string | null,
): KeyLookup {
  const fromEnv = env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  try {
    const k = readKeychain(KEYCHAIN_SERVICE)?.trim();
    if (k) return { key: k, source: 'keychain' };
  } catch { /* item missing or keychain locked */ }
  return { key: null, source: null };
}

export function readMacKeychain(service: string): string | null {
  return execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}
