/**
 * MCP Prompts for the Premiere cut-editing server.
 *
 * The server does two things, and ships one prompt for each:
 *
 *   1. `cut_edit_workflow`     — cut the timeline (analyze → approve → apply → verify)
 *   2. `caption_review_workflow` — caption the edit (map → project → assemble → QC)
 *
 * They are separate front doors on purpose. Captioning is run far more often than
 * cutting — every re-edit needs new captions — and it must be usable on a timeline
 * the user cut by hand in Premiere, with no cut-edit session in front of it.
 *
 * Everything else the server exposes is in service of those two.
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
      {
        name: 'caption_review_workflow',
        description: 'Caption an edited sequence without transcribing it again: read each clip\'s source in/out to rebuild the source→timeline map, re-project an existing word-level transcript onto it, assemble readable cues, fix recognition errors, QC. Frame-accurate after any number of re-edits. Works on a timeline cut by hand in Premiere.',
        arguments: [
          { name: 'sequence_id', description: 'Sequence to caption. Omit to use the active sequence.', required: false },
          { name: 'media_path', description: 'Source media file. Omit to resolve it from the timeline clips.', required: false },
          { name: 'language', description: 'Spoken language code (e.g. "en", "ko"). Default "ko".', required: false },
          { name: 'max_chars', description: 'Characters per cue. Default 20 (single-line Korean).', required: false },
          { name: 'lines', description: 'Lines per cue: "1" (default) or "2".', required: false },
        ],
      },
    ];
  }

  async getPrompt(name: string, args: Record<string, any>): Promise<GeneratedPrompt> {
    this.logger.info(`Generating prompt: ${name}`);
    switch (name) {
      case 'cut_edit_workflow':
        return this.cutEditWorkflowPrompt(args);
      case 'caption_review_workflow':
        return this.captionReviewWorkflowPrompt(args);
      default:
        throw new Error(`Prompt '${name}' not found`);
    }
  }

  private captionReviewWorkflowPrompt(args: Record<string, any>): GeneratedPrompt {
    const seq = args.sequence_id ? `sequence "${args.sequence_id}"` : 'the active sequence';
    const seqArg = args.sequence_id ? ` with sequenceId "${args.sequence_id}"` : '';
    const language = args.language || 'ko';
    const maxChars = Number(args.max_chars) > 0 ? Number(args.max_chars) : 20;
    const lines = String(args.lines || '1') === '2' ? 2 : 1;

    const text = `You are captioning ${seq} with this Premiere MCP. The timeline may have been cut by these tools or by hand — it does not matter. What matters is that the captions land frame-accurate on the edit that exists right now.

## The one rule
**Do not transcribe the edited timeline.** Transcribe the source once, then re-project those word timestamps through the edit. Re-transcribing a cut is slower, loses every correction you made, and measurably degrades quality (observed: correct terms turning into nonsense, sentences truncated mid-clause). The map is arithmetic — use it.

## Step 1 — Rebuild the source → timeline map (STOP if this fails)
Call \`list_sequence_tracks\`${seqArg} with \`includeSourceTimes: true\`. Every clip comes back with its timeline position AND its source \`inPoint\`/\`outPoint\`. Walk the populated video track in order and build:

    regions = [(src_in, src_out, timeline_start), ...]   # in frames, round(t * fps)
    assert abs(sum(src_out - src_in) / fps - verify.measuredEndSec) < 0.001

**If that assertion fails, stop and report.** A wrong map produces captions that look fine and are silently misaligned.

Also read \`verify\` before going further:
- \`contiguous: false\` / \`gapCount > 0\` → the timeline has a hole. Report it; do not caption it.
- \`avParity: false\` → V/A mismatch. Ask the user to check sync first.
- Judge length by \`verify.measuredEndSec\`, never by \`list_sequences\`.duration — that value is stale mid-edit.
- If the user is editing in Premiere right now, values can be transient. If something looks wrong, read once more before concluding.

## Step 2 — Get the transcript (once)
If a prior \`analyze_speech_edit_points\` run exists for this media, reuse it. Otherwise run it once on the SOURCE media with language "${language}" and model "small" or higher (weaker models drop opening seconds). Never run it on the edited timeline.

## Step 3 — Project segments onto the timeline
For each source segment, intersect it with the regions and map it forward. Two failure modes to handle explicitly:
- **Boundary ghosts** — a segment clipped to under ~0.35s (or under 40% of itself) is not audible in the cut. Drop it, or you caption words the viewer never hears.
- **Duplicate emission** — a segment straddling two adjacent regions must be merged into one cue. But when the same source is used twice (a cold open quoting a later moment), the two placements are separate and both get captions. Cluster by timeline adjacency, not by region.

## Step 4 — Assemble cues
Target: **${lines} line${lines > 1 ? 's' : ''}, max ${maxChars} characters, no gap between cues** (each cue ends exactly where the next begins, so the caption never flickers off between lines).

Do not break a sentence across cues carelessly. Merge tokens that cannot start a cue (grammatical tails such as quotatives and connective endings) into the preceding token, and push tokens that cannot end a cue (conjunctions, adverbs, fillers) into the following one — before packing to the character limit. Prefer breaking at sentence ends.

## Step 5 — Fix recognition errors
Apply a correction glossary for names, product terms and jargon the recogniser mangles. Apply it **twice**: once per token, and again after cues are merged — a phrase split across two tokens will not match the first time, and a phrase broken by a line wrap will not match the second.

**Do not guess.** Proper nouns and figures you cannot verify stay as-is; list them for the user to confirm. A confident wrong substitution is worse than a visible unknown.

## Step 6 — QC (every count must be zero)
Overlaps · reversed timings · zero-length cues · cues past \`verify.measuredEndSec\` · gaps between cues · cues exceeding the line/character limit · glossary terms still unfixed.

Then read the caption text across each cut point and check the sentences still join naturally.

## Step 7 — Deliver
Write the .srt next to the project file, named for the project and the measured length. Delete superseded caption files — two subtitle files of different lengths in one folder will eventually be used on the wrong cut.

Report: cue count, time range vs \`verify.measuredEndSec\`, corrections applied by kind, and anything you deliberately left unresolved.`;

    return {
      description: 'Caption an edited Premiere sequence by re-projecting an existing transcript — no re-transcription.',
      messages: [{ role: 'user', content: { type: 'text', text } }],
    };
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

## Step 5 — Hand off to captions
If the user wants subtitles, do NOT re-transcribe the cut and do not export the sequence to caption it. Run the \`caption_review_workflow\` prompt instead: it rebuilds the source→timeline map from the clips' source in/out and re-projects the transcript you already made in Step 1, so the captions are frame-accurate and cost nothing extra.

Never skip the approval in Step 2 or the verification in Step 4. Those two gates are what make the cut trustworthy.`;

    return {
      description: 'Reviewed, verified cut-edit workflow for a Premiere sequence.',
      messages: [{ role: 'user', content: { type: 'text', text } }],
    };
  }
}
