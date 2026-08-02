/**
 * MCP Prompts for the Premiere cut-editing server.
 *
 * One prompt ships with the server: `cut_edit_workflow`. It is the distributable
 * front door — any MCP client that installs this server gets the whole reviewed,
 * verified cut-edit workflow as a first-class prompt, no local skill required.
 *
 * The server is a cut-edit specialist, so the prompt surface is deliberately
 * narrow: it encodes the one workflow the tools are built for, with the safety
 * rules that keep a cut trustworthy.
 */

import { Logger } from '../utils/logger.js';

export interface MCPPrompt {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
}

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: {
    type: 'text';
    text: string;
  };
}

export interface GeneratedPrompt {
  description: string;
  messages: PromptMessage[];
}

export class PremiereProPrompts {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('PremiereProPrompts');
  }

  getAvailablePrompts(): MCPPrompt[] {
    return [
      {
        name: 'cut_edit_workflow',
        description: 'Reviewed, verified cut edit of a Premiere sequence: analyze speech + screen → present categorized cut proposals → you approve → apply with backup → verify by re-query. Removes silences and repeated takes; protects hooks and live demos.',
        arguments: [
          { name: 'sequence_id', description: 'Sequence to edit. Omit to use the active sequence.', required: false },
          { name: 'language', description: 'Spoken language code (e.g. "en", "ko"). Default "ko".', required: false },
          { name: 'aggressiveness', description: '"safe" (default — cut only recommended groups) or "tight" (also offer static long gaps).', required: false },
        ],
      },
    ];
  }

  async getPrompt(name: string, args: Record<string, any>): Promise<GeneratedPrompt> {
    this.logger.info(`Generating prompt: ${name}`);
    switch (name) {
      case 'cut_edit_workflow':
        return this.cutEditWorkflowPrompt(args);
      default:
        throw new Error(`Prompt '${name}' not found`);
    }
  }

  private cutEditWorkflowPrompt(args: Record<string, any>): GeneratedPrompt {
    const seq = args.sequence_id ? `sequence "${args.sequence_id}"` : 'the active sequence';
    const language = args.language || 'ko';
    const aggressiveness = (args.aggressiveness || 'safe').toLowerCase();

    const text = `You are running a cut edit on ${seq} with this Premiere cut-editing MCP. The goal is a tight, trustworthy cut: remove dead air and repeated takes, and NEVER cut a hook or a live on-screen demo. Follow these steps in order and STOP for approval before anything destructive.

## The one rule
A wrong cut costs more than a missed one. Prefer under-cutting to over-cutting. \`success:true\` from a tool means the call was accepted, not that the edit is right — the plan is judged by review and the result by re-query.

## Step 1 — Analyze (read-only)
Call \`analyze_sequence_cuts\`${args.sequence_id ? ` with sequenceId "${args.sequence_id}"` : ''} and language "${language}". It resolves the media, transcribes the speech (word-level), returns categorized \`proposals\`, and runs a freeze check on long gaps (\`frameChecks\`: static = frozen screen, active = live demo).
- If \`warnings\` mentions a weak model dropping the opening, re-run with model "small" or higher before trusting anything.

## Step 2 — Present the plan for approval (STOP here)
Show the user a compact table, grouped by category, never one flat list:
- **duplicates / retakes** (recommended): the earlier take of a repeated line/paragraph.
- **pauses** (recommended): short inter-sentence silences.
- **intro / outro** (held back): margins before the first / after the last word — cutting these is an editorial call; ask, don't assume.
- **longGaps** (held back): for each, show the \`frameChecks\` verdict — **static** gaps are dead air you may offer to cut; **active** gaps are demos, keep them; **ambiguous/unknown** ones, export a frame with \`export_frame\` and look before deciding.
Give the total seconds and the resulting length. Then ask which categories to cut.
${aggressiveness === 'tight' ? '- Aggressiveness "tight": also propose the STATIC longGaps for cutting (still ask).' : '- Aggressiveness "safe": recommend only duplicates + pauses; leave longGaps for the user to opt into.'}

## Step 3 — Apply (destructive, backed up)
For the approved spans only, call \`apply_sequence_cuts\`${args.sequence_id ? ` with sequenceId "${args.sequence_id}"` : ''}. It backs up the sequence, ripple-deletes A/V-linked right-to-left, then re-queries the timeline.
- Pass \`sourceTimes:true\` with \`sourceMediaPath\` if the spans are source-clip times on an untrimmed clip (the analyze output says which).

## Step 4 — Verify (stop on drift)
Read the apply result's measured \`afterSec\` vs \`expectedSec\`.
- \`verified:true\` (drift ≤ 2s): report done — before/after length, what was cut per category, backup name.
- \`verified:false\`: STOP. Report the numbers and that the backup is intact. Do not retry or auto-fix.

## Step 5 — Captions (optional)
If the user wants subtitles for the cut, call \`export_captions\` on the exported cut (caption times follow the media, so re-export after cutting).

Never skip the approval in Step 2 or the verification in Step 4. Those two gates are what make the cut trustworthy.`;

    return {
      description: 'Reviewed, verified cut-edit workflow for a Premiere sequence.',
      messages: [{ role: 'user', content: { type: 'text', text } }],
    };
  }
}
