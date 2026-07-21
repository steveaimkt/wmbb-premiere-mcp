/**
 * MCP Tools for Adobe Premiere Pro
 * 
 * This module provides tools that can be called by AI agents to perform
 * various video editing operations in Adobe Premiere Pro.
 */

import { z } from 'zod';
import type { PremiereProTransport } from '../bridge/types.js';
import { Logger } from '../utils/logger.js';
import { analyzeAudioEditPoints } from '../utils/audioAnalysis.js';
import { analyzeSpeechEditPoints } from '../utils/speechAnalysis.js';
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
        description: 'Lists all video and audio tracks in a specific sequence with their properties and clips.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to list tracks for')
        })
      },
      {
        name: 'get_project_info',
        description: 'Gets comprehensive information about the current project including name, path, settings, and status.',
        inputSchema: z.object({})
      },

      // Project Management
      {
        name: 'open_project',
        description: 'Opens an existing Adobe Premiere Pro project from a specified file path.',
        inputSchema: z.object({
          path: z.string().describe('The absolute path to the .prproj file to open')
        })
      },
      {
        name: 'save_project',
        description: 'Saves the currently active Adobe Premiere Pro project.',
        inputSchema: z.object({})
      },

      // Media Management
      {
        name: 'import_media',
        description: 'Imports a media file (video, audio, image) into the current Premiere Pro project.',
        inputSchema: z.object({
          filePath: z.string().describe('The absolute path to the media file to import'),
          binName: z.string().optional().describe('The name of the bin to import the media into. If not provided, it will be imported into the root.')
        })
      },

      // Sequence Management
      {
        name: 'create_sequence',
        description: 'Creates a new sequence in the project. A sequence is a timeline where you edit clips.',
        inputSchema: z.object({
          name: z.string().describe('The name for the new sequence'),
          presetPath: z.string().optional().describe('Optional path to a sequence preset file for custom settings'),
          width: z.number().optional().describe('Sequence width in pixels'),
          height: z.number().optional().describe('Sequence height in pixels'),
          frameRate: z.number().optional().describe('Frame rate (e.g., 24, 25, 30, 60)'),
          sampleRate: z.number().optional().describe('Audio sample rate (e.g., 48000)')
        })
      },
      {
        name: 'duplicate_sequence',
        description: 'Creates a copy of an existing sequence with a new name.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to duplicate'),
          newName: z.string().describe('The name for the new sequence copy')
        })
      },
      {
        name: 'delete_sequence',
        description: 'Deletes a sequence from the project.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to delete')
        })
      },

      // Timeline Operations
      {
        name: 'add_to_timeline',
        description: 'Adds a media clip from the project panel to a sequence timeline at a specific track and time.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence (timeline) to add the clip to'),
          projectItemId: z.string().describe('The ID of the project item (clip) to add'),
          trackIndex: z.number().describe('The index of the video or audio track (0-based)'),
          time: z.number().describe('The time in seconds where the clip should be placed on the timeline'),
          insertMode: z.enum(['overwrite', 'insert']).optional().describe('Whether to overwrite existing content or insert and shift'),
          linkAudio: z.boolean().optional().describe('When false, removes the auto-linked audio counterpart that Premiere places on audio tracks for video-track clips. Useful for video overlays whose source media (e.g. Remotion .mov outputs) carry silent PCM that would overwrite existing audio. Default true (preserves Premiere\'s native linking behavior).')
        })
      },
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
        name: 'move_clip',
        description: 'Moves a clip to a different position on the timeline.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip to move'),
          newTime: z.number().describe('The new time position in seconds'),
          newTrackIndex: z.number().optional().describe('The new track index (if moving to different track)')
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
        name: 'analyze_audio_edit_points',
        description: 'Analyzes a media file\'s AUDIO with ffmpeg (no Premiere needed) to find real edit points based on silence. Returns silence regions, speech segments, and the exact razor cut points needed to remove the silences. Use this FIRST to place cuts on actual audio data instead of guessing timecodes. Get the file path from list_project_items (mediaPath field). Times are absolute seconds within the source clip.',
        inputSchema: z.object({
          filePath: z.string().describe('Absolute path to the media file (video or audio) to analyze. Typically the mediaPath from list_project_items.'),
          noiseThresholdDb: z.number().optional().describe('Level (dB) below which audio counts as silence. Default -30. Lower (e.g. -40) is stricter; higher (e.g. -20) treats quieter parts as silence.'),
          minSilenceSec: z.number().optional().describe('Ignore silences shorter than this many seconds. Default 0.5. Raise to avoid cutting natural breathing pauses.'),
          paddingSec: z.number().optional().describe('Seconds of silence kept around each speech segment so speech is not clipped. Default 0.1.')
        })
      },
      {
        name: 'analyze_speech_edit_points',
        description: 'Transcribes a media file with Whisper (word-level) and finds edit points from the SPEECH CONTENT: (1) duplicate/repeated takes where the speaker flubbed a line and said it again (the earlier take is flagged for removal), and (2) silence gaps between words. Returns removal spans + razor cut points + the full transcript with timestamps. Use this for precise cut editing of talking-head footage. Slower than analyze_audio_edit_points but content-aware. Requires Python + faster-whisper.',
        inputSchema: z.object({
          filePath: z.string().describe('Absolute path to the media file (video or audio) to analyze. Typically the mediaPath from list_project_items.'),
          model: z.string().optional().describe('Whisper model size: tiny/base/small/medium/large-v3. Default "base" (fast). Use "small"/"medium" for higher accuracy.'),
          language: z.string().optional().describe('Language code (e.g. "ko", "en") or "auto" to detect. Default "ko".'),
          similarityThreshold: z.number().optional().describe('0..1 text-match to treat two takes as duplicates. Default 0.75. Lower catches looser repeats; higher only near-identical.'),
          minGapSec: z.number().optional().describe('Silence gap (seconds) between words to flag as trimmable. Default 0.6.'),
          paddingSec: z.number().optional().describe('Silence (seconds) kept at each end of a trimmed gap so the cut keeps its breath. Default 0.15. Set 0 to close gaps completely.'),
          removeFillers: z.boolean().optional().describe('Also flag filler words ("음", "uh", "um") for removal. Default false.'),
          fillerWords: z.array(z.string()).optional().describe(`Filler tokens to cut. Defaults to the unambiguous set: ${DEFAULT_FILLERS.join(', ')}. Korean single syllables like "그"/"뭐"/"이제" are excluded by default because they are also ordinary words — add them only when you know the take.`)
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
        name: 'auto_cut_edit',
        description: 'One-shot cut edit: analyzes the speech in the sequence\'s media, then removes silences, repeated takes and (optionally) filler words from the timeline, and writes captions. Runs as a DRY RUN by default so you can read the plan and approve it before anything is touched. Resolves the media file from the timeline itself when mediaPath is omitted, backs the sequence up before cutting, and converts source-clip times to timeline times, so the whole chain is one call instead of five.',
        inputSchema: z.object({
          sequenceId: z.string().optional().describe('Sequence to edit. Defaults to the active sequence.'),
          mediaPath: z.string().optional().describe('Media file to analyze. Omit to use the first clip on the lowest targeted video track.'),
          scriptPath: z.string().optional().describe('Reference script/narration. Used to correct misrecognitions before captions are written.'),
          dryRun: z.boolean().optional().describe('Return the plan without touching the timeline. DEFAULT TRUE — pass false to actually cut.'),
          backup: z.boolean().optional().describe('Duplicate the sequence before cutting so the original survives. Default true.'),
          removeFillers: z.boolean().optional().describe('Also cut filler words ("음", "uh"). Default false.'),
          fillerWords: z.array(z.string()).optional().describe('Filler tokens to cut. Defaults to the unambiguous set.'),
          minGapSec: z.number().optional().describe('Silence between words (seconds) to treat as trimmable. Default 0.6.'),
          paddingSec: z.number().optional().describe('Silence kept at each end of a trimmed gap. Default 0.15.'),
          similarityThreshold: z.number().optional().describe('0..1 match to treat two takes as duplicates. Default 0.75.'),
          captions: z.boolean().optional().describe('Write a subtitle file after cutting. Default true. Ignored on a dry run.'),
          captionFormat: z.enum(['srt', 'vtt', 'txt']).optional().describe('Subtitle format. Default srt.'),
          model: z.string().optional().describe('Whisper model size. Default "base".'),
          language: z.string().optional().describe('Language code or "auto". Default "ko".'),
          videoTrackIndices: z.array(z.number().int().min(0)).optional().describe('Video tracks to cut. Defaults to all.'),
          audioTrackIndices: z.array(z.number().int().min(0)).optional().describe('Audio tracks to cut. Defaults to all.')
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
        name: 'make_short',
        description: 'Extracts a vertical (or square) short-form clip from a range of the timeline: creates a subsequence of that range, then auto-reframes it to the target aspect so the speaker stays in frame. Use find_speech_spans to locate the moment by what was said, then feed its start/end here.',
        inputSchema: z.object({
          start: z.number().describe('Range start in timeline seconds.'),
          end: z.number().describe('Range end in timeline seconds.'),
          sequenceId: z.string().optional().describe('Source sequence. Defaults to the active sequence.'),
          name: z.string().optional().describe('Name for the resulting sequence. Defaults to "<source> short <start>-<end>".'),
          aspect: z.enum(['9:16', '1:1', '4:5', '16:9']).optional().describe('Target aspect ratio. Default 9:16 (Reels/Shorts/TikTok).'),
          motionPreset: z.enum(['slower', 'default', 'faster']).optional().describe('Auto-reframe tracking responsiveness. Default "default".'),
          reframe: z.boolean().optional().describe('Run auto-reframe. Default true. Set false to only cut the subsequence.')
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
      {
        name: 'add_transition_to_clip',
        description: 'Adds a transition to the beginning or end of a single clip.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          transitionName: z.string().describe('The name of the transition'),
          position: z.enum(['start', 'end']).describe('Whether to add the transition at the start or end of the clip'),
          duration: z.number().describe('The duration of the transition in seconds')
        })
      },

      // Audio Operations
      {
        name: 'adjust_audio_levels',
        description: 'Adjusts the volume (gain) of an audio clip on the timeline.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the audio clip to adjust'),
          level: z.number().describe('The new audio level in decibels (dB). Can be positive or negative.')
        })
      },
      {
        name: 'setup_ducking',
        description:
          'High-level wrapper around add_audio_keyframes that builds a ducking curve from a base level + ducking windows. ' +
          'Computes 4 keyframes per window (pre-fade, duck-in, duck-out, post-fade) plus boundary keyframes at clip start/end. ' +
          'Replaces the manual "8 keyframes per video" pattern from Sprint 3. Times are clip-source-time absolute (same convention as add_audio_keyframes).',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the music/SFX clip to apply ducking to'),
          baseDb: z.number().describe('Sustained level in dB (e.g. -25 for music bed under voice)'),
          duckingWindows: z
            .array(
              z.object({
                startTime: z.number().describe('When to begin ducking, in seconds (clip-source-time absolute)'),
                endTime: z.number().describe('When to recover from ducking, in seconds'),
                duckedDb: z.number().describe('Lower level in dB during this window (e.g. -38 for narrative pause)'),
              })
            )
            .describe('Windows where the clip should duck below baseDb. Empty array = sustained baseDb only.'),
          fadeSeconds: z
            .number()
            .optional()
            .describe('Ramp time for each transition (default 0.2s = 6 frames @30fps)'),
          clipStartTime: z
            .number()
            .optional()
            .describe('Clip start time anchor for first keyframe (default 0)'),
          clipEndTime: z
            .number()
            .optional()
            .describe('Clip end time anchor for last keyframe; if omitted, last duck window endTime + 1s is used'),
        }),
      },

      // Text and Graphics
      {
        name: 'add_text_overlay',
        description: 'Adds a text layer (title) over the video timeline. Requires a MOGRT (.mogrt) template file path. Supports up to 4 text fields (text, text2, text3, text4) — each populates the Nth "AE.ADBE Text" component in the MOGRT (e.g., for Basic Lower Third: text=main title, text2=subtitle).',
        inputSchema: z.object({
          text: z.string().describe('Text for the first AE text component in the MOGRT (typically the main title)'),
          text2: z.string().optional().describe('Text for the second AE text component (e.g., subtitle of a lower third)'),
          text3: z.string().optional().describe('Text for the third AE text component (if present)'),
          text4: z.string().optional().describe('Text for the fourth AE text component (if present)'),
          sequenceId: z.string().describe('The sequence to add the text to'),
          trackIndex: z.number().describe('The video track to place the text on (0-indexed; create the track first via add_track if needed)'),
          startTime: z.number().describe('The time in seconds when the text should appear'),
          duration: z.number().describe('How long the text should remain on screen in seconds (best-effort; the MOGRT\'s natural duration may take precedence)'),
          mogrtPath: z.string().optional().describe('Absolute path to a .mogrt template file (required for text overlays)'),
          textPropertyName: z.string().optional().describe('Override: explicit displayName of the property to write into. When set, only `text` is written (text2/text3/text4 are ignored) and the call fails if no property with that displayName exists. Use only when auto-detection picks the wrong field.')
        })
      },

      // Color Correction
      {
        name: 'color_correct',
        description: 'Applies basic color correction adjustments to a video clip.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip to color correct'),
          brightness: z.number().optional().describe('Brightness adjustment (-100 to 100)'),
          contrast: z.number().optional().describe('Contrast adjustment (-100 to 100)'),
          saturation: z.number().optional().describe('Saturation adjustment (-100 to 100)'),
          hue: z.number().optional().describe('Hue adjustment in degrees (-180 to 180)'),
          highlights: z.number().optional().describe('Adjustment for the brightest parts of the image (-100 to 100)'),
          shadows: z.number().optional().describe('Adjustment for the darkest parts of the image (-100 to 100)'),
          temperature: z.number().optional().describe('Color temperature adjustment (-100 to 100)'),
          tint: z.number().optional().describe('Tint adjustment (-100 to 100)')
        })
      },
      {
        name: 'apply_lut',
        description: 'Applies a Look-Up Table (LUT) to a clip for color grading.',
        inputSchema: z.object({
          clipId: z.string().describe('The ID of the clip'),
          lutPath: z.string().describe('The absolute path to the .cube or .3dl LUT file'),
          intensity: z.number().optional().describe('LUT intensity (0-100)')
        })
      },

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
      {
        name: 'add_marker',
        description: 'Adds a marker to the timeline for navigation or notes.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to add the marker to'),
          time: z.number().describe('The time in seconds where the marker should be placed'),
          name: z.string().describe('The name/label for the marker'),
          comment: z.string().optional().describe('Optional comment or description for the marker'),
          color: z.string().optional().describe('Marker color (e.g., "red", "green", "blue")'),
          duration: z.number().optional().describe('Duration in seconds for a span marker (0 for point marker)')
        })
      },
      {
        name: 'list_markers',
        description: 'Lists all markers in a sequence.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence')
        })
      },

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
      {
        name: 'auto_reframe_sequence',
        description: 'Automatically reframes a sequence to a new aspect ratio using AI-powered motion tracking.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence to reframe'),
          numerator: z.number().describe('Aspect ratio numerator (e.g., 9 for 9:16)'),
          denominator: z.number().describe('Aspect ratio denominator (e.g., 16 for 9:16)'),
          motionPreset: z.enum(['slower', 'default', 'faster']).optional().describe('Motion tracking speed preset'),
          newName: z.string().optional().describe('Name for the reframed sequence')
        })
      },

      // Scene Edit Detection
      {
        name: 'detect_scene_edits',
        description: 'Detects scene changes in selected clips and optionally adds cuts or markers.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          action: z.enum(['ApplyCuts', 'CreateMarkers']).optional().describe('Action to take at detected edit points'),
          applyCutsToLinkedAudio: z.boolean().optional().describe('Whether to apply cuts to linked audio'),
          sensitivity: z.string().optional().describe('Detection sensitivity (e.g., "Low", "Medium", "High")')
        })
      },

      // Captions
      {
        name: 'create_caption_track',
        description: 'Creates a caption track from a caption/subtitle file.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the sequence'),
          projectItemId: z.string().describe('The ID of the caption file project item'),
          startTime: z.number().optional().describe('Start time in seconds for the captions'),
          captionFormat: z.string().optional().describe('Caption format (e.g., "Subtitle Default")')
        })
      },
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
      {
        name: 'create_subsequence',
        description: 'Creates a subsequence from the in/out points of a sequence.',
        inputSchema: z.object({
          sequenceId: z.string().describe('The ID of the source sequence'),
          ignoreTrackTargeting: z.boolean().optional().describe('Whether to ignore track targeting (default: false)')
        })
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
          return await this.listSequenceTracks(args.sequenceId);
        case 'get_project_info':
          return await this.getProjectInfo();
        case 'open_project':
          return await this.openProject(args.path);
        case 'save_project':
          return await this.saveProject();
        case 'import_media':
          return await this.importMedia(args.filePath, args.binName);
        case 'create_sequence':
          return await this.createSequence(args.name, args.presetPath, args.width, args.height, args.frameRate, args.sampleRate);
        case 'duplicate_sequence':
          return await this.duplicateSequence(args.sequenceId, args.newName);
        case 'delete_sequence':
          return await this.deleteSequence(args.sequenceId);
        case 'read_sequence_captions':
          return await this.readSequenceCaptions(args.sequenceId);
        case 'add_to_timeline':
          return await this.addToTimeline(args.sequenceId, args.projectItemId, args.trackIndex, args.time, args.insertMode, args.linkAudio);
        case 'remove_from_timeline':
          return await this.removeFromTimeline(args.clipId, args.sequenceId, args.deleteMode, args.removeLinked);
        case 'move_clip':
          return await this.moveClip(args.clipId, args.newTime, args.newTrackIndex);
        case 'trim_clip':
          return await this.trimClip(args.clipId, args.inPoint, args.outPoint, args.duration);
        case 'razor_timeline_at_time':
          return await this.razorTimelineAtTime(args.sequenceId, args.time, args.videoTrackIndices, args.audioTrackIndices);
        case 'analyze_audio_edit_points':
          return await this.analyzeAudioEditPoints(args.filePath, args.noiseThresholdDb, args.minSilenceSec, args.paddingSec);
        case 'analyze_speech_edit_points':
          return await this.analyzeSpeechEditPoints(args.filePath, args.model, args.language, args.similarityThreshold, args.minGapSec, args.paddingSec, args.removeFillers, args.fillerWords);
        case 'proofread_transcript':
          return await this.proofreadTranscript(args.filePath, args.scriptPath, args.model, args.language, args.confidenceThreshold, args.correctionThreshold);
        case 'export_captions':
          return await this.exportCaptions(args.filePath, args.outputPath, args.format, args.scriptPath, args.model, args.language, args.maxCharsPerLine, args.maxLines, args.maxDurationSec, args.minDurationSec, args.correctionThreshold, args.glossary, args.importToSequence);
        case 'find_speech_spans':
          return await this.findSpeechSpans(args.filePath, args.query, args.threshold, args.paddingSec, args.model, args.language);
        case 'auto_cut_edit':
          return await this.autoCutEdit(args);
        case 'backup_sequence':
          return await this.backupSequence(args.sequenceId, args.label);
        case 'restore_sequence_backup':
          return await this.restoreSequenceBackup(args.backupSequenceId, args.deleteDamaged, args.damagedSequenceId);
        case 'make_short':
          return await this.makeShort(args.start, args.end, args.sequenceId, args.name, args.aspect, args.motionPreset, args.reframe);
        case 'apply_timeline_removals':
          return await this.applyTimelineRemovals(args.sequenceId, args.removals, args.videoTrackIndices, args.audioTrackIndices, args.rippleDelete, args.dryRun, args.sourceTimes, args.sourceMediaPath, args.backup);

        // Effects and Transitions
        case 'add_transition_to_clip':
          return await this.addTransitionToClip(args.clipId, args.transitionName, args.position, args.duration);

        // Audio Operations
        case 'adjust_audio_levels':
          return await this.adjustAudioLevels(args.clipId, args.level);
        case 'setup_ducking':
          return await this.setupDucking(
            args.clipId,
            args.baseDb,
            args.duckingWindows,
            args.fadeSeconds,
            args.clipStartTime,
            args.clipEndTime
          );
        case 'add_text_overlay':
          return await this.addTextOverlay(args);

        // Color Correction
        case 'color_correct':
          return await this.colorCorrect(args.clipId, args);
        case 'apply_lut':
          return await this.applyLut(args.clipId, args.lutPath, args.intensity);

        // Export and Rendering
        case 'export_sequence':
          return await this.exportSequence(args.sequenceId, args.outputPath, args.presetPath, args.format, args.quality, args.resolution);
        case 'export_frame':
          return await this.exportFrame(args.sequenceId, args.time, args.outputPath, args.format);

        // Markers
        case 'add_marker':
          return await this.addMarker(args.sequenceId, args.time, args.name, args.comment, args.color, args.duration);
        case 'list_markers':
          return await this.listMarkers(args.sequenceId);

        // Track Management
        case 'get_clip_properties':
          return await this.getClipProperties(args.clipId, args.sequenceId);
        case 'set_active_sequence':
          return await this.setActiveSequence(args.sequenceId);
        case 'get_active_sequence':
          return await this.getActiveSequence();

        // Clip Lookup
        case 'auto_reframe_sequence':
          return await this.autoReframeSequence(args.sequenceId, args.numerator, args.denominator, args.motionPreset, args.newName);

        // Scene Edit Detection
        case 'detect_scene_edits':
          return await this.detectSceneEdits(args.sequenceId, args.action, args.applyCutsToLinkedAudio, args.sensitivity);

        // Captions
        case 'create_caption_track':
          return await this.createCaptionTrack(args.sequenceId, args.projectItemId, args.startTime, args.captionFormat);

        // Subclip
        case 'undo':
          return await this.undo();
        case 'create_subsequence':
          return await this.createSubsequence(args.sequenceId, args.ignoreTrackTargeting);
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

  private async listSequenceTracks(sequenceId: string): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence("${sequenceId}");
        if (!sequence) {
          sequence = app.project.activeSequence;
        }
        if (!sequence) {
          return JSON.stringify({
            success: false,
            error: "Sequence not found"
          });
        }

        var videoTracks = [];
        var audioTracks = [];

        for (var i = 0; i < sequence.videoTracks.numTracks; i++) {
          var track = sequence.videoTracks[i];
          var clips = [];

          for (var j = 0; j < track.clips.numItems; j++) {
            var clip = track.clips[j];
            clips.push({
              id: clip.nodeId,
              name: clip.name,
              startTime: clip.start.seconds,
              endTime: clip.end.seconds,
              duration: clip.duration.seconds
            });
          }

          videoTracks.push({
            index: i,
            name: track.name || "Video " + (i + 1),
            clips: clips,
            clipCount: clips.length
          });
        }

        for (var i = 0; i < sequence.audioTracks.numTracks; i++) {
          var track = sequence.audioTracks[i];
          var clips = [];

          for (var j = 0; j < track.clips.numItems; j++) {
            var clip = track.clips[j];
            clips.push({
              id: clip.nodeId,
              name: clip.name,
              startTime: clip.start.seconds,
              endTime: clip.end.seconds,
              duration: clip.duration.seconds
            });
          }

          audioTracks.push({
            index: i,
            name: track.name || "Audio " + (i + 1),
            clips: clips,
            clipCount: clips.length
          });
        }

        return JSON.stringify({
          success: true,
          sequenceId: "${sequenceId}",
          sequenceName: sequence.name,
          videoTracks: videoTracks,
          audioTracks: audioTracks,
          totalVideoTracks: videoTracks.length,
          totalAudioTracks: audioTracks.length
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

  private async openProject(path: string): Promise<any> {
    try {
      const result: any = await this.bridge.openProject(path);
      if (result?.success === false) {
        return {
          ...result,
          projectPath: result.projectPath || path
        };
      }

      return {
        success: true,
        message: `Project opened successfully`,
        projectPath: path,
        ...result
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to open project: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

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
  private async createSequence(name: string, presetPath?: string, _width?: number, _height?: number, _frameRate?: number, _sampleRate?: number): Promise<any> {
    try {
      const result: any = await this.bridge.createSequence(name, presetPath);
      if (result?.success === false) {
        return {
          ...result,
          sequenceName: result.sequenceName || name
        };
      }

      return {
        success: true,
        message: `Sequence "${name}" created successfully`,
        sequenceName: name,
        ...result
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timeout|timed out/i.test(message);
      return {
        success: false,
        error: `Failed to create sequence: ${message}`,
        sequenceName: name,
        ...(timedOut ? {
          warning: 'Premiere may still create the sequence after this timeout. Wait for the bridge to become responsive, then run list_sequences to verify before retrying. The server intentionally does not run automatic recovery after a timeout because that can wedge the CEP bridge on Windows.'
        } : {})
      };
    }
  }

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

  private async deleteSequence(sequenceId: string): Promise<any> {
    const script = `
      try {
        var sequence = __findSequence("${sequenceId}");
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });
        var sequenceName = sequence.name;
        app.project.deleteSequence(sequence);
        return JSON.stringify({
          success: true,
          message: "Sequence deleted successfully",
          deletedSequenceId: "${sequenceId}",
          deletedSequenceName: sequenceName
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  // Timeline Operations Implementation
  private async addToTimeline(sequenceId: string, projectItemId: string, trackIndex: number, time: number, insertMode = 'overwrite', linkAudio: boolean = true): Promise<any> {
    try {
      const result: any = await this.bridge.addToTimeline(sequenceId, projectItemId, trackIndex, time, linkAudio);
      if (!result.success) {
        return {
          ...result,
          sequenceId: sequenceId,
          projectItemId: projectItemId,
          trackIndex: trackIndex,
          time: time,
          insertMode: insertMode,
          linkAudio: linkAudio
        };
      }
      return {
        success: true,
        message: `Clip added to timeline successfully`,
        sequenceId: sequenceId,
        projectItemId: projectItemId,
        trackIndex: trackIndex,
        time: time,
        insertMode: insertMode,
        linkAudio: linkAudio,
        ...result
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to add clip to timeline: ${error instanceof Error ? error.message : String(error)}`,
        sequenceId: sequenceId,
        projectItemId: projectItemId,
        trackIndex: trackIndex,
        time: time
      };
    }
  }

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

  private async moveClip(clipId: string, newTime: number, _newTrackIndex?: number): Promise<any> {
    const script = `
      try {
        var info = __findClip("${clipId}");
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;
        var oldTime = clip.start.seconds;
        var shiftAmount = ${newTime} - oldTime;
        clip.move(shiftAmount);
        return JSON.stringify({
          success: true,
          message: "Clip moved successfully",
          clipId: "${clipId}",
          oldTime: oldTime,
          newTime: ${newTime},
          trackIndex: info.trackIndex
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

  private async analyzeAudioEditPoints(
    filePath?: string,
    noiseThresholdDb?: number,
    minSilenceSec?: number,
    paddingSec?: number,
  ): Promise<any> {
    if (!filePath) {
      return JSON.stringify({ success: false, error: 'filePath is required' });
    }
    try {
      const analysis = await analyzeAudioEditPoints(
        filePath,
        noiseThresholdDb ?? -30,
        minSilenceSec ?? 0.5,
        paddingSec ?? 0.1,
      );
      return JSON.stringify(analysis);
    } catch (e: any) {
      return JSON.stringify({ success: false, error: `audio analysis failed: ${e?.message || e}` });
    }
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
  ): Promise<any> {
    if (!filePath) {
      return JSON.stringify({ success: false, error: 'filePath is required' });
    }
    try {
      const analysis = await analyzeSpeechEditPoints(
        filePath,
        model ?? 'base',
        language ?? 'ko',
        similarityThreshold ?? 0.75,
        minGapSec ?? 0.6,
        paddingSec ?? 0.15,
        removeFillers ?? false,
        fillerWords && fillerWords.length ? fillerWords : DEFAULT_FILLERS,
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
   * Analyze -> plan -> (approve) -> cut -> caption, in one call.
   *
   * Defaults to a dry run. Cutting a timeline is destructive and the analysis
   * is a judgement call about someone's speech, so the plan is shown first and
   * the caller opts in to applying it.
   */
  private async autoCutEdit(args: any): Promise<any> {
    const dryRun = args.dryRun !== false;
    const wantCaptions = args.captions !== false;
    const steps: string[] = [];

    const seq = await this.resolveSequence(args.sequenceId);
    if ('error' in seq) return JSON.stringify({ success: false, stage: 'resolve-sequence', error: seq.error });
    steps.push(`sequence: ${seq.name}`);

    const mediaPath = args.mediaPath || (await this.resolveSequenceMedia(args.sequenceId));
    if (!mediaPath) {
      return JSON.stringify({
        success: false,
        stage: 'resolve-media',
        error: 'could not determine which media file to analyze. Pass mediaPath (see list_project_items -> mediaPath).',
      });
    }
    steps.push(`media: ${mediaPath}`);

    // 1. Analyze speech.
    let analysis: any;
    try {
      analysis = await analyzeSpeechEditPoints(
        mediaPath,
        args.model ?? 'base',
        args.language ?? 'ko',
        args.similarityThreshold ?? 0.75,
        args.minGapSec ?? 0.6,
        args.paddingSec ?? 0.15,
        args.removeFillers ?? false,
        args.fillerWords && args.fillerWords.length ? args.fillerWords : DEFAULT_FILLERS,
      );
    } catch (e: any) {
      return JSON.stringify({ success: false, stage: 'analyze', error: `speech analysis failed: ${e?.message || e}` });
    }
    if (!analysis.success) {
      return JSON.stringify({ success: false, stage: 'analyze', error: analysis.error });
    }
    if (!analysis.suggestedRemovals.length) {
      return JSON.stringify({
        success: true,
        stage: 'analyze',
        message: 'nothing to cut — no silences, repeated takes or fillers passed the thresholds',
        stats: analysis.stats,
        steps,
      });
    }
    steps.push(
      `found ${analysis.stats.silenceGapCount} silence gaps, ${analysis.stats.duplicateCount} repeated takes, ` +
      `${analysis.stats.fillerCount} fillers = ${analysis.stats.totalRemovableSec}s removable`,
    );

    // 2. Cut (or plan the cut).
    const removalsRaw: any = await this.applyTimelineRemovals(
      seq.id,
      analysis.suggestedRemovals.map((r: any) => ({ start: r.start, end: r.end })),
      args.videoTrackIndices,
      args.audioTrackIndices,
      true,
      dryRun,
      true,
      mediaPath,
      args.backup !== false,
    );
    const removals = typeof removalsRaw === 'string' ? JSON.parse(removalsRaw) : removalsRaw;
    if (!removals.success) {
      return JSON.stringify({ success: false, stage: 'apply', error: removals.error, skipped: removals.skipped, steps });
    }
    steps.push(dryRun ? `planned ${removals.spanCount} cuts` : `applied ${removals.spanCount} cuts`);

    if (dryRun) {
      return JSON.stringify({
        success: true,
        dryRun: true,
        message: `Plan ready: ${removals.spanCount} cuts removing about ${analysis.stats.totalRemovableSec}s. Re-run with dryRun:false to apply.`,
        sequence: seq.name,
        mediaPath,
        analysis: {
          stats: analysis.stats,
          duplicateTakes: analysis.duplicateTakes.slice(0, 10),
          fillerWords: analysis.fillerWords.slice(0, 20),
        },
        cutPlan: removals.plan?.slice(0, 40),
        cutPlanTruncated: (removals.plan?.length ?? 0) > 40,
        skipped: removals.skipped,
        steps,
      });
    }

    // 3. Captions, from the same cached transcript.
    let captions: any = null;
    if (wantCaptions) {
      const capRaw: any = await this.exportCaptions(
        mediaPath,
        undefined,
        args.captionFormat ?? 'srt',
        args.scriptPath,
        args.model ?? 'base',
        args.language ?? 'ko',
        undefined, undefined, undefined, undefined, undefined,
      );
      captions = typeof capRaw === 'string' ? JSON.parse(capRaw) : capRaw;
      steps.push(captions?.success ? `captions: ${captions.outputPath}` : `captions failed: ${captions?.error}`);
    }

    return JSON.stringify({
      success: true,
      dryRun: false,
      message: `Cut ${removals.spanCount} spans from "${seq.name}"` + (removals.inSync ? '' : ' — SYNC WARNING, check the timeline'),
      sequence: seq.name,
      mediaPath,
      backupSequenceName: removals.backupSequenceName ?? null,
      removedClipCount: removals.removedClipCount,
      removedSecPerTrack: removals.removedSecPerTrack,
      inSync: removals.inSync,
      syncWarning: removals.syncWarning,
      skippedCount: removals.skippedCount,
      skipped: removals.skipped,
      captions,
      steps,
      // Captions describe the ORIGINAL take; the timeline no longer matches it.
      captionNote: wantCaptions && captions?.success
        ? 'Caption times follow the uncut media. Re-run export_captions against the exported cut if you need them aligned to the new edit.'
        : undefined,
    });
  }

  /**
   * Cut a short-form clip out of a range: subsequence the range, then reframe it
   * to a vertical/square aspect.
   */
  private async makeShort(
    start?: number,
    end?: number,
    sequenceId?: string,
    name?: string,
    aspect: '9:16' | '1:1' | '4:5' | '16:9' = '9:16',
    motionPreset?: string,
    reframe = true,
  ): Promise<any> {
    if (typeof start !== 'number' || typeof end !== 'number') {
      return JSON.stringify({ success: false, error: 'start and end (timeline seconds) are required' });
    }
    if (end <= start) {
      return JSON.stringify({ success: false, error: 'end must be greater than start' });
    }

    const seq = await this.resolveSequence(sequenceId);
    if ('error' in seq) return JSON.stringify({ success: false, error: seq.error });

    const shortName = name || `${seq.name} short ${Math.round(start)}-${Math.round(end)}`;

    // Set in/out over the range, then let Premiere build the subsequence.
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(seq.id)});
        if (!sequence) return JSON.stringify({ success: false, error: "sequence not found" });
        app.project.openSequence(sequence.sequenceID);
        var active = app.project.activeSequence;

        active.setInPoint(${start});
        active.setOutPoint(${end});

        var before = app.project.sequences.numSequences;
        active.createSubsequence(true);
        var after = app.project.sequences.numSequences;
        if (after <= before) return JSON.stringify({ success: false, error: "subsequence was not created" });

        var created = app.project.sequences[after - 1];
        created.name = ${JSON.stringify(shortName)};
        return JSON.stringify({ success: true, sequenceId: created.sequenceID, name: created.name });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    const subRaw: any = await this.bridge.executeScript(script);
    const sub = typeof subRaw === 'string' ? JSON.parse(subRaw) : subRaw;
    if (!sub || !sub.success) {
      return JSON.stringify({ success: false, stage: 'subsequence', error: sub?.error || 'subsequence failed' });
    }

    if (!reframe || aspect === '16:9') {
      return JSON.stringify({
        success: true,
        message: `Created "${sub.name}" from ${start}s-${end}s`,
        sequenceId: sub.sequenceId,
        name: sub.name,
        aspect: '16:9',
        reframed: false,
      });
    }

    const ratios: Record<string, [number, number]> = { '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5] };
    const [num, den] = ratios[aspect] ?? [9, 16];

    const reframeRaw: any = await this.autoReframeSequence(sub.sequenceId, num, den, motionPreset ?? 'default', `${sub.name} ${aspect}`);
    const reframed = typeof reframeRaw === 'string' ? JSON.parse(reframeRaw) : reframeRaw;

    return JSON.stringify({
      success: true,
      message: `Created "${sub.name}" from ${start}s-${end}s and reframed to ${aspect}`,
      sourceSequence: seq.name,
      subsequenceId: sub.sequenceId,
      subsequenceName: sub.name,
      aspect,
      reframed: Boolean(reframed?.success),
      reframeResult: reframed,
      hint: 'Use export_sequence to render it, and export_captions if the short needs burned-in subtitles.',
    });
  }

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
    if (!backupSequenceName) return raw;
    // Surface the backup name so the caller knows what to restore.
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return JSON.stringify({ ...parsed, backupSequenceName });
    } catch {
      return raw;
    }
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



  private async addTransitionToClip(clipId: string, transitionName: string, position: 'start' | 'end', duration: number): Promise<any> {
    const atEnd = position === 'end';
    const script = `
      try {
        app.enableQE();
        var info = __findClip("${clipId}");
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var qeSeq = qe.project.getActiveSequence();
        var qeTrack = info.trackType === 'video' ? qeSeq.getVideoTrackAt(info.trackIndex) : qeSeq.getAudioTrackAt(info.trackIndex);
        var qeClip = qeTrack.getItemAt(info.clipIndex);
        var transition = info.trackType === 'video'
          ? qe.project.getVideoTransitionByName("${transitionName}")
          : qe.project.getAudioTransitionByName("${transitionName}");
        if (!transition) return JSON.stringify({ success: false, error: "Transition not found: ${transitionName}" });
        var seq = app.project.activeSequence;
        var fps = seq.timebase ? (254016000000 / parseInt(seq.timebase, 10)) : 30;
        var frames = Math.round(${duration} * fps);
        qeClip.addTransition(transition, ${atEnd}, frames + ":00", "0:00", 0.5, true, true);
        return JSON.stringify({ success: true, message: "Transition added at ${position}", transitionName: "${transitionName}", duration: ${duration} });
      } catch (e) {
        return JSON.stringify({ success: false, error: "QE DOM error: " + e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

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
  private async setupDucking(
    clipId: string,
    baseDb: number,
    duckingWindows: Array<{ startTime: number; endTime: number; duckedDb: number }>,
    fadeSeconds: number = 0.2,
    clipStartTime?: number,
    clipEndTime?: number
  ): Promise<any> {
    const fade = fadeSeconds ?? 0.2;
    const start = clipStartTime ?? 0;
    const lastWindow = duckingWindows.length > 0 ? duckingWindows[duckingWindows.length - 1] : undefined;
    const end = clipEndTime ?? (lastWindow ? lastWindow.endTime + 1 : start + 1);

    // Collect all keyframes and dedupe-by-time (later writes win for same time)
    const map = new Map<number, number>();
    const upsert = (t: number, db: number) => {
      // Quantize to ms to avoid duplicate-but-not-equal floats
      const key = Math.round(t * 1000) / 1000;
      map.set(key, db);
    };

    upsert(start, baseDb);

    for (const w of duckingWindows) {
      upsert(Math.max(start, w.startTime - fade), baseDb);
      upsert(w.startTime, w.duckedDb);
      upsert(w.endTime, w.duckedDb);
      upsert(Math.min(end, w.endTime + fade), baseDb);
    }

    upsert(end, baseDb);

    const keyframes = Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, level]) => ({ time, level }));

    const result = await this.addAudioKeyframes(clipId, keyframes);
    return {
      ...(typeof result === 'object' && result !== null ? result : {}),
      ducking_windows: duckingWindows.length,
      fade_seconds: fade,
      keyframes_emitted: keyframes.length,
      base_db: baseDb,
      computed_keyframes: keyframes,
    };
  }

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
  private async adjustAudioLevels(clipId: string, level: number): Promise<any> {
    const script = `
      try {
        var info = __findClip("${clipId}");
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;

        // Localized display names for the Volume component
        var VOLUME_NAMES = ["Volume", "Volumen", "Lautstärke", "Volume", "音量"];
        // Localized display names for the Level property inside Volume
        var LEVEL_NAMES  = ["Level", "Nivel", "Pegel", "Niveau", "Livello", "音量"];

        function isOneOf(name, list) {
          for (var n = 0; n < list.length; n++) { if (name === list[n]) return true; }
          return false;
        }

        // Build dump for debug fallback
        var dump = [];
        var volumeComp = null;
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          var compName = String(comp.displayName);
          var propsList = [];
          for (var j = 0; j < comp.properties.numItems; j++) {
            propsList.push(String(comp.properties[j].displayName));
          }
          dump.push({ idx: i, component: compName, properties: propsList });
          if (!volumeComp && isOneOf(compName, VOLUME_NAMES)) {
            volumeComp = comp;
          }
        }
        if (!volumeComp) {
          return JSON.stringify({
            success: false,
            error: "Volume component not found on clip",
            components_dump: dump
          });
        }

        var levelProp = null;
        for (var j = 0; j < volumeComp.properties.numItems; j++) {
          var pName = String(volumeComp.properties[j].displayName);
          if (isOneOf(pName, LEVEL_NAMES)) {
            levelProp = volumeComp.properties[j];
            break;
          }
        }
        if (!levelProp) {
          return JSON.stringify({
            success: false,
            error: "Level property not found inside Volume component",
            volume_component: String(volumeComp.displayName),
            properties_in_volume: dump.length > 0 ? dump : []
          });
        }

        // CALIBRATION (empirical, Premiere Pro 2026 macOS, locale es_ES):
        //   Premiere's clip Volume Level property uses a linear amplitude scale where the
        //   displayed "0 dB" in the Effects Controls panel corresponds to internal linear value
        //   ~0.17783. The relationship is: linear = 0.17783 × 10^(dB/20),
        //   equivalently: linear = 10^((dB - 15) / 20).
        //   Verified by measurement: setting linear = 1.4454 (which standard audio convention
        //   says is +3.2 dB) actually produced ~+13 dB of broadcast loudness gain. With this
        //   calibrated formula, requesting +3.2 dB now sets linear = 0.2571 ≈ matches Premiere's
        //   displayed value.
        var DB_CALIBRATION_OFFSET = 15;  // Premiere ES-locale, PrPro 2026.x
        var dB = ${level};
        var linearValue = Math.pow(10, (dB - DB_CALIBRATION_OFFSET) / 20);
        var oldLinear = levelProp.getValue();
        var oldDB = (oldLinear > 0)
          ? (20 * Math.log(oldLinear) / Math.log(10) + DB_CALIBRATION_OFFSET)
          : -Infinity;
        levelProp.setValue(linearValue, true);

        return JSON.stringify({
          success: true,
          message: "Audio level adjusted (clip Volume component, locale-aware, calibrated dB scale)",
          clipId: "${clipId}",
          requestedDB: dB,
          oldLinearValue: oldLinear,
          oldDB: oldDB,
          newLinearValue: linearValue,
          newDB: dB,
          calibrationOffset: DB_CALIBRATION_OFFSET,
          volumeComponent: String(volumeComp.displayName),
          levelProperty: String(levelProp.displayName)
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

  private async addAudioKeyframes(clipId: string, keyframes: Array<{time: number, level: number}>): Promise<any> {
    // CALIBRATION (matches adjustAudioLevels): Premiere's clip Volume Level property is linear amplitude.
    // The displayed "0 dB" in Effects Controls corresponds to internal linear value ~0.17783.
    // Relationship: linear = 10^((dB - 15) / 20). Verified empirically on Premiere Pro 2026 macOS es_ES.
    const DB_CALIBRATION_OFFSET = 15;
    const keyframeCode = keyframes.map(kf => {
      const linearValue = Math.pow(10, (kf.level - DB_CALIBRATION_OFFSET) / 20);
      return `
        try {
          levelProp.addKey(${kf.time});
          levelProp.setValueAtKey(${kf.time}, ${linearValue}, true);
          addedKeyframes.push({ time: ${kf.time}, level: ${kf.level}, linearValue: ${linearValue} });
        } catch (e2) {
          failedKeyframes.push({ time: ${kf.time}, level: ${kf.level}, error: e2.toString() });
        }
    `;
    }).join('\n');

    const script = `
      try {
        var info = __findClip(${JSON.stringify(clipId)});
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var clip = info.clip;

        // Locale-aware Volume component / Level property detection (matches adjustAudioLevels patch).
        // Without this, the function fails with "Volume property not found" on non-English Premiere
        // installs (e.g., Spanish "Volumen"/"Nivel", German "Lautstärke"/"Pegel", etc.).
        var VOLUME_NAMES = ["Volume", "Volumen", "Lautstärke", "Volume", "音量"];
        var LEVEL_NAMES  = ["Level", "Nivel", "Pegel", "Niveau", "Livello", "音量"];
        function isOneOf(name, list) {
          for (var n = 0; n < list.length; n++) { if (name === list[n]) return true; }
          return false;
        }

        var volumeComp = null;
        var dump = [];
        for (var i = 0; i < clip.components.numItems; i++) {
          var comp = clip.components[i];
          var compName = String(comp.displayName);
          var propsList = [];
          for (var j = 0; j < comp.properties.numItems; j++) {
            propsList.push(String(comp.properties[j].displayName));
          }
          dump.push({ idx: i, component: compName, properties: propsList });
          if (!volumeComp && isOneOf(compName, VOLUME_NAMES)) {
            volumeComp = comp;
          }
        }
        if (!volumeComp) {
          return JSON.stringify({
            success: false,
            error: "Volume component not found on clip (locale-aware lookup failed)",
            components_dump: dump
          });
        }

        var levelProp = null;
        for (var k = 0; k < volumeComp.properties.numItems; k++) {
          var pName = String(volumeComp.properties[k].displayName);
          if (isOneOf(pName, LEVEL_NAMES)) {
            levelProp = volumeComp.properties[k];
            break;
          }
        }
        if (!levelProp) {
          return JSON.stringify({
            success: false,
            error: "Level property not found inside Volume component",
            volume_component: String(volumeComp.displayName)
          });
        }

        levelProp.setTimeVarying(true);
        var addedKeyframes = [];
        var failedKeyframes = [];
        ${keyframeCode}
        return JSON.stringify({
          success: true,
          message: "Audio keyframes added (locale-aware Volume detection, calibrated dB scale)",
          clipId: ${JSON.stringify(clipId)},
          volumeComponent: String(volumeComp.displayName),
          levelProperty: String(levelProp.displayName),
          calibrationOffset: ${DB_CALIBRATION_OFFSET},
          addedKeyframes: addedKeyframes,
          failedKeyframes: failedKeyframes,
          totalKeyframes: addedKeyframes.length
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }


  // Text and Graphics Implementation
  private async addTextOverlay(args: any): Promise<any> {
    if (args.mogrtPath) {
      // FIX vs upstream: upstream silently ignored args.text; the MOGRT was imported but
      // its text properties stayed at default placeholders ("Su nombre aquí", etc.)
      // This version:
      //   1. importMGT (existing)
      //   2. After import, get trackItem.getMGTComponent() — the special MGT component
      //      that exposes the parameters defined in the Essential Graphics template
      //   3. Dump those properties for debugging (so callers see what's available)
      //   4. If args.text is provided, attempt to set it by:
      //      a. The first text-typed property whose value JSON-parses to {mTextString: ...}
      //      b. Or by displayName match against args.textPropertyName (optional override)
      //   Premiere stores text values as JSON: '{"mTextString":"...", ...}'
      const textJson = args.text !== undefined ? JSON.stringify(args.text) : 'null';
      // When set, the script restricts the write to the property whose displayName matches
      // (instead of running the auto-detect). text2/text3/text4 are ignored in override mode
      // — the override targets a single field by name.
      const textPropNameJson = args.textPropertyName !== undefined
        ? JSON.stringify(args.textPropertyName)
        : 'null';
      const script = `
        try {
          var sequence = __findSequence(${JSON.stringify(args.sequenceId)});
          if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });
          var timeTicks = __secondsToTicks(${args.startTime});
          var trackItem = sequence.importMGT(${JSON.stringify(args.mogrtPath)}, timeTicks, ${args.trackIndex}, 0);
          if (!trackItem) return JSON.stringify({ success: false, error: "Failed to import MOGRT. Ensure the .mogrt file exists." });

          // First, probe ALL plausible MGT-access APIs (so we know what's available)
          var apiProbe = {};
          apiProbe.hasGetMGTComponent = (typeof trackItem.getMGTComponent === "function");
          apiProbe.hasGetMGT = (typeof trackItem.getMGT === "function");
          apiProbe.hasGetMogrtComponent = (typeof trackItem.getMogrtComponent === "function");
          apiProbe.hasGetComponentParameters = (typeof trackItem.getComponentParameters === "function");
          // App-level
          apiProbe.appHasMOGRTAPI = (app.project && typeof app.project.openMGT === "function");
          // Try calling getMGTComponent and capture more detail
          if (apiProbe.hasGetMGTComponent) {
            try {
              var mgtTry = trackItem.getMGTComponent();
              apiProbe.getMGTComponent_returned = (mgtTry === null) ? "null" : (typeof mgtTry);
              if (mgtTry) {
                apiProbe.getMGTComponent_displayName = String(mgtTry.displayName || "");
                apiProbe.getMGTComponent_propertyCount = (mgtTry.properties ? mgtTry.properties.numItems : -1);
                // Dump first 3 properties of MGT comp
                var mgtPropsSample = [];
                if (mgtTry.properties) {
                  for (var mp = 0; mp < Math.min(5, mgtTry.properties.numItems); mp++) {
                    var mprop = mgtTry.properties[mp];
                    var mval = null;
                    try { mval = mprop.getValue(); } catch (eMg) { mval = "<getValue threw>"; }
                    mgtPropsSample.push({
                      index: mp,
                      displayName: String(mprop.displayName),
                      valueType: typeof mval,
                      valuePreview: (typeof mval === "string" ? mval.substring(0, 80) : mval)
                    });
                  }
                }
                apiProbe.getMGTComponent_propertiesSample = mgtPropsSample;
              }
            } catch (eMG) {
              apiProbe.getMGTComponent_threw = eMG.toString();
            }
          }
          // Probe trackItem.name (some MOGRT-specific stuff might surface here)
          try { apiProbe.trackItemName = String(trackItem.name); } catch (e) {}
          // Probe sequence-level methods
          try { apiProbe.sequenceHasGetSelection = (typeof sequence.getSelection === "function"); } catch (e) {}

          // Iterate ALL components of the imported trackItem (MOGRT params live as
          // properties on one of its components, not always via getMGTComponent)
          var componentsDump = [];
          var textPropsFound = [];  // {compIndex, propIndex, displayName, currentValue}
          for (var ci = 0; ci < trackItem.components.numItems; ci++) {
            var comp = trackItem.components[ci];
            var compName = String(comp.displayName);
            var compMatch = (comp.matchName !== undefined) ? String(comp.matchName) : "";
            var compProps = [];
            for (var i = 0; i < comp.properties.numItems; i++) {
              var prop = comp.properties[i];
              var dn = String(prop.displayName);
              var val = null;
              try { val = prop.getValue(); } catch (eV) { val = "<getValue threw>"; }
              var truncatedVal = (typeof val === "string" ? val.substring(0, 250) : val);
              compProps.push({ index: i, displayName: dn, value: truncatedVal });
              // Heuristic: text properties contain "mTextString" in their JSON value
              if (typeof val === "string" && val.indexOf("mTextString") >= 0) {
                textPropsFound.push({ compIndex: ci, propIndex: i, compDisplayName: compName, propDisplayName: dn, currentValue: val });
              }
            }
            componentsDump.push({ index: ci, displayName: compName, matchName: compMatch, propertyCount: compProps.length, properties: compProps });
          }

          // Set custom text(s). Each "AE.ADBE Text" component in the MOGRT exposes its
          // editable text as property 0 (display name "Texto de origen" / "Source Text").
          // Only one setValue per property — raw_string strategy worked in earlier tests; no
          // JSON wrapping (that broke rendering).
          //
          // Inputs:
          //   args.text  → first text component (e.g., main title in Basic Lower Third)
          //   args.text2 → second text component (e.g., subtitle)
          //   args.text3 → third (if MOGRT has more)
          //   ...
          // Auto-collected from numbered keys.
          var textsByIndex = [];
          if (${textJson} !== null) textsByIndex.push(${textJson});
          ${args.text2 !== undefined ? `textsByIndex.push(${JSON.stringify(args.text2)});` : ''}
          ${args.text3 !== undefined ? `textsByIndex.push(${JSON.stringify(args.text3)});` : ''}
          ${args.text4 !== undefined ? `textsByIndex.push(${JSON.stringify(args.text4)});` : ''}
          var setResults = [];
          if (textsByIndex.length > 0) {
            // PREFERRED PATH: getMGTComponent() for AE-exported MOGRTs (Adobe-CEP canonical).
            // Properties exposed there are the Essential Graphics parameters and contain
            // FULL JSON values that ARE editable.
            // FALLBACK PATH: iterate trackItem.components for "AE.ADBE Text" — only works for
            // some MOGRTs and tokens are opaque single-char references in Premiere-native MOGRTs.
            var textComps = [];
            var textCompsViaMGT = false;
            var textPropNameOverride = ${textPropNameJson};
            // OVERRIDE PATH: caller named a specific property by displayName.
            // Search both the MGT component and all trackItem components for an exact
            // displayName match, then restrict textComps to that single hit.
            // text2/text3/text4 are ignored in override mode — caller targeted one field.
            if (textPropNameOverride) {
              try {
                var mgtCompO = trackItem.getMGTComponent();
                if (mgtCompO && mgtCompO.properties) {
                  for (var miO = 0; miO < mgtCompO.properties.numItems; miO++) {
                    var mpO = mgtCompO.properties[miO];
                    if (String(mpO.displayName) === textPropNameOverride) {
                      textComps.push({ comp: mgtCompO, compIndex: -1, prop: mpO, propIndex: miO, displayName: String(mpO.displayName) });
                      textCompsViaMGT = true;
                      break;
                    }
                  }
                }
              } catch (eOMG) {}
              if (textComps.length === 0) {
                for (var ciO = 0; ciO < trackItem.components.numItems && textComps.length === 0; ciO++) {
                  var cO = trackItem.components[ciO];
                  for (var piO = 0; piO < cO.properties.numItems; piO++) {
                    var pO = cO.properties[piO];
                    if (String(pO.displayName) === textPropNameOverride) {
                      textComps.push({ comp: cO, compIndex: ciO, prop: pO, propIndex: piO, displayName: String(pO.displayName) });
                      break;
                    }
                  }
                }
              }
              if (textComps.length === 0) {
                return JSON.stringify({
                  success: false,
                  error: "textPropertyName override did not match any property displayName: " + textPropNameOverride,
                  componentCount: componentsDump.length,
                  components: componentsDump
                });
              }
              // In override mode keep only the first text (named-target write).
              textsByIndex = [textsByIndex[0]];
              setResults.push({ _strategy: "textPropertyName_override", overrideName: textPropNameOverride });
            }
            // AUTO-DETECT PATH (only when no override).
            if (textComps.length === 0) {
              try {
                var mgtComp = trackItem.getMGTComponent();
                if (mgtComp && mgtComp.properties) {
                  for (var mi = 0; mi < mgtComp.properties.numItems; mi++) {
                    var mp = mgtComp.properties[mi];
                    var mpVal = null;
                    try { mpVal = mp.getValue(); } catch (eMPv) {}
                    // A "text" param has a JSON string value containing textEditValue or mTextString
                    if (typeof mpVal === "string" && mpVal.length > 50 &&
                        (mpVal.indexOf("textEditValue") >= 0 || mpVal.indexOf("mTextString") >= 0 || mpVal.indexOf("capPropTextRunCount") >= 0)) {
                      textComps.push({ comp: mgtComp, compIndex: -1, prop: mp, propIndex: mi, displayName: String(mp.displayName) });
                    }
                  }
                  if (textComps.length > 0) textCompsViaMGT = true;
                }
              } catch (eMGTC) {}
              // Fallback to component iteration if MGT didn't yield text params
              if (textComps.length === 0) {
                for (var ci3 = 0; ci3 < trackItem.components.numItems; ci3++) {
                  var c3 = trackItem.components[ci3];
                  var mn = (c3.matchName !== undefined) ? String(c3.matchName) : "";
                  if (mn === "AE.ADBE Text") {
                    textComps.push({ comp: c3, compIndex: ci3, prop: c3.properties[0], propIndex: 0, displayName: "Source Text (legacy)" });
                  }
                }
              }
              setResults.push({ _strategy: textCompsViaMGT ? "getMGTComponent" : "components_fallback", textCompsFound: textComps.length });
            }
            for (var ti2 = 0; ti2 < textsByIndex.length && ti2 < textComps.length; ti2++) {
              var tc = textComps[ti2];
              var sourceTextProp = tc.prop;
              var newText = String(textsByIndex[ti2]);
              try {
                // Source Text in Premiere/After Effects MOGRTs is stored as:
                //   <4 bytes binary header> + <JSON payload of mTextParam structure>
                // Source: Adobe Community (Kurt_Clark) + Adobe-CEP samples + reproduced
                // independently across multiple Premiere versions (incl. 2026).
                // The agent investigation confirmed this format. Direct setValue("text")
                // stores the value but the renderer cannot parse it → no visual update.
                // Correct mutation: parse JSON (skipping header), patch
                // mTextParam.mStyleSheet.mText, re-prepend header, setValue(...).
                var rawVal = sourceTextProp.getValue();
                var rawValStr = String(rawVal);
                var rawValLen = rawValStr.length;
                var headerBytes = "";
                var jsonStr = "";
                var textObj = null;
                var parseStrategy = "";
                // Strategy 1: 4-byte header + JSON
                try {
                  headerBytes = rawValStr.substring(0, 4);
                  jsonStr = rawValStr.substring(4);
                  textObj = JSON.parse(jsonStr);
                  parseStrategy = "header4+json";
                } catch (eP1) {
                  // Strategy 2: pure JSON (AE 14.3+ no header)
                  try {
                    textObj = JSON.parse(rawValStr);
                    headerBytes = "";
                    parseStrategy = "pure_json";
                  } catch (eP2) {
                    setResults.push({
                      textIndex: ti2, compIndex: tc.compIndex, requestedText: newText,
                      ok: false,
                      error: "Both JSON parse strategies failed",
                      rawValLength: rawValLen,
                      rawValPreview: rawValStr.substring(0, 50),
                      parseError1: eP1.toString(),
                      parseError2: eP2.toString()
                    });
                    continue;
                  }
                }
                // Mutate the text in the proper nested path(s)
                var mutated = [];
                if (textObj.mTextParam && textObj.mTextParam.mStyleSheet) {
                  textObj.mTextParam.mStyleSheet.mText = newText;
                  mutated.push("mTextParam.mStyleSheet.mText");
                }
                // AE 14.3+ alternate: textEditValue + fontTextRunLength
                if (textObj.textEditValue !== undefined) {
                  textObj.textEditValue = newText;
                  textObj.fontTextRunLength = [newText.length];
                  mutated.push("textEditValue+fontTextRunLength");
                }
                if (mutated.length === 0) {
                  setResults.push({
                    textIndex: ti2, compIndex: tc.compIndex, requestedText: newText,
                    ok: false,
                    error: "Parsed JSON but no known text field found",
                    parseStrategy: parseStrategy,
                    jsonKeys: (function(){ var ks=[]; for (var k in textObj) ks.push(k); return ks; })()
                  });
                  continue;
                }
                // Re-encode + write back
                var newRawVal = headerBytes + JSON.stringify(textObj);
                sourceTextProp.setValue(newRawVal, true);
                // Verify
                var afterRaw = "";
                try { afterRaw = String(sourceTextProp.getValue()); } catch (eVA) {}
                var afterParseOk = false;
                var afterText = "";
                try {
                  var afterObj = JSON.parse(afterRaw.substring(headerBytes.length));
                  if (afterObj.mTextParam && afterObj.mTextParam.mStyleSheet) {
                    afterText = afterObj.mTextParam.mStyleSheet.mText;
                    afterParseOk = true;
                  } else if (afterObj.textEditValue) {
                    afterText = afterObj.textEditValue;
                    afterParseOk = true;
                  }
                } catch (eAP) {}
                setResults.push({
                  textIndex: ti2,
                  compIndex: tc.compIndex,
                  requestedText: newText,
                  parseStrategy: parseStrategy,
                  fieldsMutated: mutated,
                  rawValLength: rawValLen,
                  newRawValLength: newRawVal.length,
                  readbackParseOk: afterParseOk,
                  readbackText: afterText,
                  ok: (afterText === newText)
                });
              } catch (eS) {
                setResults.push({ textIndex: ti2, compIndex: tc.compIndex, requestedText: newText, ok: false, error: eS.toString() });
              }
            }
            if (textComps.length === 0) {
              setResults.push({ ok: false, error: "No 'AE.ADBE Text' components found in MOGRT" });
            } else if (textsByIndex.length > textComps.length) {
              setResults.push({ ok: false, warning: "More texts requested (" + textsByIndex.length + ") than text components in MOGRT (" + textComps.length + ")" });
            }
          }

          return JSON.stringify({
            success: true,
            message: "MOGRT imported as text overlay",
            clipId: trackItem.nodeId,
            apiProbe: apiProbe,
            componentCount: componentsDump.length,
            components: componentsDump,
            textPropsAutoDetected: textPropsFound,
            textInjectionResults: setResults
          });
        } catch (e) {
          return JSON.stringify({ success: false, error: e.toString() });
        }
      `;
      return await this.bridge.executeScript(script);
    }

    // Fallback: try legacy title approach
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(args.sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found" });
        return JSON.stringify({
          success: false,
          error: "Text overlay requires a MOGRT file path. Pass mogrtPath pointing to a .mogrt template file.",
          note: "Legacy titles (app.project.createNewTitle) are not supported in current Premiere Pro ExtendScript API."
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Color Correction Implementation
  private async colorCorrect(clipId: string, adjustments: any): Promise<any> {
    const paramCode = [
      adjustments.brightness !== undefined ? `if (p.displayName === "Brightness") p.setValue(${adjustments.brightness}, true);` : '',
      adjustments.contrast !== undefined ? `if (p.displayName === "Contrast") p.setValue(${adjustments.contrast}, true);` : '',
      adjustments.saturation !== undefined ? `if (p.displayName === "Saturation") p.setValue(${adjustments.saturation}, true);` : '',
      adjustments.hue !== undefined ? `if (p.displayName === "Hue") p.setValue(${adjustments.hue}, true);` : '',
      adjustments.temperature !== undefined ? `if (p.displayName === "Temperature") p.setValue(${adjustments.temperature}, true);` : '',
      adjustments.tint !== undefined ? `if (p.displayName === "Tint") p.setValue(${adjustments.tint}, true);` : '',
    ].filter(Boolean).join('\n              ');

    const script = `
      try {
        app.enableQE();
        var info = __findClip("${clipId}");
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var qeSeq = qe.project.getActiveSequence();
        var qeTrack = qeSeq.getVideoTrackAt(info.trackIndex);
        var qeClip = qeTrack.getItemAt(info.clipIndex);
        var effect = qe.project.getVideoEffectByName("Lumetri Color");
        if (!effect) return JSON.stringify({ success: false, error: "Lumetri Color effect not found" });
        qeClip.addVideoEffect(effect);
        var clip = info.clip;
        var lastComp = clip.components[clip.components.numItems - 1];
        for (var j = 0; j < lastComp.properties.numItems; j++) {
          var p = lastComp.properties[j];
          try {
            ${paramCode}
          } catch (e2) {}
        }
        return JSON.stringify({ success: true, message: "Color correction applied", clipId: "${clipId}" });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

  private async applyLut(clipId: string, lutPath: string, _intensity = 100): Promise<any> {
    const script = `
      try {
        app.enableQE();
        var info = __findClip("${clipId}");
        if (!info) return JSON.stringify({ success: false, error: "Clip not found" });
        var qeSeq = qe.project.getActiveSequence();
        var qeTrack = qeSeq.getVideoTrackAt(info.trackIndex);
        var qeClip = qeTrack.getItemAt(info.clipIndex);
        var effect = qe.project.getVideoEffectByName("Lumetri Color");
        if (!effect) return JSON.stringify({ success: false, error: "Lumetri Color not found" });
        qeClip.addVideoEffect(effect);
        var clip = info.clip;
        var lastComp = clip.components[clip.components.numItems - 1];
        for (var j = 0; j < lastComp.properties.numItems; j++) {
          var p = lastComp.properties[j];
          try {
            if (p.displayName === "Input LUT") p.setValue("${lutPath}", true);
          } catch (e2) {}
        }
        return JSON.stringify({ success: true, message: "LUT applied", clipId: "${clipId}", lutPath: "${lutPath}" });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;

    return await this.bridge.executeScript(script);
  }

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
  private async addMarker(_sequenceId: string, time: number, name: string, comment?: string, color?: string, duration?: number): Promise<any> {
    const script = `
      try {
        var sequence = app.project.activeSequence;
        if (!sequence) {
          return JSON.stringify({
            success: false,
            error: "No active sequence"
          });
        } else {
          var marker = sequence.markers.createMarker(${time});
          marker.name = ${JSON.stringify(name)};
          ${comment ? `marker.comments = ${JSON.stringify(comment)};` : ''}
          ${color ? `marker.setColorByIndex(${color === 'red' ? '5' : color === 'green' ? '3' : color === 'blue' ? '1' : '0'});` : ''}
          ${duration && duration > 0 ? `marker.end = ${time + duration};` : ''}

          return JSON.stringify({
            success: true,
            markerId: marker.guid,
            message: "Marker added successfully"
          });
        }
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;
    return await this.bridge.executeScript(script);
  }



  private async listMarkers(_sequenceId: string): Promise<any> {
    const script = `
      try {
        var sequence = app.project.activeSequence;
        if (!sequence) {
          return JSON.stringify({
            success: false,
            error: "No active sequence"
          });
        } else {
          var markers = [];
          for (var i = 0; i < sequence.markers.numMarkers; i++) {
            var marker = sequence.markers[i];
            markers.push({
              id: marker.guid,
              name: marker.name,
              comment: marker.comments,
              start: marker.start.seconds,
              end: marker.end.seconds,
              duration: marker.end.seconds - marker.start.seconds,
              type: marker.type
            });
          }

          return JSON.stringify({
            success: true,
            markers: markers,
            count: markers.length
          });
        }
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: e.toString()
        });
      }
    `;
    return await this.bridge.executeScript(script);
  }

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
  private async autoReframeSequence(sequenceId: string, numerator: number, denominator: number, motionPreset?: string, newName?: string): Promise<any> {
    const preset = motionPreset || 'default';
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: ${sequenceId}" });
        var reframedName = ${newName ? JSON.stringify(newName) : 'sequence.name + " Reframed"'};
        sequence.autoReframeSequence(${numerator}, ${denominator}, ${JSON.stringify(preset)}, reframedName, false);
        return JSON.stringify({
          success: true,
          message: "Sequence auto-reframed",
          aspectRatio: ${numerator} + ":" + ${denominator},
          motionPreset: ${JSON.stringify(preset)},
          newName: reframedName
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Scene Edit Detection Implementation
  private async detectSceneEdits(sequenceId: string, action?: string, applyCutsToLinkedAudio?: boolean, sensitivity?: string): Promise<any> {
    const actionVal = action || 'CreateMarkers';
    const audioVal = applyCutsToLinkedAudio !== false;
    const sensitivityVal = sensitivity || 'Medium';
    const script = `
      try {
        var sequence = __findSequence(${JSON.stringify(sequenceId)});
        if (!sequence) return JSON.stringify({ success: false, error: "Sequence not found by id: ${sequenceId}" });
        sequence.performSceneEditDetectionOnSelection(${JSON.stringify(actionVal)}, ${audioVal}, ${JSON.stringify(sensitivityVal)});
        return JSON.stringify({
          success: true,
          message: "Scene edit detection performed",
          action: ${JSON.stringify(actionVal)},
          sensitivity: ${JSON.stringify(sensitivityVal)}
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

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
        var startAtTime = ${startTimeVal};
        sequence.createCaptionTrack(projectItem, startAtTime, ${JSON.stringify(formatVal)});
        return JSON.stringify({
          success: true,
          message: "Caption track created",
          captionFormat: ${JSON.stringify(formatVal)},
          startTime: ${startTimeVal}
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
  private async createSubsequence(sequenceId: string, ignoreTrackTargeting?: boolean): Promise<any> {
    const ignoreTargeting = ignoreTrackTargeting ? 'true' : 'false';
    const script = `
      try {
        var seq = __findSequence(${JSON.stringify(sequenceId)});
        if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        var subseq = seq.createSubsequence(${ignoreTargeting});
        return JSON.stringify({
          success: true,
          message: "Subsequence created",
          sequenceId: subseq.sequenceID,
          name: subseq.name
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
      }
    `;
    return await this.bridge.executeScript(script);
  }

  // Import MOGRT Implementation

  // Import MOGRT From Library Implementation

  // Manage Proxies Implementation
}
