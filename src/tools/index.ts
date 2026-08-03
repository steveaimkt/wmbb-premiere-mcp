/**
 * MCP Tools for Adobe Premiere Pro
 * 
 * This module provides tools that can be called by AI agents to perform
 * various video editing operations in Adobe Premiere Pro.
 */

import { z } from 'zod';
import type { PremiereProTransport } from '../bridge/types.js';
import { Logger } from '../utils/logger.js';
import { analyzeSpeechEditPoints } from '../utils/speechAnalysis.js';
import { detectFreeze } from '../utils/freezeDetect.js';
import { buildCues, serializeCues } from '../utils/captions.js';
import { findTextSpans, DEFAULT_FILLERS } from '../utils/cutEditing.js';
import { transcribeAudio } from '../utils/whisperRunner.js';
import { proofreadTranscript } from '../utils/proofread.js';
import { writeFileSync } from 'fs';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<any>;
}

/**
 * Every Unicode spelling a filesystem path might take, so a path can be compared
 * inside ExtendScript (which has no String.normalize).
 *
 * macOS stores filenames NFD-decomposed. A caller almost always supplies NFC —
 * that is what typing, JSON, and copy-paste produce. For ASCII paths the two are
 * identical, but "안티그래비티" in NFC and NFD differ byte for byte, so an exact
 * string compare against getMediaPath() fails on any non-ASCII path.
 */
export function pathVariants(p: string): string[] {
  if (!p) return [];
  const seen = new Set<string>([p]);
  for (const form of ['NFC', 'NFD'] as const) {
    try {
      seen.add(p.normalize(form));
    } catch {
      // A malformed string is not worth failing the whole call over.
    }
  }
  return Array.from(seen);
}











export class PremiereProTools {
  private bridge: PremiereProTransport;
  private logger: Logger;

  constructor(bridge: PremiereProTransport) {
    this.bridge = bridge;
    this.logger = new Logger('PremiereProTools');
  }

  getAvailableTools(): MCPTool[] {
    return [
      // Discovery Tools (NEW)
      {
        name: 'list_project_items',
        description: 'Lists all media items, bins, and assets in the current Premiere Pro project. Use this to discover available media before performing operations.',
        inputSchema: z.object({
          includeBins: z.boolean().optional().describe('Whether to include bin information in the results'),
          includeMetadata: z.boolean().optional().describe('Whether to include detailed metadata for each item')
        })
      },
      {
        name: 'list_sequences',
        description: 'Lists all sequences in the current Premiere Pro project with their IDs, names, and basic properties.',
        inputSchema: z.object({})
      },
      {
        name: 'list_sequence_tracks',
        description: 'Lists the tracks of a sequence with every clip, and — this is the part that matters for rebuilding an edit — each clip\'s SOURCE in/out points alongside its timeline position. That pairing is the whole source→timeline map, so captions can be re-derived from an existing transcript without transcribing again. Also returns `verify`: measured length, per-track gaps, and V/A clip parity. `verify` is the authority on what the timeline actually contains — `list_sequences`.duration reports a stale value mid-edit and must not be used to judge a cut. Use compact:true on long timelines to get `verify` plus first/last clips only, which keeps a several-hundred-clip sequence inside the token budget.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to list tracks for'),
          includeSourceTimes: z.boolean().optional().describe('Include each clip\'s source inPoint/outPoint. Default true — this is what makes the response a source→timeline map.'),
          compact: z.boolean().optional().describe('Return `verify` plus only the first/last clip of each track. Use on timelines with hundreds of clips. Default false.')
        })
      },
      {
        name: 'insert_clip',
        description: 'Places a span of a project item onto a sequence track — the operation the other tools cannot do, since they only remove, razor and trim. Use it for a cold open, for restoring a section that was cut too aggressively, or for B-roll. mode:"insert" ripples everything after the insert point to the right (nothing is overwritten); mode:"overwrite" replaces what is already there. Video and its linked audio are placed together by default. Returns the re-queried timeline (same `verify` block as list_sequence_tracks) so the result is judged from measured state, not from the call returning.',
        inputSchema: z.object({
          projectItemId: z.string().optional().describe('Project item to place. Defaults to the item whose media path is sourceMediaPath.'),
          sourceMediaPath: z.string().optional().describe('Media file path; the matching project item is looked up. Use instead of projectItemId.'),
          sourceIn: z.number().describe('Source in-point in seconds.'),
          sourceOut: z.number().describe('Source out-point in seconds.'),
          timelineAt: z.number().describe('Timeline position in seconds where the span is placed.'),
          mode: z.enum(['insert', 'overwrite']).optional().describe('"insert" ripples later clips right (default). "overwrite" replaces in place.'),
          sequenceId: z.string().optional().describe('Target sequence. Defaults to the active sequence.'),
          videoTrackIndex: z.number().optional().describe('Video track index. Default 0 (V1).'),
          audioTrackIndex: z.number().optional().describe('Audio track index. Default 0 (A1).'),
          withAudio: z.boolean().optional().describe('Place the linked audio too. Default true.')
        })
      },
      {
        name: 'get_project_info',
        description: 'Gets comprehensive information about the current project including name, path, settings, and status.',
        inputSchema: z.object({})
      },

      // Project Management
      {
        name: 'save_project',
        description: 'Saves the currently active Adobe Premiere Pro project.',
        inputSchema: z.object({})
      },

      // Media Management

      // Sequence Management
      {
        name: 'duplicate_sequence',
        description: 'Creates a copy of an existing sequence with a new name.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to duplicate'),
          newName: z.string().describe('The name for the new sequence copy')
        })
      },

      // Timeline Operations
      {
        name: 'remove_from_timeline',
        description: 'Removes a clip from the timeline. On a ripple delete the linked clip on the opposite track (audio for a video clip, video for an audio clip) is removed too, so the tracks stay aligned — pass removeLinked:false to take only the one clip. Pass sequenceId when the clip ID came from list_sequence_tracks for a non-active sequence.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip on the timeline to remove'),
          sequenceId: z.string().optional().describe('Optional sequence ID to search. If omitted, searches the active sequence first, then all sequences.'),
          deleteMode: z.enum(['ripple', 'lift']).optional().describe('Whether to ripple delete (close gap) or lift (leave gap)'),
          removeLinked: z.boolean().optional().describe('Also remove the linked clip on the opposite track type so a ripple delete does not desync A/V. Default true. Only applies to ripple deletes.')
        })
      },
      {
        name: 'trim_clip',
        description: 'Adjusts the in and out points of a clip on the timeline, effectively shortening it.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip on the timeline to trim'),
          inPoint: z.number().optional().describe('The new in point in seconds from the start of the clip'),
          outPoint: z.number().optional().describe('The new out point in seconds from the start of the clip'),
          duration: z.number().optional().describe('Alternative: set the desired duration in seconds')
        })
      },
      {
        name: 'razor_timeline_at_time',
        description: 'Cuts across multiple tracks in a sequence at an absolute timeline time. If no track arrays are provided, all video and audio tracks are cut.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Optional sequence ID. Defaults to the active sequence.'),
          time: z.number().describe('Absolute timeline time in seconds where the cut should occur.'),
          videoTrackIndices: z.array(z.number().int().min(0)).optional().describe('Optional video track indices to cut. Defaults to all video tracks.'),
          audioTrackIndices: z.array(z.number().int().min(0)).optional().describe('Optional audio track indices to cut. Defaults to all audio tracks.')
        })
      },
      {
        name: 'analyze_speech_edit_points',
        description: 'Transcribes a media file with Whisper (word-level) and proposes cut-edit regions from the SPEECH CONTENT, sorted into REVIEWABLE CATEGORIES you present for approval rather than one flat list: duplicates (a flubbed take + the dead air before its retake), pauses (short inter-sentence silences), intro/outro margins, and longGaps (5s+ silences that are usually on-screen demos). Each category in `proposals` carries `recommended` and a `note`. `suggestedRemovals` is ONLY the recommended groups (pauses + duplicates + fillers) merged — intro, outro and long gaps are deliberately excluded so a demo or a hook is never auto-cut. Also returns `warnings` (e.g. a weak model that dropped the opening) and the full transcript. Prefer model "small"+ for Korean — "base" can miss the first seconds of a take and report them as a head gap. Requires Python + faster-whisper.',
        inputSchema: z.object({
          filePath: z.string().describe('Absolute path to the media file (video or audio) to analyze. Typically the mediaPath from list_project_items.'),
          model: z.string().optional().describe('Whisper model size: tiny/base/small/medium/large-v3. Default "small" (Korean-safe). "base"/"tiny" can transcribe nothing for the opening seconds and that gap then reads as intro silence (a real failure that once deleted a hook); a head-gap + weak model raises a warning.'),
          language: z.string().optional().describe('Language code (e.g. "ko", "en") or "auto" to detect. Default "ko".'),
          similarityThreshold: z.number().optional().describe('0..1 text-match to treat two takes as duplicates. Default 0.75. Lower catches looser repeats; higher only near-identical.'),
          minGapSec: z.number().optional().describe('Silence gap (seconds) between words to flag as trimmable. Default 0.6.'),
          paddingSec: z.number().optional().describe('Silence (seconds) kept at each end of a trimmed gap so the cut keeps its breath. Default 0.15. Set 0 to close gaps completely.'),
          longGapSec: z.number().optional().describe('Inner gaps at or above this go in their own "longGaps" category and are NOT recommended for cutting — they are usually on-screen demos ("실행해볼게요" then silent action). Default 5.'),
          lookbackSec: z.number().optional().describe('Seconds to look back when matching a retake to its flubbed take. Default 25 — long enough to bridge a take that breaks mid-sentence, pauses while the speaker resets the screen, and is delivered again. The removal then runs to the start of the retake, taking that dead air with it.'),
          removeFillers: z.boolean().optional().describe('Also flag filler words ("음", "uh", "um") for removal. Default false.'),
          fillerWords: z.array(z.string()).optional().describe(`Filler tokens to cut. Defaults to the unambiguous set: ${DEFAULT_FILLERS.join(', ')}. Korean single syllables like "그"/"뭐"/"이제" are excluded by default because they are also ordinary words — add them only when you know the take.`)
        })
      },
      {
        name: 'analyze_sequence_cuts',
        description: 'THE cut-edit entry point. Point it at a sequence and it does the whole plan in one call: resolves the sequence\'s media, transcribes the speech (Whisper, word-level, cached), and returns categorized cut proposals — duplicates/retakes, pauses, and the held-back intro/outro/longGaps — exactly like analyze_speech_edit_points, but keyed to the sequence instead of a file path you have to find yourself. It ALSO runs ffmpeg freezedetect on every long silent gap and tags it static (frozen screen, safe to cut) or active (a live on-screen demo, keep) so demos are protected automatically. Output is compact by default (proposals + per-gap screenState + stats, no giant word list) so it never overflows. Feed the approved spans to apply_sequence_cuts. Read-only: nothing is cut here.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Sequence to analyze. Defaults to the active sequence.'),
          mediaPath: z.string().optional().describe('Override the media file to analyze. Normally omit — it is resolved from the sequence\'s clips.'),
          model: z.string().optional().describe('Whisper model. Default "small" (Korean-safe; "base"/"tiny" drift and can miss the opening). Use "medium"/"large-v3" for English or frame-tight timing.'),
          language: z.string().optional().describe('Language code (e.g. "ko", "en") or "auto". Default "ko".'),
          minGapSec: z.number().optional().describe('Silence gap (s) between words to flag. Default 0.6.'),
          paddingSec: z.number().optional().describe('Breath kept at each end of a trimmed gap. Default 0.15.'),
          longGapSec: z.number().optional().describe('Gaps ≥ this go to the longGaps category and get a freeze check. Default 5.'),
          lookbackSec: z.number().optional().describe('Retake match window (s). Default 25.'),
          removeFillers: z.boolean().optional().describe('Also flag filler words. Default false.'),
          checkFrames: z.boolean().optional().describe('Run freezedetect on long gaps to tell demo (active) from dead air (static). Default true. Needs the media to have video.'),
          includeTranscript: z.boolean().optional().describe('Include the full word-level transcript in the response. Default false (compact — avoids token overflow).')
        })
      },
      {
        name: 'apply_sequence_cuts',
        description: 'Applies approved cut spans to a sequence, safely: duplicates the sequence as a backup, ripple-deletes the spans (right-to-left so timecodes stay valid, A/V linked so they never desync), then RE-QUERIES the timeline and reports the measured result length vs expected. This is the verified, reversible half of the workflow — success is judged from the re-queried length, not from the call returning. Pass the spans you approved from analyze_sequence_cuts. Spans are timeline seconds by default; set sourceTimes for source-clip spans. Destructive but backed up.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Sequence to cut. Defaults to the active sequence.'),
          removals: z.array(z.object({
            start: z.number().describe('Span start (timeline seconds, or source-clip seconds when sourceTimes=true).'),
            end: z.number().describe('Span end.')
          })).describe('Approved spans to remove.'),
          sourceTimes: z.boolean().optional().describe('Set true if the spans are source-clip times (from analyze_sequence_cuts on an untrimmed clip). Requires sourceMediaPath. Default false (timeline times).'),
          sourceMediaPath: z.string().optional().describe('Media file the source-time spans refer to. Required when sourceTimes=true.'),
          backup: z.boolean().optional().describe('Duplicate the sequence before cutting. Default true — leave it on.'),
          expectedDurationSec: z.number().optional().describe('Optional expected result length; the report flags if the measured length is off by more than 2s.')
        })
      },
      {
        name: 'proofread_transcript',
        description: 'Transcribes a media file with Whisper and proofreads it for typos/misrecognitions. Flags low-confidence words (likely errors), and — if a reference script path is given — deterministically corrects each segment against the script (ground truth), returning a corrected transcript ready for captions/subtitles. Requires Python + faster-whisper.',
        inputSchema: z.object({
          filePath: z.string().describe('Absolute path to the media file (video or audio) to transcribe and proofread.'),
          scriptPath: z.string().optional().describe('Optional path to a reference script/narration file (e.g. script.md). When provided, segments are corrected against it. Markdown and timecode markers are stripped automatically.'),
          model: z.string().optional().describe('Whisper model size. Default "base". Use "small"/"medium" for higher accuracy.'),
          language: z.string().optional().describe('Language code (e.g. "ko", "en") or "auto". Default "ko".'),
          confidenceThreshold: z.number().optional().describe('Words with probability below this are flagged as suspects. Default 0.6.'),
          correctionThreshold: z.number().optional().describe('Minimum text similarity to accept a script line as a correction. Default 0.6.')
        })
      },
      {
        name: 'export_captions',
        description: 'Transcribes a media file and writes a subtitle file (SRT / WebVTT / timestamped text). Whisper segments are re-cut into readable cues that respect per-line character limits and min/max on-screen duration, using word timestamps so the timings stay true to the audio. Give scriptPath to proofread against the original narration first — misrecognitions are corrected against the script before the captions are written, which is the fix for names and jargon Whisper mishears. Reuses the cached transcript, so calling this after analyze_speech_edit_points on the same file costs no extra transcription time.',
        inputSchema: z.object({
          filePath: z.string().describe('Absolute path to the media file to transcribe.'),
          outputPath: z.string().optional().describe('Where to write the subtitle file. Defaults to the media file path with the format extension.'),
          format: z.enum(['srt', 'vtt', 'txt']).optional().describe('srt (default), vtt, or txt ("(M:SS) text" per line, easy to skim next to a script).'),
          scriptPath: z.string().optional().describe('Optional reference script/narration file. When given, segments are corrected against it before captions are built. Markdown and timecode markers are stripped automatically.'),
          model: z.string().optional().describe('Whisper model size. Default "base". Use "small"/"medium" for higher accuracy.'),
          language: z.string().optional().describe('Language code (e.g. "ko", "en") or "auto". Default "ko".'),
          maxCharsPerLine: z.number().optional().describe('Character limit per displayed line. Default 20.'),
          maxLines: z.number().optional().describe('Lines per cue. Default 2.'),
          maxDurationSec: z.number().optional().describe('A cue is split once it would run longer than this. Default 6.'),
          minDurationSec: z.number().optional().describe('Shortest time a cue stays on screen. Default 1.'),
          correctionThreshold: z.number().optional().describe('Minimum similarity to accept a script line as a correction. Default 0.6.'),
          glossary: z.record(z.string()).optional().describe('Extra Hangul-to-written-form replacements, e.g. {"에이피아이":"API"}. Merged over the built-in glossary, which already covers common tech terms Whisper spells out phonetically in Korean.'),
          importToSequence: z.string().optional().describe('Sequence ID. When given, the subtitle file is imported and attached as a caption track on that sequence. SRT only.')
        })
      },
      {
        name: 'find_speech_spans',
        description: 'Finds where a phrase was spoken in a media file and returns the time spans, so you can cut by WHAT WAS SAID instead of hunting for a timecode. Matching is fuzzy, so the delivery does not have to match the wording exactly. Feed the returned spans straight to apply_timeline_removals with sourceTimes=true to delete those moments. Times are source-clip seconds. Reuses the cached transcript.',
        inputSchema: z.object({
          filePath: z.string().describe('Absolute path to the media file to search.'),
          query: z.string().describe('The phrase to find, as it was spoken.'),
          threshold: z.number().optional().describe('0..1 minimum match strength. Default 0.7. Lower finds looser paraphrases; higher demands near-exact wording.'),
          paddingSec: z.number().optional().describe('Seconds added to each end of the returned span. Default 0.05.'),
          model: z.string().optional().describe('Whisper model size. Default "base".'),
          language: z.string().optional().describe('Language code or "auto". Default "ko".')
        })
      },
      {
        name: 'backup_sequence',
        description: 'Duplicates a sequence so an edit can be undone wholesale. apply_timeline_removals and auto_cut_edit already do this on their own; call this directly before any other risky change.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Sequence to back up. Defaults to the active sequence.'),
          label: z.string().optional().describe('Label used in the backup name. Default "backup".')
        })
      },
      {
        name: 'restore_sequence_backup',
        description: 'Makes a backup sequence the active one after a bad edit. Optionally deletes the damaged sequence. Use list_sequences to find the backup name.',
        inputSchema: z.object({
          backupSequenceId: z.string().describe('The backup sequence to restore (its ID, from list_sequences).'),
          deleteDamaged: z.boolean().optional().describe('Delete the sequence that was being edited. Default false — keep it until you have confirmed the restore.'),
          damagedSequenceId: z.string().optional().describe('The sequence to delete. Required when deleteDamaged is true.')
        })
      },
      {
        name: 'apply_timeline_removals',
        description: 'Removes a list of time spans from the timeline in one pass: razors at each span boundary and ripple-deletes the clips inside. Feed it the suggestedRemovals from analyze_audio_edit_points / analyze_speech_edit_points. IMPORTANT: those analyzers report SOURCE-clip times, so pass sourceTimes=true together with sourceMediaPath (the same file you analyzed) and the spans are converted to timeline times automatically. Without that they are read as raw timeline seconds, which is only correct when the clip starts at 00:00 and is untrimmed. Spans are processed right-to-left so earlier timecodes stay valid. Use dryRun to preview the plan before executing.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Optional sequence ID. Defaults to the active sequence.'),
          removals: z.array(z.object({
            start: z.number().describe('Span start in seconds (timeline time, or source-clip time when sourceTimes=true).'),
            end: z.number().describe('Span end in seconds (timeline time, or source-clip time when sourceTimes=true).')
          })).describe('Time spans to remove.'),
          sourceTimes: z.boolean().optional().describe('Set true when the spans came from analyze_audio_edit_points / analyze_speech_edit_points (source-clip time). Requires sourceMediaPath. Spans are mapped onto every timeline clip that uses that media, honoring clip start and trim. Default false.'),
          sourceMediaPath: z.string().optional().describe('Absolute path of the analyzed media file. Required when sourceTimes=true — used to locate the timeline clips that reference it.'),
          videoTrackIndices: z.array(z.number().int().min(0)).optional().describe('Video track indices to cut. Defaults to all video tracks.'),
          audioTrackIndices: z.array(z.number().int().min(0)).optional().describe('Audio track indices to cut. Defaults to all audio tracks.'),
          rippleDelete: z.boolean().optional().describe('Ripple-delete (close the gap) vs lift (leave gap). Default true.'),
          dryRun: z.boolean().optional().describe('If true, return the computed cut plan without modifying the timeline. Default false.'),
          backup: z.boolean().optional().describe('Duplicate the sequence before cutting so the original survives. Default true.')
        })
      },

      // Effects and Transitions

      // Audio Operations

      // Text and Graphics

      // Color Correction

      // Export and Rendering
      {
        name: 'export_sequence',
        description: 'Renders and exports a sequence to a video file. This is for creating the final video.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to export'),
          outputPath: z.string().describe('The absolute path where the final video file will be saved'),
          presetPath: z.string().optional().describe('Optional path to an export preset file (.epr) for specific settings'),
          format: z.enum(['mp4', 'mov', 'avi', 'h264', 'prores']).optional().describe('The export format or codec'),
          quality: z.enum(['low', 'medium', 'high', 'maximum']).optional().describe('Export quality setting'),
          resolution: z.string().optional().describe('Export resolution (e.g., "1920x1080", "3840x2160")')
        })
      },
      {
        name: 'export_frame',
        description: 'Exports a single frame from a sequence as an image file.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          time: z.number().describe('The time in seconds to export the frame from'),
          outputPath: z.string().describe('The absolute path where the image file will be saved'),
          format: z.enum(['png', 'jpg', 'tiff']).optional().describe('The image format')
        })
      },

      // Markers

      // Track Management


      // Additional Clip Operations

      // Project Settings
      {
        name: 'get_clip_properties',
        description: 'Gets detailed properties of a clip. Pass sequenceId when the clip ID came from list_sequence_tracks for a non-active sequence.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          sequenceId: z.string().optional().describe('Optional sequence ID to search. If omitted, searches the active sequence first, then all sequences.')
        })
      },

      // Render Queue

      // Advanced Features

      // Playhead & Work Area

      // Effect & Transition Discovery

      // Keyframes

      // Work Area

      // Batch Operations

      // Project Item Discovery & Management

      // Active Sequence Management
      {
        name: 'set_active_sequence',
        description: 'Sets the active sequence in the project.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to activate')
        })
      },
      {
        name: 'get_active_sequence',
        description: 'Gets information about the currently active sequence.',
        inputSchema: z.object({})
      },

      // Clip Lookup

      // Auto Reframe

      // Scene Edit Detection

      // Captions
      {
        name: 'read_sequence_captions',
        description: 'Reads all caption tracks of a sequence and returns each caption clip as { start, end, text }, with timestamps in seconds. Use this to find the timecodes of specific spoken phrases.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Optional sequence ID. Defaults to the active sequence.')
        })
      },

      // Subclip

      // Media Management - Relink & Metadata
      {
        name: 'undo',
        description: 'Performs an undo operation in Premiere Pro.',
        inputSchema: z.object({})
      },
    ];
  }

  async executeTool(name: string, args: Record<string, any>): Promise<any> {
    const tool = this.getAvailableTools().find(t => t.name === name);
    if (!tool) {
      return {
        success: false,
        error: `Tool '${name}' not found`,
        availableTools: this.getAvailableTools().map(t => t.name)
      };
    }

    // Validate input arguments
    try {
      tool.inputSchema.parse(args);
    } catch (error) {
      return {
        success: false,
        error: `Invalid arguments for tool '${name}': ${error}`,
        expectedSchema: tool.inputSchema.description
      };
    }

    this.logger.info(`Executing tool: ${name} with args:`, args);
    
    try {
      switch (name) {
        // Discovery Tools
        case 'list_project_items':
          return await this.listProjectItems(args.includeBins, args.includeMetadata);
        case 'list_sequences':
          return await this.listSequences();
        case 'list_sequence_tracks':
          return await this.listSequenceTracks(args.sequenceId, args.includeSourceTimes, args.compact);
        case 'insert_clip':
          return await this.insertClip(args);
        case 'get_project_info':
          return await this.getProjectInfo();
        case 'save_project':
          return await this.saveProject();
        case 'duplicate_sequence':
          return await this.duplicateSequence(args.sequenceId, args.newName);
        case 'read_sequence_captions':
          return await this.readSequenceCaptions(args.sequenceId);
        case 'remove_from_timeline':
          return await this.removeFromTimeline(args.clipId, args.sequenceId, args.deleteMode, args.removeLinked);
        case 'trim_clip':
          return await this.trimClip(args.clipId, args.inPoint, args.outPoint, args.duration);
        case 'razor_timeline_at_time':
          return await this.razorTimelineAtTime(args.sequenceId, args.time, args.videoTrackIndices, args.audioTrackIndices);
        case 'analyze_speech_edit_points':
          return await this.analyzeSpeechEditPoints(args.filePath, args.model, args.language, args.similarityThreshold, args.minGapSec, args.paddingSec, args.removeFillers, args.fillerWords, args.longGapSec, args.lookbackSec);
        case 'analyze_sequence_cuts':
          return await this.analyzeSequenceCuts(args);
        case 'apply_sequence_cuts':
          return await this.applySequenceCuts(args);
        case 'proofread_transcript':
          return await this.proofreadTranscript(args.filePath, args.scriptPath, args.model, args.language, args.confidenceThreshold, args.correctionThreshold);
        case 'export_captions':
          return await this.exportCaptions(args.filePath, args.outputPath, args.format, args.scriptPath, args.model, args.language, args.maxCharsPerLine, args.maxLines, args.maxDurationSec, args.minDurationSec, args.correctionThreshold, args.glossary, args.importToSequence);
        case 'find_speech_spans':
          return await this.findSpeechSpans(args.filePath, args.query, args.threshold, args.paddingSec, args.model, args.language);
        case 'backup_sequence':
          return await this.backupSequence(args.sequenceId, args.label);
        case 'restore_sequence_backup':
          return await this.restoreSequenceBackup(args.backupSequenceId, args.deleteDamaged, args.damagedSequenceId);
        case 'apply_timeline_removals':
          return await this.applyTimelineRemovals(args.sequenceId, args.removals, args.videoTrackIndices, args.audioTrackIndices, args.rippleDelete, args.dryRun, args.sourceTimes, args.sourceMediaPath, args.backup);

        // Effects and Transitions

        // Audio Operations

        // Color Correction

        // Export and Rendering
        case 'export_sequence':
          return await this.exportSequence(args.sequenceId, args.outputPath, args.presetPath, args.format, args.quality, args.resolution);
        case 'export_frame':
          return await this.exportFrame(args.sequenceId, args.time, args.outputPath, args.format);

        // Markers

        // Track Management
        case 'get_clip_properties':
          return await this.getClipProperties(args.clipId, args.sequenceId);
        case 'set_active_sequence':
          return await this.setActiveSequence(args.sequenceId);
        case 'get_active_sequence':
          return await this.getActiveSequence();

        // Clip Lookup

        // Scene Edit Detection

        // Captions

        // Subclip
        case 'undo':
          return await this.undo();
        default:
          return {
            success: false,
            error: `Tool '${name}' not implemented`,
            availableTools: this.getAvailableTools().map(t => t.name)
          };
      }
    } catch (error) {
      this.logger.error(`Error executing tool ${name}:`, error);
      return {
        success: false,
        error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        tool: name,
        args: args
      };
    }
  }

  // Discovery Tools Implementation
  private async listProjectItems(includeBins = true, _includeMetadata = false): Promise<any> {
    const script = `
      try {
        function walkItems(parent, results, bins) {
          for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            var info = {
              id: item.nodeId,
              name: item.name,
              type: item.type === 2 ? 'bin' : (item.isSequence() ? 'sequence' : 'footage'),
              treePath: item.treePath
            };
            try { info.mediaPath = item.getMediaPath(); } catch(e) {}
            if (item.type === 2) {
              bins.push(info);
              walkItems(item, results, bins);
            } else {
              results.push(info);
            }
          }
        }
        var items = []; var bins = [];
        walkItems(app.project.rootItem, items, bins);
        return JSON.stringify({
          success: true,
          items: items,
          bins: ${includeBins} ? bins : [],
          totalItems: items.length,
          totalBins: bins.length
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  private async listSequences(): Promise<any> {
    const script = `
      try {
        var sequences = [];
        
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
          var seq = app.project.sequences[i];
          sequences.push({
            id: seq.sequenceID,
            name: seq.name,
            duration: __ticksToSeconds(seq.end),
            width: seq.frameSizeHorizontal,
            height: seq.frameSizeVertical,
            timebase: seq.timebase,
            videoTrackCount: seq.videoTracks.numTracks,
            audioTrackCount: seq.audioTracks.numTracks
          });
        }

        return JSON.stringify({
          success: true,
          sequences: sequences,
          count: sequences.length
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;
    
    return await this.bridge.executeScript(script);
  }

  private async listSequenceTracks(sequenceId: string, includeSourceTimes = true, compact = false): Promise<any> {
    const withSrc = includeSourceTimes !== false;
    const script = `
      try {
        var sequence = __findSequence("${sequenceId}");
        if (!sequence) sequence = app.project.activeSequence;
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });

        var WITH_SRC = ${withSrc};
        var COMPACT = ${compact === true};

        function readTrack(track, index, label) {
          var clips = [];
          var gaps = [];
          var prevEnd = null;
          var covered = 0;
          for (var j = 0; j < track.clips.numItems; j++) {
            var clip = track.clips[j];
            var entry = {
              id: clip.nodeId,
              name: clip.name,
              startTime: clip.start.seconds,
              endTime: clip.end.seconds,
              duration: clip.duration.seconds
            };
            if (WITH_SRC) {
              // Source in/out. Paired with startTime this is the source -> timeline map.
              entry.inPoint = clip.inPoint ? clip.inPoint.seconds : null;
              entry.outPoint = clip.outPoint ? clip.outPoint.seconds : null;
            }
            covered += clip.duration.seconds;
            if (prevEnd !== null && clip.start.seconds - prevEnd > 0.0005) {
              gaps.push({ after: j - 1, start: prevEnd, end: clip.start.seconds, duration: clip.start.seconds - prevEnd });
            }
            prevEnd = clip.end.seconds;
            clips.push(entry);
          }
          var out = {
            index: index,
            name: track.name || label + " " + (index + 1),
            clipCount: clips.length,
            firstStart: clips.length ? clips[0].startTime : null,
            lastEnd: clips.length ? clips[clips.length - 1].endTime : null,
            coveredSec: covered,
            gapCount: gaps.length,
            gaps: gaps
          };
          if (COMPACT) {
            out.clips = clips.length > 2 ? [clips[0], clips[clips.length - 1]] : clips;
            out.clipsTruncated = clips.length > 2;
          } else {
            out.clips = clips;
            out.clipsTruncated = false;
          }
          return out;
        }

        var videoTracks = [];
        var audioTracks = [];
        for (var i = 0; i < sequence.videoTracks.numTracks; i++) videoTracks.push(readTrack(sequence.videoTracks[i], i, "Video"));
        for (var i = 0; i < sequence.audioTracks.numTracks; i++) audioTracks.push(readTrack(sequence.audioTracks[i], i, "Audio"));

        // --- verify: the authority on what the timeline holds ---
        var usedV = [], usedA = [];
        for (var i = 0; i < videoTracks.length; i++) if (videoTracks[i].clipCount > 0) usedV.push(videoTracks[i]);
        for (var i = 0; i < audioTracks.length; i++) if (audioTracks[i].clipCount > 0) usedA.push(audioTracks[i]);

        var measuredEnd = 0;
        var totalGaps = 0;
        for (var i = 0; i < usedV.length; i++) { if (usedV[i].lastEnd > measuredEnd) measuredEnd = usedV[i].lastEnd; totalGaps += usedV[i].gapCount; }
        for (var i = 0; i < usedA.length; i++) { if (usedA[i].lastEnd > measuredEnd) measuredEnd = usedA[i].lastEnd; totalGaps += usedA[i].gapCount; }

        var avParity = true, parityNote = null;
        if (usedV.length === 1 && usedA.length === 1) {
          if (usedV[0].clipCount !== usedA[0].clipCount) {
            avParity = false;
            parityNote = "V1 has " + usedV[0].clipCount + " clips, A1 has " + usedA[0].clipCount + " - A/V may be out of sync";
          } else if (Math.abs(usedV[0].lastEnd - usedA[0].lastEnd) > 0.0005) {
            avParity = false;
            parityNote = "V1 ends at " + usedV[0].lastEnd + "s, A1 at " + usedA[0].lastEnd + "s";
          }
        } else if (usedV.length > 1 || usedA.length > 1) {
          parityNote = "more than one populated track per type - parity not checked";
        }

        var reported = sequence.end ? __ticksToSeconds(sequence.end) : null;

        return JSON.stringify({
          success: true,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          verify: {
            measuredEndSec: measuredEnd,
            reportedDurationSec: reported,
            durationMatchesClips: (reported === null) ? null : (Math.abs(reported - measuredEnd) <= 0.05),
            populatedVideoTracks: usedV.length,
            populatedAudioTracks: usedA.length,
            gapCount: totalGaps,
            contiguous: totalGaps === 0,
            avParity: avParity,
            note: parityNote
          },
          videoTracks: videoTracks,
          audioTracks: audioTracks,
          totalVideoTracks: videoTracks.length,
          totalAudioTracks: audioTracks.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  /**
   * Place a source span onto a track. This is the only additive edit the server
   * offers; everything else removes, razors or trims. Without it a cold open or a
   * restored section has to be done by hand in Premiere.
   *
   * insertClip/overwriteClip take the projectItem's current in/out, so the span is
   * set on the item first and restored afterwards — otherwise the next insert
   * inherits whatever the last one left behind.
   */
  private async insertClip(args: any): Promise<any> {
    const {
      projectItemId, sourceMediaPath, sourceIn, sourceOut, timelineAt,
      mode = 'insert', sequenceId, videoTrackIndex = 0, audioTrackIndex = 0, withAudio = true,
    } = args ?? {};

    if (typeof sourceIn !== 'number' || typeof sourceOut !== 'number' || sourceOut <= sourceIn) {
      return JSON.stringify({ success: false, error: 'sourceIn/sourceOut required, and sourceOut must be greater than sourceIn' });
    }
    if (typeof timelineAt !== 'number' || timelineAt < 0) {
      return JSON.stringify({ success: false, error: 'timelineAt (seconds) is required' });
    }
    if (!projectItemId && !sourceMediaPath) {
      return JSON.stringify({ success: false, error: 'pass projectItemId or sourceMediaPath' });
    }

    const script = `
      try {
        var sequence = ${sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence'};
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });

        var item = null;
        ${projectItemId ? `item = __findProjectItem(${JSON.stringify(projectItemId)});` : ''}
        if (!item) {
          var wantPath = ${JSON.stringify(sourceMediaPath || '')};
          if (wantPath) {
            function walkFind(node) {
              if (node.getMediaPath && __samePath(node.getMediaPath(), wantPath)) return node;
              if (node.children) {
                for (var i = 0; i < node.children.numItems; i++) {
                  var f = walkFind(node.children[i]);
                  if (f) return f;
                }
              }
              return null;
            }
            item = walkFind(app.project.rootItem);
          }
        }
        if (!item) return JSON.stringify({ success: false, error: "project item not found - check projectItemId / sourceMediaPath" });

        var vIdx = ${videoTrackIndex}, aIdx = ${audioTrackIndex};
        if (vIdx < 0 || vIdx >= sequence.videoTracks.numTracks) return JSON.stringify({ success: false, error: "videoTrackIndex out of range" });
        if (${withAudio !== false} && (aIdx < 0 || aIdx >= sequence.audioTracks.numTracks)) return JSON.stringify({ success: false, error: "audioTrackIndex out of range" });

        // Remember the item's in/out so the next caller is not affected.
        var prevIn = null, prevOut = null;
        try { prevIn = item.getInPoint ? item.getInPoint().ticks : null; } catch (e) {}
        try { prevOut = item.getOutPoint ? item.getOutPoint().ticks : null; } catch (e) {}

        item.setInPoint(__secondsToTicks(${sourceIn}), 4);
        item.setOutPoint(__secondsToTicks(${sourceOut}), 4);

        function endOf(track) {
          var last = 0;
          for (var i = 0; i < track.clips.numItems; i++) {
            if (track.clips[i].end.seconds > last) last = track.clips[i].end.seconds;
          }
          return last;
        }
        var beforeV = endOf(sequence.videoTracks[vIdx]);
        var beforeVCount = sequence.videoTracks[vIdx].clips.numItems;

        var at = __secondsToTicks(${timelineAt});
        var isInsert = ${JSON.stringify(mode)} !== "overwrite";
        var placed = [];

        if (isInsert) {
          sequence.videoTracks[vIdx].insertClip(item, at);
        } else {
          sequence.videoTracks[vIdx].overwriteClip(item, at);
        }
        placed.push("video" + vIdx);

        // Video insert carries linked audio on most builds. Only place audio
        // separately when the audio track did not change.
        if (${withAudio !== false}) {
          var aCount = sequence.audioTracks[aIdx].clips.numItems;
          var expected = beforeVCount;
          var vCount = sequence.videoTracks[vIdx].clips.numItems;
          if (aCount < vCount) {
            try {
              if (isInsert) sequence.audioTracks[aIdx].insertClip(item, at);
              else sequence.audioTracks[aIdx].overwriteClip(item, at);
              placed.push("audio" + aIdx);
            } catch (e) {}
          } else {
            placed.push("audio" + aIdx + " (linked)");
          }
        }

        if (prevIn !== null) { try { item.setInPoint(prevIn, 4); } catch (e) {} }
        if (prevOut !== null) { try { item.setOutPoint(prevOut, 4); } catch (e) {} }

        var afterV = endOf(sequence.videoTracks[vIdx]);
        return JSON.stringify({
          success: true,
          mode: isInsert ? "insert" : "overwrite",
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          projectItem: item.name,
          sourceIn: ${sourceIn},
          sourceOut: ${sourceOut},
          spanSec: ${sourceOut - sourceIn},
          timelineAt: ${timelineAt},
          tracksPlaced: placed,
          videoEndBefore: beforeV,
          videoEndAfter: afterV,
          videoGrewBySec: afterV - beforeV
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    const raw: any = await this.bridge.executeScript(script);
    return await this.withVerification(raw, sequenceId, {
      expectedGrowthSec: sourceOut - sourceIn,
      growthKey: 'videoGrewBySec',
    });
  }

  /**
   * Re-query the timeline after a mutation and attach the measured state.
   * A change tool reporting success is not evidence the edit landed — an apply
   * has come back fullyApplied:true while the timeline held a 27s hole. The
   * caller should read `verify`, not the mutation's own summary.
   */
  private async withVerification(
    raw: any,
    sequenceId: string | undefined,
    opts: { expectedGrowthSec?: number; expectedRemovedSec?: number; growthKey?: string } = {},
  ): Promise<any> {
    let parsed: any;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return raw; }
    if (!parsed || parsed.success === false) return typeof raw === 'string' ? raw : JSON.stringify(raw);

    let verify: any = null;
    try {
      const tracksRaw: any = await this.listSequenceTracks(sequenceId ?? parsed.sequenceId ?? '', true, true);
      const tracks = typeof tracksRaw === 'string' ? JSON.parse(tracksRaw) : tracksRaw;
      verify = tracks?.verify ?? null;
    } catch { /* verification is best-effort; the mutation result still returns */ }

    if (!verify) return JSON.stringify({ ...parsed, verify: null, verifyNote: 'could not re-query the timeline - check it manually' });

    const problems: string[] = [];
    if (verify.gapCount > 0) problems.push(`${verify.gapCount} gap(s) in the timeline - the ripple did not close`);
    if (verify.avParity === false) problems.push(verify.note || 'A/V out of parity');
    if (typeof opts.expectedGrowthSec === 'number' && opts.growthKey) {
      const grew = Number(parsed[opts.growthKey]);
      if (Number.isFinite(grew) && Math.abs(grew - opts.expectedGrowthSec) > 0.05) {
        problems.push(`expected +${opts.expectedGrowthSec.toFixed(3)}s, timeline grew ${grew.toFixed(3)}s`);
      }
    }
    if (typeof opts.expectedRemovedSec === 'number' && typeof parsed.lengthBeforeSec === 'number') {
      const actual = parsed.lengthBeforeSec - verify.measuredEndSec;
      if (Math.abs(actual - opts.expectedRemovedSec) > 0.05) {
        problems.push(`expected -${opts.expectedRemovedSec.toFixed(3)}s, timeline lost ${actual.toFixed(3)}s`);
      }
    }

    return JSON.stringify({
      ...parsed,
      success: problems.length === 0 ? parsed.success : false,
      verify,
      verified: problems.length === 0,
      verifyProblems: problems.length ? problems : null,
    });
  }

  private async getProjectInfo(): Promise<any> {
    const script = `
      try {
        var project = app.project;
        var hasActive = project.activeSequence ? true : false;
        return JSON.stringify({
          success: true,
          name: project.name,
          path: project.path,
          activeSequence: hasActive ? {
            id: project.activeSequence.sequenceID,
            name: project.activeSequence.name
          } : null,
          itemCount: project.rootItem.children.numItems,
          sequenceCount: project.sequences.numSequences,
          hasActiveSequence: hasActive
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;

    return await this.bridge.executeScript(script);
  }






  // Project Management Implementation

  private async saveProject(): Promise<any> {
    try {
      await this.bridge.saveProject();
      return { 
        success: true, 
        message: 'Project saved successfully',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to save project: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }


  // Media Management Implementation
  private async importMedia(filePath: string, binName?: string): Promise<any> {
    try {
      const result: any = await this.bridge.importMedia(filePath);
      if (!result.success) {
        return {
          ...result,
          filePath: filePath,
          binName: binName || 'Root'
        };
      }
      return {
        success: true,
        message: `Media imported successfully`,
        filePath: filePath,
        binName: binName || 'Root',
        ...result
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to import media: ${error instanceof Error ? error.message : String(error)}`,
        filePath: filePath
      };
    }
  }

  /**
   * Import a Final Cut Pro 7 XML (XMEML) file.
   *
   * Premiere 2026 requires project.importFiles (not the legacy openFCPXML which
   * needs additional args like project context). importFiles handles XML/EDL/AAF
   * detection automatically and creates a new sequence atomically.
   *
   * Fallback chain: importFiles → openFCPXML(path,suppressUI) → openFCPXML(path).
   */

  /**
   * Import a CMX 3600 EDL file via app.importEDL.
   * Premiere prompts for sequence settings + source media in interactive mode.
   * The resulting sequence's timebase/video standard comes from the project defaults
   * or the interactive dialog — app.importEDL has no video-standard argument.
   */



  // Sequence Management Implementation
  private async duplicateSequence(sequenceId: string, newName: string): Promise<any> {
    const safeName = JSON.stringify(newName);
    const script = `
      try {
        var originalSeq = __findSequence(${JSON.stringify(sequenceId)});
        if (!originalSeq) return JSON.stringify({ success: false, error: "Sequence not found" });

        var newSeq = originalSeq.clone();
        newSeq.name = ${safeName};

        // Sequence.name does NOT propagate to the project panel — find and rename
        // the matching ProjectItem so the rename is visible to the user and to
        // future MCP calls.
        function __findItemForSequence(parent, seqId) {
          if (!parent || !parent.children) return null;
          for (var i = 0; i < parent.children.numItems; i++) {
            var item = parent.children[i];
            if (!item) continue;
            try {
              var seq = item.getSequence && item.getSequence();
              if (seq && seq.sequenceID === seqId) return item;
            } catch (_) { /* not a sequence-bearing item */ }
            if (item.type === 2 /* BIN */) {
              var nested = __findItemForSequence(item, seqId);
              if (nested) return nested;
            }
          }
          return null;
        }

        var renamedAtItem = false;
        var newItem = __findItemForSequence(app.project.rootItem, newSeq.sequenceID);
        if (newItem) {
          try {
            newItem.name = ${safeName};
            renamedAtItem = true;
          } catch (_) { /* fall through */ }
        }

        return JSON.stringify({
          success: true,
          originalSequenceId: ${JSON.stringify(sequenceId)},
          newSequenceId: newSeq.sequenceID,
          newName: ${safeName},
          newProjectItemId: newItem ? newItem.nodeId : null,
          renamedAtProjectItem: renamedAtItem
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }


  private async readSequenceCaptions(sequenceId?: string): Promise<any> {
    const seqArg = sequenceId ? JSON.stringify(sequenceId) : 'null';
    const script = `
      try {
        var sequence = ${seqArg} ? __findSequence(${seqArg}) : null;
        if (!sequence) sequence = app.project.activeSequence;
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });

        // Premiere caption tracks live alongside video/audio tracks. Different
        // Premiere versions expose them differently:
        //   - sequence.getCaptionTracks() (newer)
        //   - sequence.captionTracks (some builds)
        //   - sequence.videoTracks[i] with isCaptioning style flag
        // Try in that order, return whatever yields {start, end, text} clips.

        var tracks = [];
        try {
          if (sequence.getCaptionTracks) {
            tracks = sequence.getCaptionTracks();
          } else if (sequence.captionTracks) {
            tracks = sequence.captionTracks;
          }
        } catch (_) { /* fall through to track scan */ }

        // Fallback: scan video tracks for caption clip data
        if ((!tracks || tracks.length === 0) && sequence.videoTracks) {
          for (var v = 0; v < sequence.videoTracks.numTracks; v++) {
            var t = sequence.videoTracks[v];
            if (t && (t.isCaption || t.captionTrack || (t.name && /caption/i.test(t.name)))) {
              tracks.push(t);
            }
          }
        }

        var trackCount = tracks ? tracks.length : 0;
        var output = [];

        for (var i = 0; i < trackCount; i++) {
          var trk = tracks[i];
          if (!trk) continue;
          var clips = trk.clips || trk.captions || [];
          var clipCount = clips.numItems !== undefined ? clips.numItems : (clips.length || 0);
          for (var c = 0; c < clipCount; c++) {
            var clip = clips[c];
            if (!clip) continue;
            var startSec = null;
            var endSec = null;
            try {
              if (clip.start && clip.start.seconds !== undefined) startSec = clip.start.seconds;
              else if (clip.start && clip.start.ticks) startSec = parseFloat(clip.start.ticks) / 254016000000.0;
              else if (typeof clip.startTime === 'number') startSec = clip.startTime;
            } catch (_) {}
            try {
              if (clip.end && clip.end.seconds !== undefined) endSec = clip.end.seconds;
              else if (clip.end && clip.end.ticks) endSec = parseFloat(clip.end.ticks) / 254016000000.0;
              else if (typeof clip.endTime === 'number') endSec = clip.endTime;
            } catch (_) {}

            var text = "";
            try {
              if (typeof clip.text === 'string') text = clip.text;
              else if (clip.captionText) text = clip.captionText;
              else if (clip.name) text = clip.name;
            } catch (_) {}

            output.push({
              trackIndex: i,
              start: startSec,
              end: endSec,
              text: text
            });
          }
        }

        return JSON.stringify({
          success: true,
          sequenceId: sequence.sequenceID,
          sequenceName: sequence.name,
          trackCount: trackCount,
          captionCount: output.length,
          captions: output
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Timeline Operations Implementation
  private async removeFromTimeline(clipId: string, sequenceId?: string, deleteMode = 'ripple', removeLinked = true): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)}, ${sequenceId ? JSON.stringify(sequenceId) : 'null'});
        if (!info) return JSON.stringify({ success: false, error: ${sequenceId ? JSON.stringify(`Clip not found in sequence: ${sequenceId}`) : '"Clip not found"'} });
        var clip = info.clip;
        var clipName = clip.name;
        var isRipple = ${JSON.stringify(deleteMode)} === "ripple";
        var alsoLinked = ${removeLinked ? 'true' : 'false'};

        // A ripple delete pulls up only the track it ran on — clip.remove() does
        // NOT take the linked audio/video partner with it. Removing just one side
        // shifts that track and leaves the other where it was, so everything
        // downstream drifts out of sync. Find the partner by matching span+name on
        // the opposite track type and remove it in the same pass.
        var partners = [];
        if (alsoLinked && isRipple) {
          var seq = info.sequence;
          var cs = clip.start.seconds, ce = clip.end.seconds;
          var tol = 0.002;
          var pools = info.trackType === "video" ? seq.audioTracks : seq.videoTracks;
          for (var pt = 0; pt < pools.numTracks; pt++) {
            var ptrack = pools[pt];
            for (var pc = 0; pc < ptrack.clips.numItems; pc++) {
              var pclip = ptrack.clips[pc];
              if (Math.abs(pclip.start.seconds - cs) > tol) continue;
              if (Math.abs(pclip.end.seconds - ce) > tol) continue;
              if (pclip.name !== clipName) continue;
              partners.push(pclip);
              break;
            }
          }
        }

        clip.remove(isRipple, true);
        for (var pr = 0; pr < partners.length; pr++) partners[pr].remove(isRipple, true);

        return JSON.stringify({
          success: true,
          message: "Clip removed from timeline" + (partners.length ? " (with " + partners.length + " linked clip(s))" : ""),
          clipId: ${JSON.stringify(clipId)},
          clipName: clipName,
          sequenceId: info.sequenceId,
          sequenceName: info.sequenceName,
          deleteMode: ${JSON.stringify(deleteMode)},
          linkedRemoved: partners.length
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  private async trimClip(clipId: string, inPoint?: number, outPoint?: number, duration?: number): Promise<any> {
    const script = `
      try {
        var info = __findClip("${clipId}");
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var oldInPoint = clip.inPoint.seconds;
        var oldOutPoint = clip.outPoint.seconds;
        var oldDuration = clip.duration.seconds;
        ${inPoint !== undefined ? `clip.inPoint = new Time("${inPoint}s");` : ''}
        ${outPoint !== undefined ? `clip.outPoint = new Time("${outPoint}s");` : ''}
        ${duration !== undefined ? `clip.outPoint = new Time(clip.inPoint.seconds + ${duration});` : ''}
        return JSON.stringify({
          success: true,
          message: "Clip trimmed successfully",
          clipId: "${clipId}",
          oldInPoint: oldInPoint,
          oldOutPoint: oldOutPoint,
          oldDuration: oldDuration,
          newInPoint: clip.inPoint.seconds,
          newOutPoint: clip.outPoint.seconds,
          newDuration: clip.duration.seconds
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;

    return await this.bridge.executeScript(script);
  }


  private async razorTimelineAtTime(sequenceId?: string, time?: number, videoTrackIndices?: number[], audioTrackIndices?: number[]): Promise<any> {
    const normalizedTime = time ?? 0;
    const videoIndices = videoTrackIndices ?? [];
    const audioIndices = audioTrackIndices ?? [];

    const script = `
      try {
        app.enableQE();
        var sequence = ${sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence'};
        if (!sequence) return JSON.stringify({ success: false, error: ${sequenceId ? `"Sequence not found by id: ${sequenceId}"` : '"No active sequence"'} });

        if (app.project.activeSequence && app.project.activeSequence.sequenceID !== sequence.sequenceID) {
          app.project.openSequence(sequence.sequenceID);
        }

        var activeSequence = app.project.activeSequence;
        if (!activeSequence || activeSequence.sequenceID !== sequence.sequenceID) {
          return JSON.stringify({ success: false, error: "Unable to activate requested sequence for razor cut" });
        }

        var fps = activeSequence.timebase ? (254016000000 / parseInt(activeSequence.timebase, 10)) : 30;
        var totalFrames = Math.round(${normalizedTime} * fps);
        var hours = Math.floor(totalFrames / (fps * 3600));
        var mins = Math.floor((totalFrames % (fps * 3600)) / (fps * 60));
        var secs = Math.floor((totalFrames % (fps * 60)) / fps);
        var frames = Math.round(totalFrames % fps);
        function pad(n) { return n < 10 ? "0" + n : "" + n; }
        var tc = pad(hours) + ":" + pad(mins) + ":" + pad(secs) + ":" + pad(frames);

        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return JSON.stringify({ success: false, error: "QE active sequence unavailable" });

        function buildIndices(count, requested) {
          if (!requested || requested.length === 0) {
            var all = [];
            for (var idx = 0; idx < count; idx++) all.push(idx);
            return all;
          }
          return requested;
        }

        var requestedVideo = ${JSON.stringify(videoIndices)};
        var requestedAudio = ${JSON.stringify(audioIndices)};
        var finalVideo = buildIndices(activeSequence.videoTracks.numTracks, requestedVideo);
        var finalAudio = buildIndices(activeSequence.audioTracks.numTracks, requestedAudio);
        var cutVideoTracks = [];
        var cutAudioTracks = [];
        var skippedVideoTracks = [];
        var skippedAudioTracks = [];

        for (var i = 0; i < finalVideo.length; i++) {
          var videoIndex = finalVideo[i];
          if (videoIndex < 0 || videoIndex >= activeSequence.videoTracks.numTracks) {
            skippedVideoTracks.push({ index: videoIndex, reason: "Video track index out of range" });
            continue;
          }
          var qeVideoTrack = qeSeq.getVideoTrackAt(videoIndex);
          if (!qeVideoTrack) {
            skippedVideoTracks.push({ index: videoIndex, reason: "QE video track not found" });
            continue;
          }
          qeVideoTrack.razor(tc);
          cutVideoTracks.push(videoIndex);
        }

        for (var j = 0; j < finalAudio.length; j++) {
          var audioIndex = finalAudio[j];
          if (audioIndex < 0 || audioIndex >= activeSequence.audioTracks.numTracks) {
            skippedAudioTracks.push({ index: audioIndex, reason: "Audio track index out of range" });
            continue;
          }
          var qeAudioTrack = qeSeq.getAudioTrackAt(audioIndex);
          if (!qeAudioTrack) {
            skippedAudioTracks.push({ index: audioIndex, reason: "QE audio track not found" });
            continue;
          }
          qeAudioTrack.razor(tc);
          cutAudioTracks.push(audioIndex);
        }

        return JSON.stringify({
          success: true,
          message: "Timeline razored at " + tc,
          sequenceId: activeSequence.sequenceID,
          sequenceName: activeSequence.name,
          time: ${normalizedTime},
          timecode: tc,
          cutVideoTracks: cutVideoTracks,
          cutAudioTracks: cutAudioTracks,
          skippedVideoTracks: skippedVideoTracks,
          skippedAudioTracks: skippedAudioTracks
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: "QE DOM error: " + e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  /** Find a media file backing a sequence — the first clip with a resolvable
   *  media path, video track then audio. Lets the cut tools key off a sequence
   *  id instead of making the caller hunt for the file in list_project_items. */
  private async resolveSequenceMedia(sequenceId?: string): Promise<string | null> {
    const script = `
      try {
        var sequence = ${sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence'};
        if (!sequence) return JSON.stringify({ success: false });
        for (var t = 0; t < sequence.videoTracks.numTracks; t++) {
          var track = sequence.videoTracks[t];
          for (var c = 0; c < track.clips.numItems; c++) {
            try {
              var mp = track.clips[c].projectItem ? track.clips[c].projectItem.getMediaPath() : "";
              if (mp) return JSON.stringify({ success: true, mediaPath: mp });
            } catch (inner) {}
          }
        }
        for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
          var atrack = sequence.audioTracks[a];
          for (var ac = 0; ac < atrack.clips.numItems; ac++) {
            try {
              var amp = atrack.clips[ac].projectItem ? atrack.clips[ac].projectItem.getMediaPath() : "";
              if (amp) return JSON.stringify({ success: true, mediaPath: amp });
            } catch (inner2) {}
          }
        }
        return JSON.stringify({ success: false });
      } catch (e) {
        return JSON.stringify({ success: false });
      }
    `;
    try {
      const raw: any = await this.bridge.executeScript(script);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return parsed?.success ? String(parsed.mediaPath) : null;
    } catch {
      return null;
    }
  }

  /**
   * THE cut-edit entry point: sequence in, categorized + freeze-checked cut plan out.
   *
   * Resolves the sequence media, runs the speech analysis (transcribe → categorized
   * proposals), then runs freezedetect on each long silent gap so demos (active
   * screen) are told apart from dead air (static) automatically. Compact by default.
   */
  private async analyzeSequenceCuts(args: any): Promise<any> {
    const mediaPath = args.mediaPath || (await this.resolveSequenceMedia(args.sequenceId));
    if (!mediaPath) {
      return JSON.stringify({
        success: false,
        stage: 'resolve-media',
        error: 'Could not find a media file for this sequence. Pass mediaPath, or check the sequence has a clip with linked media (list_project_items → mediaPath).',
      });
    }

    let analysis: any;
    try {
      analysis = await analyzeSpeechEditPoints(
        mediaPath,
        args.model ?? 'small',
        args.language ?? 'ko',
        0.75,
        args.minGapSec ?? 0.6,
        args.paddingSec ?? 0.15,
        args.removeFillers ?? false,
        DEFAULT_FILLERS,
        args.longGapSec ?? 5,
        args.lookbackSec ?? 25,
      );
    } catch (e: any) {
      return JSON.stringify({ success: false, stage: 'analyze', error: `speech analysis failed: ${e?.message || e}` });
    }
    if (!analysis.success) {
      return JSON.stringify({ success: false, stage: 'analyze', error: analysis.error, warnings: analysis.warnings });
    }

    // Freeze-check the long gaps: static (frozen) = safe to cut, active = live demo.
    const checkFrames = args.checkFrames !== false;
    const longGapGroup = (analysis.proposals || []).find((p: any) => p.kind === 'longGaps');
    const frameChecks: any[] = [];
    if (checkFrames && longGapGroup) {
      for (const span of longGapGroup.spans) {
        try {
          const v = await detectFreeze(mediaPath, span.start, span.end);
          frameChecks.push({ start: span.start, end: span.end, duration: span.duration, screenState: v.error ? 'unknown' : v.screenState, longestFreezeFraction: v.longestFreezeFraction, freezeSegments: v.freezeSegments, ...(v.error ? { note: v.error } : {}) });
        } catch (e: any) {
          frameChecks.push({ start: span.start, end: span.end, duration: span.duration, screenState: 'unknown', note: String(e?.message || e) });
        }
      }
    }

    // Compact proposals: drop the per-span arrays' verbosity is already small;
    // the big payload is the transcript, omitted unless asked.
    const compactProposals = (analysis.proposals || []).map((p: any) => ({
      kind: p.kind, label: p.label, count: p.spans.length, totalSec: p.totalSec,
      recommended: p.recommended, note: p.note, spans: p.spans,
    }));

    const out: any = {
      success: true,
      sequenceId: args.sequenceId ?? null,
      mediaPath,
      duration: analysis.duration,
      language: analysis.language,
      warnings: analysis.warnings,
      proposals: compactProposals,
      frameChecks, // per long-gap static/active verdict
      suggestedRemovals: analysis.suggestedRemovals, // recommended-only (timeline-safe subset)
      stats: analysis.stats,
      note: 'suggestedRemovals covers only the recommended groups (duplicates + pauses [+ fillers]). Review intro/outro/longGaps yourself — use frameChecks: static longGaps are safe to add, active ones are demos to keep. Times are source-clip seconds; pass sourceTimes=true to apply_sequence_cuts if the timeline clip is untrimmed.',
    };
    if (args.includeTranscript) out.segments = analysis.segments;
    return JSON.stringify(out);
  }

  /** Apply approved spans with backup + ripple + re-queried verification. */
  private async applySequenceCuts(args: any): Promise<any> {
    const removals = Array.isArray(args.removals) ? args.removals : [];
    if (!removals.length) {
      return JSON.stringify({ success: false, error: 'removals is required (the approved spans to cut).' });
    }
    // Measure before.
    const before = await this.getSequenceDurationSec(args.sequenceId);

    let applyRaw: any;
    try {
      applyRaw = await this.applyTimelineRemovals(
        args.sequenceId, removals, undefined, undefined, true, false,
        args.sourceTimes ?? false, args.sourceMediaPath, args.backup !== false,
      );
    } catch (e: any) {
      return JSON.stringify({ success: false, stage: 'apply', error: `apply failed: ${e?.message || e}` });
    }
    const apply = typeof applyRaw === 'string' ? JSON.parse(applyRaw) : applyRaw;
    if (!apply.success) return JSON.stringify({ success: false, stage: 'apply', ...apply });

    // Measure after (re-query is the judge, not the apply response).
    const after = await this.getSequenceDurationSec(args.sequenceId);
    const removed = removals.reduce((a: number, r: any) => a + Math.max(0, r.end - r.start), 0);
    const expected = args.expectedDurationSec ?? (before != null ? before - removed : null);
    const drift = expected != null && after != null ? Math.round((after - expected) * 1000) / 1000 : null;
    const verified = drift != null ? Math.abs(drift) <= 2 : null;

    return JSON.stringify({
      success: true,
      verified,
      beforeSec: before,
      afterSec: after,
      removedPlannedSec: Math.round(removed * 1000) / 1000,
      expectedSec: expected != null ? Math.round(expected * 1000) / 1000 : null,
      driftSec: drift,
      fullyApplied: apply.fullyApplied ?? null,
      inSync: apply.inSync ?? null,
      backupSequenceName: apply.backupSequenceName ?? null,
      removedClipCount: apply.removedClipCount ?? null,
      note: verified === false
        ? 'MEASURED LENGTH IS OFF by more than 2s from expected — stop and inspect; the backup sequence is intact.'
        : 'Measured length matches expected. Judged from re-queried duration, not the apply response.',
    });
  }

  /** Re-query a sequence's duration in seconds (the judge for apply verification). */
  private async getSequenceDurationSec(sequenceId?: string): Promise<number | null> {
    const script = `
      try {
        var s = ${sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence'};
        if (!s) return JSON.stringify({ success: false });
        return JSON.stringify({ success: true, seconds: s.end ? s.end.seconds : (s.zeroPoint ? 0 : 0) });
      } catch (e) { return JSON.stringify({ success: false }); }
    `;
    try {
      const raw: any = await this.bridge.executeScript(script);
      const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return p?.success ? Number(p.seconds) : null;
    } catch { return null; }
  }

  private async analyzeSpeechEditPoints(
    filePath?: string,
    model?: string,
    language?: string,
    similarityThreshold?: number,
    minGapSec?: number,
    paddingSec?: number,
    removeFillers?: boolean,
    fillerWords?: string[],
    longGapSec?: number,
    lookbackSec?: number,
  ): Promise<any> {
    if (!filePath) {
      return JSON.stringify({ success: false, error: 'filePath is required' });
    }
    try {
      const analysis = await analyzeSpeechEditPoints(
        filePath,
        model ?? 'small',
        language ?? 'ko',
        similarityThreshold ?? 0.75,
        minGapSec ?? 0.6,
        paddingSec ?? 0.15,
        removeFillers ?? false,
        fillerWords && fillerWords.length ? fillerWords : DEFAULT_FILLERS,
        longGapSec ?? 5,
        lookbackSec ?? 25,
      );
      return JSON.stringify(analysis);
    } catch (e: any) {
      return JSON.stringify({ success: false, error: `speech analysis failed: ${e?.message || e}` });
    }
  }

  private async proofreadTranscript(
    filePath?: string,
    scriptPath?: string,
    model?: string,
    language?: string,
    confidenceThreshold?: number,
    correctionThreshold?: number,
  ): Promise<any> {
    if (!filePath) {
      return JSON.stringify({ success: false, error: 'filePath is required' });
    }
    try {
      const result = await proofreadTranscript(
        filePath,
        scriptPath,
        model ?? 'base',
        language ?? 'ko',
        confidenceThreshold ?? 0.6,
        correctionThreshold ?? 0.6,
      );
      return JSON.stringify(result);
    } catch (e: any) {
      return JSON.stringify({ success: false, error: `proofread failed: ${e?.message || e}` });
    }
  }

  private async exportCaptions(
    filePath?: string,
    outputPath?: string,
    format?: 'srt' | 'vtt' | 'txt',
    scriptPath?: string,
    model?: string,
    language?: string,
    maxCharsPerLine?: number,
    maxLines?: number,
    maxDurationSec?: number,
    minDurationSec?: number,
    correctionThreshold?: number,
    glossary?: Record<string, string>,
    importToSequence?: string,
  ): Promise<any> {
    if (!filePath) {
      return JSON.stringify({ success: false, error: 'filePath is required' });
    }
    const fmt = format ?? 'srt';

    try {
      let segments;
      let language_;
      let corrections: any[] = [];
      let correctedSegments = 0;

      if (scriptPath) {
        // Proofread first: the script is ground truth, so names and jargon are
        // fixed before they ever reach a cue.
        const pr = await proofreadTranscript(
          filePath,
          scriptPath,
          model ?? 'base',
          language ?? 'ko',
          0.6,
          correctionThreshold ?? 0.6,
        );
        if (!pr.success) {
          return JSON.stringify({ success: false, error: pr.error || 'proofreading failed' });
        }
        language_ = pr.language;
        corrections = pr.corrections.filter((c) => c.applied);

        // Apply the accepted corrections onto the segments. A corrected segment
        // loses its word timings (the new words never had any), so caption
        // splitting falls back to segment-level timing for those.
        const bySegment = new Map<number, string>();
        for (const c of corrections) bySegment.set(c.segmentIndex, c.suggested);
        segments = pr.segments.map((seg, i) => {
          const fixed = bySegment.get(i);
          if (fixed === undefined) return seg;
          correctedSegments++;
          return { start: seg.start, end: seg.end, text: fixed };
        });
      } else {
        const tr = await transcribeAudio(filePath, model ?? 'base', language ?? 'ko');
        if (!tr.success) {
          return JSON.stringify({ success: false, error: tr.error || 'transcription failed' });
        }
        segments = tr.segments;
        language_ = tr.language;
      }

      const cues = buildCues(segments, {
        maxCharsPerLine: maxCharsPerLine ?? 20,
        maxLines: maxLines ?? 2,
        maxDurationSec: maxDurationSec ?? 6,
        minDurationSec: minDurationSec ?? 1,
        ...(glossary ? { glossary } : {}),
      });
      if (cues.length === 0) {
        return JSON.stringify({ success: false, error: 'no speech found to caption' });
      }

      const body = serializeCues(cues, fmt);
      const target = outputPath || filePath.replace(/\.[^.\/\\]+$/, '') + '.' + fmt;
      writeFileSync(target, body, 'utf8');

      // Optionally put the file straight onto the sequence as a caption track,
      // so the round trip through the Premiere UI is not needed.
      let captionTrack: any = null;
      if (importToSequence) {
        if (fmt !== 'srt') {
          captionTrack = { success: false, error: 'importToSequence needs SRT; re-run with format "srt"' };
        } else {
          const imported: any = await this.importMedia(target);
          const itemId = imported?.id || imported?.nodeId || null;
          if (!imported?.success || !itemId) {
            captionTrack = { success: false, error: imported?.error || 'could not import the subtitle file' };
          } else {
            const trackRaw: any = await this.createCaptionTrack(importToSequence, String(itemId), 0, 'subtitle');
            captionTrack = typeof trackRaw === 'string' ? JSON.parse(trackRaw) : trackRaw;
          }
        }
      }

      const last = cues[cues.length - 1]!;
      return JSON.stringify({
        success: true,
        outputPath: target,
        captionTrack,
        format: fmt,
        language: language_,
        cueCount: cues.length,
        durationSec: last.end,
        usedScript: Boolean(scriptPath),
        correctedSegmentCount: correctedSegments,
        corrections: corrections.slice(0, 25).map((c) => ({ heard: c.heard, corrected: c.suggested, similarity: c.similarity })),
        correctionsTruncated: corrections.length > 25,
        preview: cues.slice(0, 5).map((c) => ({ start: c.start, end: c.end, text: c.text })),
      });
    } catch (e: any) {
      return JSON.stringify({ success: false, error: `caption export failed: ${e?.message || e}` });
    }
  }

  private async findSpeechSpans(
    filePath?: string,
    query?: string,
    threshold?: number,
    paddingSec?: number,
    model?: string,
    language?: string,
  ): Promise<any> {
    if (!filePath) return JSON.stringify({ success: false, error: 'filePath is required' });
    if (!query) return JSON.stringify({ success: false, error: 'query is required' });

    try {
      const tr = await transcribeAudio(filePath, model ?? 'base', language ?? 'ko');
      if (!tr.success) {
        return JSON.stringify({ success: false, error: tr.error || 'transcription failed' });
      }

      const matches = findTextSpans(tr.segments, query, threshold ?? 0.7, paddingSec ?? 0.05);
      return JSON.stringify({
        success: true,
        file: filePath,
        query,
        threshold: threshold ?? 0.7,
        cached: Boolean(tr.cached),
        matchCount: matches.length,
        matches,
        // Ready to hand to apply_timeline_removals as-is.
        spans: matches.map((m) => ({ start: m.start, end: m.end })),
        hint: matches.length
          ? 'Pass spans to apply_timeline_removals with sourceTimes=true and sourceMediaPath set to this file. Use dryRun first.'
          : 'No match. Lower threshold, or check the phrase against the transcript from export_captions.',
      });
    } catch (e: any) {
      return JSON.stringify({ success: false, error: `speech search failed: ${e?.message || e}` });
    }
  }

  /** Resolve a sequence id/name, defaulting to the active sequence. Several of
   *  the composite tools need the id before they can do anything else. */
  private async resolveSequence(sequenceId?: string): Promise<{ id: string; name: string } | { error: string }> {
    const script = `
      try {
        var sequence = ${sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence'};
        if (!sequence) return JSON.stringify({ success: false, error: "sequence not found" });
        return JSON.stringify({ success: true, id: sequence.sequenceID, name: sequence.name });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    try {
      const raw: any = await this.bridge.executeScript(script);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || !parsed.success) return { error: parsed?.error || 'could not resolve sequence' };
      return { id: String(parsed.id), name: String(parsed.name) };
    } catch (e: any) {
      return { error: `could not resolve sequence: ${e?.message || e}` };
    }
  }

  /** Timestamp suffix so successive backups of one sequence stay distinguishable. */
  private backupLabel(label = 'backup'): string {
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    return `[${label} ${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}]`;
  }

  private async backupSequence(sequenceId?: string, label?: string): Promise<any> {
    const seq = await this.resolveSequence(sequenceId);
    if ('error' in seq) return JSON.stringify({ success: false, error: seq.error });

    const backupName = `${seq.name} ${this.backupLabel(label)}`;
    const raw: any = await this.duplicateSequence(seq.id, backupName);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || parsed.success === false) {
      return JSON.stringify({ success: false, error: parsed?.error || 'duplicate failed', sourceSequence: seq.name });
    }
    return JSON.stringify({
      success: true,
      message: `Backed up "${seq.name}" as "${backupName}"`,
      sourceSequenceId: seq.id,
      sourceSequenceName: seq.name,
      backupSequenceName: backupName,
      backupSequenceId: parsed.sequenceId || parsed.id || null,
      hint: 'If the edit goes wrong, use list_sequences to find this backup and restore_sequence_backup to make it active.',
    });
  }

  private async restoreSequenceBackup(
    backupSequenceId?: string,
    deleteDamaged = false,
    damagedSequenceId?: string,
  ): Promise<any> {
    if (!backupSequenceId) return JSON.stringify({ success: false, error: 'backupSequenceId is required' });
    if (deleteDamaged && !damagedSequenceId) {
      return JSON.stringify({ success: false, error: 'damagedSequenceId is required when deleteDamaged is true' });
    }

    const script = `
      try {
        var backup = __findSequence(${JSON.stringify(backupSequenceId)});
        if (!backup) return JSON.stringify({ success: false, error: "backup sequence not found" });
        app.project.openSequence(backup.sequenceID);

        var deleted = null;
        ${deleteDamaged ? `
        var damaged = __findSequence(${JSON.stringify(damagedSequenceId ?? '')});
        if (damaged && damaged.sequenceID !== backup.sequenceID) {
          deleted = damaged.name;
          damaged.projectItem.deleteBin();
        }` : ''}

        return JSON.stringify({
          success: true,
          message: "Restored \\"" + backup.name + "\\"" + (deleted ? " and deleted \\"" + deleted + "\\"" : ""),
          activeSequence: backup.name,
          activeSequenceId: backup.sequenceID,
          deletedSequence: deleted
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  /** Read the media path of the first clip on the lowest non-empty video track.
   *  Saves the caller a list_project_items round trip in the common case where
   *  the sequence is one long take. */
  /**
   * Analyze -> plan -> (approve) -> cut -> caption, in one call.
   *
   * Defaults to a dry run. Cutting a timeline is destructive and the analysis
   * is a judgement call about someone's speech, so the plan is shown first and
   * the caller opts in to applying it.
   */
  /**
   * Cut a short-form clip out of a range: subsequence the range, then reframe it
   * to a vertical/square aspect.
   */
  private async applyTimelineRemovals(
    sequenceId?: string,
    removals?: Array<{ start: number; end: number }>,
    videoTrackIndices?: number[],
    audioTrackIndices?: number[],
    rippleDelete = true,
    dryRun = false,
    sourceTimes = false,
    sourceMediaPath?: string,
    backup = true,
  ): Promise<any> {
    const spans = (removals ?? [])
      .filter((s) => s && typeof s.start === 'number' && typeof s.end === 'number' && s.end > s.start)
      .map((s) => ({ start: s.start, end: s.end }))
      // Right-to-left so removing a later span does not shift earlier timecodes.
      .sort((a, b) => b.start - a.start);

    if (spans.length === 0) {
      return JSON.stringify({ success: false, error: 'no valid removal spans provided' });
    }

    if (sourceTimes && !sourceMediaPath) {
      return JSON.stringify({
        success: false,
        error: 'sourceTimes=true requires sourceMediaPath (the media file that was analyzed) so source-clip times can be mapped onto the timeline',
      });
    }

    // Back up before cutting. Ripple deletes across many spans are not something
    // a single undo reliably walks back, and the analyzers can be wrong about a
    // take, so the untouched sequence is kept alongside the edited one.
    let backupSequenceName: string | null = null;
    if (backup && !dryRun) {
      const backedUp: any = await this.backupSequence(sequenceId);
      const parsed = typeof backedUp === 'string' ? JSON.parse(backedUp) : backedUp;
      if (!parsed?.success) {
        return JSON.stringify({
          success: false,
          error: `refusing to cut: the backup failed (${parsed?.error || 'unknown error'}). Pass backup:false to cut anyway.`,
        });
      }
      backupSequenceName = parsed.backupSequenceName;
    }

    const script = `
      try {
        app.enableQE();
        var sequence = ${sequenceId ? `__findSequence(${JSON.stringify(sequenceId)})` : 'app.project.activeSequence'};
        if (!sequence) return JSON.stringify({ success: false, error: ${sequenceId ? `"Sequence not found by id: ${sequenceId}"` : '"No active sequence"'} });
        if (app.project.activeSequence && app.project.activeSequence.sequenceID !== sequence.sequenceID) {
          app.project.openSequence(sequence.sequenceID);
        }
        var activeSequence = app.project.activeSequence;
        var fps = activeSequence.timebase ? (254016000000 / parseInt(activeSequence.timebase, 10)) : 30;

        function toTc(t) {
          var totalFrames = Math.round(t * fps);
          var hours = Math.floor(totalFrames / (fps * 3600));
          var mins = Math.floor((totalFrames % (fps * 3600)) / (fps * 60));
          var secs = Math.floor((totalFrames % (fps * 60)) / fps);
          var frames = Math.round(totalFrames % fps);
          function pad(n) { return n < 10 ? "0" + n : "" + n; }
          return pad(hours) + ":" + pad(mins) + ":" + pad(secs) + ":" + pad(frames);
        }

        function buildIndices(count, requested) {
          if (!requested || requested.length === 0) {
            var all = [];
            for (var idx = 0; idx < count; idx++) all.push(idx);
            return all;
          }
          return requested;
        }

        var spans = ${JSON.stringify(spans)};
        var isRipple = ${rippleDelete ? 'true' : 'false'};
        var dryRun = ${dryRun ? 'true' : 'false'};
        var sourceTimes = ${sourceTimes ? 'true' : 'false'};
        var sourceMediaPath = ${JSON.stringify(sourceMediaPath ?? '')};
        // macOS stores filenames NFD-decomposed while callers usually hand us NFC
        // (anything typed, or copied out of JSON). The two are byte-different, so
        // a path with Korean/accented characters never matched and the call failed
        // with "no timeline clip references sourceMediaPath". ExtendScript has no
        // String.normalize, so the variants are precomputed on the Node side.
        var sourceMediaPathVariants = ${JSON.stringify(pathVariants(sourceMediaPath ?? ''))};
        var finalVideo = buildIndices(activeSequence.videoTracks.numTracks, ${JSON.stringify(videoTrackIndices ?? [])});
        var finalAudio = buildIndices(activeSequence.audioTracks.numTracks, ${JSON.stringify(audioTrackIndices ?? [])});
        var eps = 0.5 / fps;

        // ---- track handles -------------------------------------------------
        // Only non-empty tracks take part. An empty track can never match the
        // others' removed duration, which would make the sync check meaningless.
        var targets = [];
        for (var v = 0; v < finalVideo.length; v++) {
          var vi = finalVideo[v];
          if (vi < 0 || vi >= activeSequence.videoTracks.numTracks) continue;
          if (activeSequence.videoTracks[vi].clips.numItems === 0) continue;
          targets.push({ kind: "video", index: vi, dom: activeSequence.videoTracks[vi] });
        }
        for (var a = 0; a < finalAudio.length; a++) {
          var ai = finalAudio[a];
          if (ai < 0 || ai >= activeSequence.audioTracks.numTracks) continue;
          if (activeSequence.audioTracks[ai].clips.numItems === 0) continue;
          targets.push({ kind: "audio", index: ai, dom: activeSequence.audioTracks[ai] });
        }
        if (targets.length === 0) return JSON.stringify({ success: false, error: "no non-empty target tracks" });

        // ---- source-clip time -> timeline time ------------------------------
        // The analyzers measure time inside the source file. A timeline clip may
        // start anywhere and be trimmed, so each source span is intersected with
        // every clip that uses that media and shifted by (clipStart - clipIn).
        function normPath(p) { return String(p).replace(/\\\\/g, "/").toLowerCase(); }

        var wantList = [];
        for (var wv = 0; wv < sourceMediaPathVariants.length; wv++) wantList.push(normPath(sourceMediaPathVariants[wv]));
        function pathMatches(mp) {
          var got = normPath(mp);
          for (var w = 0; w < wantList.length; w++) if (got === wantList[w]) return true;
          return false;
        }

        function collectSourceClips() {
          var found = [];
          for (var t = 0; t < targets.length; t++) {
            var track = targets[t].dom;
            for (var c = 0; c < track.clips.numItems; c++) {
              var clip = track.clips[c];
              var mp = "";
              try { mp = clip.projectItem ? clip.projectItem.getMediaPath() : ""; } catch (e) { mp = ""; }
              if (!mp || !pathMatches(mp)) continue;
              found.push({
                tStart: clip.start.seconds,
                sIn: clip.inPoint.seconds,
                sOut: clip.outPoint.seconds
              });
            }
          }
          return found;
        }

        var mappedFromSource = 0;
        if (sourceTimes) {
          var srcClips = collectSourceClips();
          if (srcClips.length === 0) {
            return JSON.stringify({ success: false, error: "no timeline clip references sourceMediaPath: " + sourceMediaPath });
          }
          var mapped = [];
          for (var i = 0; i < spans.length; i++) {
            for (var c2 = 0; c2 < srcClips.length; c2++) {
              var cl = srcClips[c2];
              var s0 = Math.max(spans[i].start, cl.sIn);
              var e0 = Math.min(spans[i].end, cl.sOut);
              if (e0 - s0 <= eps) continue;
              mapped.push({ start: cl.tStart + (s0 - cl.sIn), end: cl.tStart + (e0 - cl.sIn) });
            }
          }
          if (mapped.length === 0) {
            return JSON.stringify({ success: false, error: "none of the source spans fall inside the trimmed range of any timeline clip" });
          }
          mappedFromSource = srcClips.length;
          spans = mapped;
        }

        // Normalize: merge overlaps, then order right-to-left so that removing a
        // later span never invalidates an earlier span's timecodes.
        spans.sort(function (x, y) { return x.start - y.start; });
        var merged = [];
        for (var m = 0; m < spans.length; m++) {
          var last = merged.length ? merged[merged.length - 1] : null;
          if (last && spans[m].start <= last.end + eps) {
            if (spans[m].end > last.end) last.end = spans[m].end;
          } else {
            merged.push({ start: spans[m].start, end: spans[m].end });
          }
        }
        merged.sort(function (x, y) { return y.start - x.start; });
        spans = merged;

        // ---- A/V sync pre-flight -------------------------------------------
        // A ripple delete only pulls up the track it ran on. If one track has
        // content across the span and another does not, the tracks end up
        // shifted by different amounts and audio drifts off the picture. So
        // measure coverage per track first and refuse the uneven spans.
        function coverage(track, span) {
          var cov = 0;
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            if (clip.end.seconds <= span.start) continue;
            if (clip.start.seconds >= span.end) break;
            var s1 = Math.max(clip.start.seconds, span.start);
            var e1 = Math.min(clip.end.seconds, span.end);
            if (e1 > s1) cov += e1 - s1;
          }
          return cov;
        }

        var applySpans = [];
        var skipped = [];
        for (var i2 = 0; i2 < spans.length; i2++) {
          var span = spans[i2];
          if (!isRipple) { applySpans.push(span); continue; }
          var minCov = -1, maxCov = -1, worst = "";
          for (var t2 = 0; t2 < targets.length; t2++) {
            var cov = coverage(targets[t2].dom, span);
            if (minCov < 0 || cov < minCov) { minCov = cov; worst = targets[t2].kind + targets[t2].index; }
            if (cov > maxCov) maxCov = cov;
          }
          if (maxCov - minCov > eps) {
            skipped.push({
              start: span.start, end: span.end,
              startTc: toTc(span.start), endTc: toTc(span.end),
              reason: "uneven track coverage (" + Math.round(minCov * 1000) / 1000 + "s on " + worst + " vs " + Math.round(maxCov * 1000) / 1000 + "s) - ripple would desync audio from video",
              thinnestTrack: worst
            });
            continue;
          }
          applySpans.push(span);
        }

        var plan = [];
        for (var p = 0; p < applySpans.length; p++) {
          plan.push({ start: applySpans[p].start, end: applySpans[p].end, startTc: toTc(applySpans[p].start), endTc: toTc(applySpans[p].end) });
        }

        var trackLabels = [];
        for (var t3 = 0; t3 < targets.length; t3++) trackLabels.push(targets[t3].kind + targets[t3].index);

        if (dryRun) {
          return JSON.stringify({
            success: true, dryRun: true,
            sequenceId: activeSequence.sequenceID, fps: fps,
            sourceTimes: sourceTimes, sourceClipsMatched: mappedFromSource,
            spanCount: applySpans.length, skippedCount: skipped.length,
            tracks: trackLabels, plan: plan, skipped: skipped
          });
        }

        if (applySpans.length === 0) {
          return JSON.stringify({ success: false, error: "every span was rejected by the A/V sync check", skipped: skipped });
        }

        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return JSON.stringify({ success: false, error: "QE active sequence unavailable" });

        // ---- razor pass -----------------------------------------------------
        // One razor per unique boundary per track. Previously each span rescanned
        // every clip on every track, so cost grew with spans x tracks x clips;
        // 200+ silence cuts made that crawl. Now: cut everything, then sweep each
        // track's clip list exactly once.
        var qeTracks = [];
        for (var t4 = 0; t4 < targets.length; t4++) {
          qeTracks.push(targets[t4].kind === "video" ? qeSeq.getVideoTrackAt(targets[t4].index) : qeSeq.getAudioTrackAt(targets[t4].index));
        }

        var razorCount = 0;
        for (var t5 = 0; t5 < targets.length; t5++) {
          var qt = qeTracks[t5];
          if (!qt) continue;
          for (var s2 = 0; s2 < applySpans.length; s2++) {
            qt.razor(toTc(applySpans[s2].end));
            qt.razor(toTc(applySpans[s2].start));
            razorCount += 2;
          }
        }

        // ---- delete pass ----------------------------------------------------
        var removedCount = 0;
        var removedPerTrack = {};
        // Match by MIDPOINT, not by containment. razor() lands on a frame
        // boundary, so a segment cut for span [a,b] can start or end up to a
        // full frame outside it. The old test (start >= a - eps && end <= b + eps,
        // eps = half a frame) then rejected the very segment it had just cut, and
        // the span was silently left on the timeline while the call still
        // reported success. Because razors exist at every boundary, no clip can
        // straddle one, so "midpoint inside the span" identifies exactly the
        // segments to drop and is immune to frame rounding.
        function inAnySpan(clip) {
          var mid = (clip.start.seconds + clip.end.seconds) / 2;
          for (var s3 = 0; s3 < applySpans.length; s3++) {
            if (mid > applySpans[s3].start && mid < applySpans[s3].end) return true;
          }
          return false;
        }

        for (var t6 = 0; t6 < targets.length; t6++) {
          var domTrack = targets[t6].dom;
          var label = targets[t6].kind + targets[t6].index;
          var removedSec = 0;
          // Reverse sweep: removing a clip with ripple only shifts what follows,
          // so indices at or below the current one stay valid.
          for (var c3 = domTrack.clips.numItems - 1; c3 >= 0; c3--) {
            var clip2 = domTrack.clips[c3];
            if (!inAnySpan(clip2)) continue;
            removedSec += clip2.end.seconds - clip2.start.seconds;
            clip2.remove(isRipple, true);
            removedCount++;
          }
          removedPerTrack[label] = Math.round(removedSec * 1000) / 1000;
        }

        // ---- post-flight sync verification ----------------------------------
        var durations = [];
        for (var k in removedPerTrack) { if (removedPerTrack.hasOwnProperty(k)) durations.push(removedPerTrack[k]); }
        var dMin = durations.length ? durations[0] : 0, dMax = durations.length ? durations[0] : 0;
        for (var d = 1; d < durations.length; d++) {
          if (durations[d] < dMin) dMin = durations[d];
          if (durations[d] > dMax) dMax = durations[d];
        }
        var inSync = !isRipple || (dMax - dMin) <= eps;

        // ---- did we actually cut what we planned? ---------------------------
        // Guard against the failure mode where razors land but the delete pass
        // matches nothing: without this the call returns success while the
        // timeline is untouched. Tolerance is one frame per span, since each
        // razor may round by up to that much.
        var plannedSec = 0;
        for (var ps = 0; ps < applySpans.length; ps++) plannedSec += applySpans[ps].end - applySpans[ps].start;
        plannedSec = Math.round(plannedSec * 1000) / 1000;
        var appliedTol = (applySpans.length + 1) / fps;
        var shortfall = Math.round((plannedSec - dMax) * 1000) / 1000;
        var fullyApplied = Math.abs(shortfall) <= appliedTol;

        return JSON.stringify({
          success: true,
          dryRun: false,
          plannedSec: plannedSec,
          fullyApplied: fullyApplied,
          shortfallSec: fullyApplied ? 0 : shortfall,
          applyWarning: fullyApplied ? null : "removed " + dMax + "s but planned " + plannedSec + "s - " + shortfall + "s was NOT cut; re-check the timeline before continuing",
          message: "Applied " + applySpans.length + " removals, removed " + removedCount + " clip segments" + (skipped.length ? " (" + skipped.length + " span(s) skipped by the sync check)" : ""),
          sequenceId: activeSequence.sequenceID,
          sequenceName: activeSequence.name,
          sourceTimes: sourceTimes,
          sourceClipsMatched: mappedFromSource,
          spanCount: applySpans.length,
          skippedCount: skipped.length,
          removedClipCount: removedCount,
          razorCount: razorCount,
          rippleDelete: isRipple,
          tracks: trackLabels,
          removedSecPerTrack: removedPerTrack,
          inSync: inSync,
          syncWarning: inSync ? null : "tracks lost different amounts of time (" + dMin + "s..." + dMax + "s) - check A/V alignment and undo if wrong",
          skipped: skipped,
          plan: plan
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: "QE DOM error: " + e.toString() });
      }
    `;

    const raw: any = await this.bridge.executeScript(script);
    if (dryRun) {
      if (!backupSequenceName) return raw;
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return JSON.stringify({ ...parsed, backupSequenceName });
      } catch { return raw; }
    }

    // A ripple can leave a hole behind while still reporting fullyApplied:true.
    // Re-query and let `verify` decide, so the caller never has to take the
    // mutation's own summary on trust.
    let withBackup: any = raw;
    if (backupSequenceName) {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        withBackup = JSON.stringify({ ...parsed, backupSequenceName });
      } catch { /* keep raw */ }
    }
    return await this.withVerification(withBackup, sequenceId);
  }

  // Effects and Transitions Implementation
  // FIX vs upstream: upstream silently ignored `parameters` (typed as `_parameters`).
  // This version:
  //   1. Adds the effect (current behavior)
  //   2. Locates the newly added component (matched by index = before+0; effects append)
  //   3. Dumps that component's properties (displayName + current value) so callers can see
  //      exactly which params are settable via flat property access (some effects hide their
  //      real params behind "Custom Setup / Editar..." dialogs and won't be settable this way)
  //   4. For each entry in `parameters`, attempts to set the matching property by displayName
  //      (exact match first, then case-insensitive whitespace-stripped match)
  //   5. Returns dump + per-param result so debugging is one round-trip



  // Audio Operations Implementation
  /**
   * High-level ducking helper. Computes a keyframe curve and delegates to
   * addAudioKeyframes (single source of truth for the locale-aware + calibrated
   * keyframe write).
   *
   * For each ducking window, emits 4 keyframes:
   *   - pre-fade  (window.startTime - fadeSeconds): baseDb
   *   - duck-in   (window.startTime):               duckedDb
   *   - duck-out  (window.endTime):                 duckedDb
   *   - post-fade (window.endTime + fadeSeconds):   baseDb
   *
   * Plus boundary keyframes at clipStartTime (or 0) and clipEndTime
   * (or last window.endTime + 1s) anchored to baseDb. Result: a continuous
   * curve that sits at baseDb except inside duck windows.
   *
   * Replaces the manual Sprint 3 "8 keyframes per video" pattern.
   */
  //
  // Sets the audio clip volume in dB (relative gain on the clip's Volume component, NOT track mixer).
  //
  // FIX vs upstream:
  //   - Upstream looked for property `displayName === "Volume"` iterating ALL component properties.
  //     That's wrong: "Volume" is a COMPONENT name, and its level property is "Level" (en) / "Nivel" (es).
  //   - Upstream passed `level` (dB) directly to setValue, but Premiere ExtendScript expects a
  //     linear scale (1.0 = 0 dB, 1.4454 = +3.2 dB). Conversion: linear = 10^(dB/20).
  //   - Now supports localized component names (Spanish "Volumen", English "Volume", others).
  //   - On not-found, returns a dump of clip components+properties for debugging.

  // Text and Graphics Implementation
  // Color Correction Implementation
  // Export and Rendering Implementation
  private async exportSequence(sequenceId: string, outputPath: string, presetPath?: string, format?: string, quality?: string, resolution?: string): Promise<any> {
    // app.encoder.encodeSequence() expects an absolute path to a .epr preset file.
    // Passing a string name like "H.264" silently fails: encodeSequence returns
    // no jobID and the JSX bridge reports {success:false}. Reject early with a
    // clear error rather than letting the user think a queue happened.
    if (!presetPath) {
      return {
        success: false,
        error: 'presetPath required — must be absolute path to a .epr preset file (Adobe encodeSequence does not accept format names like "H.264" or "ProRes")',
        hint: 'Create the preset in AME UI: File → Export Settings → configure → Save Preset → exports to ~/Library/Application Support/Adobe/Common/AME/<version>/Presets/. Pass that .epr path as presetPath.',
        sequenceId,
        outputPath,
        format,
        quality,
        resolution,
      };
    }

    try {
      // bridge.renderSequence returns a structured response; propagate it instead
      // of unconditionally claiming success. Pre-fix wrapper reported success even
      // when AME never received the job (false-success false positives).
      const result = await this.bridge.renderSequence(sequenceId, outputPath, presetPath);

      if (result && result.success === false) {
        return {
          ...result,
          sequenceId,
          outputPath,
          format,
          quality,
          resolution,
        };
      }

      return {
        success: true,
        message: 'Sequence queued in Adobe Media Encoder. Render runs asynchronously — verify by checking the output file size growth.',
        sequenceId,
        outputPath,
        presetPath,
        format,
        quality,
        resolution,
        jobID: result?.jobID,
        queued: result?.queued,
        verify: `ffprobe -show_entries format=duration,size '${outputPath}'`,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to export sequence: ${error instanceof Error ? error.message : String(error)}`,
        sequenceId,
        outputPath,
      };
    }
  }

  private async exportFrame(sequenceId: string, time: number, outputPath: string, format = 'png'): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence("${sequenceId}");
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: ${sequenceId}" });

        if (sequence.openInTimeline) {
          try { sequence.openInTimeline(); } catch (e0) {}
        }

        app.enableQE();
        var qeSequence = qe.project.getActiveSequence();
        if (!qeSequence) {
          return JSON.stringify({ success: false, error: "QE active sequence not available for frame export" });
        }

        var methodName = "${format}" === "jpg" ? "exportFrameJPEG" : ("${format}" === "tiff" ? "exportFrameTiff" : "exportFramePNG");
        if (typeof qeSequence[methodName] !== "function") {
          return JSON.stringify({
            success: false,
            error: "Frame export format '" + "${format}" + "' is not supported by the available Premiere API"
          });
        }

        var timeNumber = ${time};
        var timeString = String(timeNumber);
        var timeTicks = timeString;
        try {
          var exportTime = new Time();
          exportTime.seconds = timeNumber;
          timeTicks = exportTime.ticks;
        } catch (e1) {}

        var exportError = null;
        function tryExport(arg1, arg2) {
          try {
            qeSequence[methodName](arg1, arg2);
            return true;
          } catch (e2) {
            exportError = e2.toString();
            return false;
          }
        }

        var exported =
          tryExport(timeNumber, "${outputPath}") ||
          tryExport("${outputPath}", timeNumber) ||
          tryExport(timeString, "${outputPath}") ||
          tryExport("${outputPath}", timeString) ||
          tryExport(timeTicks, "${outputPath}") ||
          tryExport("${outputPath}", timeTicks);

        if (!exported) {
          return JSON.stringify({
            success: false,
            error: exportError || "Frame export failed"
          });
        }

        return JSON.stringify({
          success: true,
          message: "Frame exported successfully",
          sequenceId: "${sequenceId}",
          time: ${time},
          outputPath: "${outputPath}",
          format: "${format}"
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  // Advanced Features Implementation


  // ============================================
  // NEW TOOLS IMPLEMENTATION
  // ============================================

  // Markers Implementation


  // Track Management Implementation
  // FIX vs upstream: upstream called qeSeq.addTracks(numVideo, numAudio, 0) which interpreted
  // the 3rd arg as videoInsertIndex = 0, meaning "insert NEW track AT INDEX 0", pushing all
  // existing tracks up by 1. This destroyed V1's content positioning relative to track names
  // and caused MOGRT inserts to land on the wrong track.
  //
  // QE DOM signature: Sequence.addTracks(videoCount, videoInsertIndex, audioCount,
  //   audioInsertIndex, audioMediaType, audioSubmixCount, audioSubmixInsertIndex)
  //
  // Now we honor the `position` param:
  //   - "above" (default) → insert at index = numVideoTracks (becomes new TOP track,
  //     existing tracks keep their indices)
  //   - "below" → insert at 0 (legacy behavior, pushes existing up — only useful in special
  //     cases since V1 in Premiere's UI is the bottom)






  // BULK helper: apply same audio effect + parameters to all audio clips of a sequence in ONE
  // ExtendScript round-trip. Activates the target sequence first (QE DOM operates on active).
  // Returns per-clip results with valueAfter readback for the SET parameters.

  // Nested Sequences


  // Additional Clip Operations




  // Project Settings


  private async getClipProperties(clipId: string, sequenceId?: string): Promise<any> {
    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)}, ${sequenceId ? JSON.stringify(sequenceId) : 'null'});
        if (!info) return JSON.stringify({ success: false, error: ${sequenceId ? JSON.stringify(`Clip not found in sequence: ${sequenceId}`) : '"Clip not found"'} });
        var clip = info.clip;
        return JSON.stringify({
          success: true,
          properties: {
            name: clip.name,
            start: clip.start.seconds,
            end: clip.end.seconds,
            duration: clip.duration.seconds,
            inPoint: clip.inPoint.seconds,
            outPoint: clip.outPoint.seconds,
            enabled: !clip.disabled,
            trackIndex: info.trackIndex,
            trackType: info.trackType,
            sequenceId: info.sequenceId,
            sequenceName: info.sequenceName,
            speed: clip.getSpeed()
          }
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;
    return await this.bridge.executeScript(script);
  }


  // Render Queue


  // Playhead & Work Area Implementation



  // Effect & Transition Discovery Implementation




  // Keyframe Implementation



  // Work Area Implementation


  // Batch Operations Implementation

  // Project Item Discovery & Management Implementation


  // Active Sequence Management Implementation
  private async setActiveSequence(sequenceId: string): Promise<any> {
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        app.project.openSequence(seq.sequenceID);
        return JSON.stringify({
          success: true,
          message: "Active sequence set",
          sequenceId: seq.sequenceID,
          name: seq.name
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  private async getActiveSequence(): Promise<any> {
    const script = `
      try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ success: false, error: "No active sequence" });
        return JSON.stringify({
          success: true,
          id: seq.sequenceID,
          name: seq.name,
          duration: __ticksToSeconds(seq.end),
          videoTrackCount: seq.videoTracks.numTracks,
          audioTrackCount: seq.audioTracks.numTracks
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Clip Lookup Implementation

  // Auto Reframe Implementation
  // Scene Edit Detection Implementation
  // Caption Track Implementation
  private async createCaptionTrack(sequenceId: string, projectItemId: string, startTime?: number, captionFormat?: string): Promise<any> {
    const startTimeVal = startTime || 0;
    const formatVal = captionFormat || 'Subtitle Default';
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: ${sequenceId}" });
        var projectItem = __findProjectItem(${JSON.stringify(projectItemId)});
        if (!projectItem) return JSON.stringify({ success: false, error: "Caption project item not found" });

        // createCaptionTrack wants ticks (string) for the start time and an integer
        // caption-format constant. Passing seconds-as-number and a format *name*
        // is what produced "Illegal Parameter type" on every call.
        //   0 = Subtitle, 1 = CEA-608, 2 = CEA-708, 3 = Teletext, 4 = EBU, 5 = OP-47
        var FORMATS = { "subtitle": 0, "subtitle default": 0, "cea-608": 1, "cea608": 1,
                        "cea-708": 2, "cea708": 2, "teletext": 3, "ebu": 4, "op-47": 5, "op47": 5 };
        var wanted = ${JSON.stringify(String(formatVal).toLowerCase())};
        var formatCode = FORMATS.hasOwnProperty(wanted) ? FORMATS[wanted] : 0;
        var startTicks = __secondsToTicks(${startTimeVal});

        var attempts = [];
        var made = false, lastErr = null;
        // Signature varies across builds; try ticks-string first, then a Time
        // object, then the 2-arg form.
        var tries = [
          function () { sequence.createCaptionTrack(projectItem, startTicks, formatCode); },
          function () { var t = new Time(); t.seconds = ${startTimeVal}; sequence.createCaptionTrack(projectItem, t, formatCode); },
          function () { sequence.createCaptionTrack(projectItem, startTicks); }
        ];
        for (var i = 0; i < tries.length && !made; i++) {
          try { tries[i](); made = true; attempts.push("form" + (i + 1) + ":ok"); }
          catch (e) { lastErr = e.toString(); attempts.push("form" + (i + 1) + ":" + lastErr); }
        }
        if (!made) return JSON.stringify({ success: false, error: lastErr || "createCaptionTrack failed", attempts: attempts });

        return JSON.stringify({
          success: true,
          message: "Caption track created",
          captionFormat: formatCode,
          startTime: ${startTimeVal},
          attempts: attempts
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Subclip Implementation

  // Relink Media Implementation

  // Set Color Label Implementation

  // Get Color Label Implementation

  // Get Metadata Implementation

  // Set Metadata Implementation

  // Get Footage Interpretation Implementation

  // Set Footage Interpretation Implementation

  // Check Offline Media Implementation

  // Export as FCP XML Implementation

  // Undo Implementation
  private async undo(): Promise<any> {
    const script = `
      try {
        app.enableQE();
        qe.project.undo();
        return JSON.stringify({
          success: true,
          message: "Undo performed"
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Set Sequence In/Out Points Implementation

  // Get Sequence In/Out Points Implementation

  // Export AAF Implementation

  // Consolidate Duplicates Implementation

  // Refresh Media Implementation

  // Import Sequences From Project Implementation

  // Create Subsequence Implementation
  // Import MOGRT Implementation

  // Import MOGRT From Library Implementation

  // Manage Proxies Implementation
}
