/**
 * Unit tests for PremiereProPrompts — the cut-edit specialist ships one prompt,
 * cut_edit_workflow, which encodes the reviewed+verified workflow.
 */

import { PremiereProPrompts } from '../../prompts/index.js';

describe('PremiereProPrompts', () => {
  let prompts: PremiereProPrompts;

  beforeEach(() => {
    prompts = new PremiereProPrompts();
  });

  describe('getAvailablePrompts()', () => {
    it('returns the cut_edit_workflow prompt', () => {
      const available = prompts.getAvailablePrompts();
      expect(Array.isArray(available)).toBe(true);
      expect(available.map((p) => p.name)).toContain('cut_edit_workflow');
    });

    it('every prompt has a name, description, and well-formed arguments', () => {
      for (const p of prompts.getAvailablePrompts()) {
        expect(typeof p.name).toBe('string');
        expect(p.name.length).toBeGreaterThan(0);
        expect(typeof p.description).toBe('string');
        expect(p.description.length).toBeGreaterThan(0);
        if (p.arguments) {
          for (const a of p.arguments) {
            expect(typeof a.name).toBe('string');
            expect(typeof a.description).toBe('string');
          }
        }
      }
    });
  });

  describe('getPrompt()', () => {
    it('generates the workflow with an approval gate and a verify gate', async () => {
      const g = await prompts.getPrompt('cut_edit_workflow', {});
      expect(g.messages.length).toBeGreaterThan(0);
      const text = g.messages.map((m) => m.content.text).join('\n');
      expect(text).toMatch(/approv/i);
      expect(text).toMatch(/verif/i);
      expect(text).toContain('analyze_sequence_cuts');
      expect(text).toContain('apply_sequence_cuts');
      expect(text).toMatch(/demo|freeze|frameChecks/i);
    });

    it('threads sequence_id and language into the guidance', async () => {
      const g = await prompts.getPrompt('cut_edit_workflow', { sequence_id: 'SEQ123', language: 'en' });
      const text = g.messages.map((m) => m.content.text).join('\n');
      expect(text).toContain('SEQ123');
      expect(text).toContain('en');
    });

    it('distinguishes safe vs tight aggressiveness', async () => {
      const safe = (await prompts.getPrompt('cut_edit_workflow', { aggressiveness: 'safe' }))
        .messages.map((m) => m.content.text).join('\n');
      const tight = (await prompts.getPrompt('cut_edit_workflow', { aggressiveness: 'tight' }))
        .messages.map((m) => m.content.text).join('\n');
      expect(safe).toMatch(/safe/i);
      expect(tight).toMatch(/tight/i);
    });

    it('throws for an unknown prompt', async () => {
      await expect(prompts.getPrompt('does_not_exist', {})).rejects.toThrow();
    });
  });
});
