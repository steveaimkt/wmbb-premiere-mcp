import { resolveApiKey, KEYCHAIN_SERVICE } from '../../voiceOrders/apiKey.js';

describe('resolveApiKey', () => {
  test('env wins over the keychain', () => {
    expect(resolveApiKey({ ANTHROPIC_API_KEY: 'sk-ant-env' }, () => 'sk-ant-kc')).toEqual({ key: 'sk-ant-env', source: 'env' });
  });
  test('falls back to the keychain item (launchd has no env key)', () => {
    let asked = '';
    const r = resolveApiKey({}, (svc) => { asked = svc; return 'sk-ant-kc\n'; });
    expect(r).toEqual({ key: 'sk-ant-kc', source: 'keychain' });
    expect(asked).toBe(KEYCHAIN_SERVICE);
  });
  test('nothing anywhere → null', () => {
    expect(resolveApiKey({}, () => null)).toEqual({ key: null, source: null });
  });
  test('a keychain read that throws is treated as missing', () => {
    expect(resolveApiKey({}, () => { throw new Error('not found'); })).toEqual({ key: null, source: null });
  });
});
