/**
 * Unit tests for PremiereProPrompts — the server ships one prompt per capability:
 * cut_edit_workflow (reviewed + verified cutting) and caption_review_workflow
 * (caption an edit by re-projecting an existing transcript).
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

    it('ships exactly the two capability prompts', () => {
      const names = prompts.getAvailablePrompts().map((p) => p.name).sort();
      expect(names).toEqual(['caption_review_workflow', 'cut_edit_workflow']);
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

  describe('caption_review_workflow', () => {
    const textOf = async (args: Record<string, any> = {}) =>
      (await prompts.getPrompt('caption_review_workflow', args)).messages[0].content.text;

    it('forbids re-transcribing the cut and names the map source', async () => {
      const text = await textOf();
      expect(text).toMatch(/Do not transcribe the edited timeline/i);
      expect(text).toContain('includeSourceTimes');
      expect(text).toContain('inPoint');
    });

    it('makes the map assertion a hard stop', async () => {
      const text = await textOf();
      expect(text).toMatch(/assert/i);
      expect(text).toMatch(/stop and report/i);
    });

    it('routes length judgement away from list_sequences.duration', async () => {
      const text = await textOf();
      expect(text).toContain('verify.measuredEndSec');
      expect(text).toMatch(/never by .?list_sequences/i);
    });

    it('covers the two projection failure modes', async () => {
      const text = await textOf();
      expect(text).toMatch(/Boundary ghosts/i);
      expect(text).toMatch(/Duplicate emission/i);
    });

    it('requires the glossary pass to run twice', async () => {
      const text = await textOf();
      expect(text).toMatch(/Apply it \*\*twice\*\*/i);
      expect(text).toMatch(/Do not guess/i);
    });

    it('threads sequence_id, language and cue shape into the guidance', async () => {
      const text = await textOf({ sequence_id: 'seq-42', language: 'en', max_chars: 32, lines: '2' });
      expect(text).toContain('seq-42');
      expect(text).toContain('"en"');
      expect(text).toContain('32 characters');
      expect(text).toContain('2 lines');
    });

    it('defaults to single-line 20-character Korean cues', async () => {
      const text = await textOf();
      expect(text).toContain('1 line,');
      expect(text).toContain('20 characters');
      expect(text).toContain('"ko"');
    });
  });
});
