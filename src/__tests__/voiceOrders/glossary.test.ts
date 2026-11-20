import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Glossary } from '../../voiceOrders/glossary.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'vo-gloss-'));

describe('Glossary', () => {
  test('apply replaces heard forms with the term', async () => {
    const f = join(tmp(), 'g.json');
    writeFileSync(f, JSON.stringify({ 'AKS.7': ['에이케이에스 세븐', '에이케이 세븐'] }));
    const g = await Glossary.load(f);
    expect(g.apply('에이케이에스 세븐 주웠다')).toBe('AKS.7 주웠다');
    expect(g.apply('에이케이 세븐 주웠다')).toBe('AKS.7 주웠다');
  });

  test('longer heard forms win over shorter prefixes', async () => {
    const f = join(tmp(), 'g.json');
    writeFileSync(f, JSON.stringify({ AK: ['에이케이'], 'AKS.7': ['에이케이에스 세븐'] }));
    const g = await Glossary.load(f);
    expect(g.apply('에이케이에스 세븐')).toBe('AKS.7');
  });

  test('add persists to file', async () => {
    const f = join(tmp(), 'g.json');
    const g = await Glossary.load(f);
    await g.add('쿠엔', '코엔');
    const again = await Glossary.load(f);
    expect(again.apply('코엔 나왔다')).toBe('쿠엔 나왔다');
    expect(again.promptTerms()).toEqual(['쿠엔']);
  });

  test('missing file is an empty glossary', async () => {
    const g = await Glossary.load(join(tmp(), 'none.json'));
    expect(g.apply('그대로')).toBe('그대로');
    expect(g.promptTerms()).toEqual([]);
    expect(typeof g.asPromptBlock()).toBe('string');
  });

  test('asPromptBlock lists terms with heard forms deterministically', async () => {
    const f = join(tmp(), 'g.json');
    writeFileSync(f, JSON.stringify({ 'AKS.7': ['에이케이 세븐'], 쿠엔: ['코엔'] }));
    const g = await Glossary.load(f);
    const b = g.asPromptBlock();
    expect(b).toContain('AKS.7');
    expect(b).toContain('에이케이 세븐');
    expect(b).toBe((await Glossary.load(f)).asPromptBlock());
  });
});
