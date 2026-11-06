/**
 * Premiere operations the daemon needs, behind a small port so the pipeline
 * can be tested without Premiere. BridgePremierePort goes through the existing
 * file bridge and the MCP tools (which carry the verify contract).
 */
import type { PremiereProTransport } from '../bridge/types.js';
import type { PremiereProTools } from '../tools/index.js';
import type { PlacedCaption, ZoomKey } from './timing.js';
import type { Settings, VoiceOrder } from './types.js';

export interface PremierePort {
  activeSequence(): Promise<{ id: string; projectPath: string } | null>;
  playhead(): Promise<number | null>;
  setMarker(o: VoiceOrder, color: 'orange' | 'green' | 'white'): Promise<string | null>;
  existingCaptions(seqId: string): Promise<{ startSec: number; endSec: number }[]>;
  backup(seqId: string): Promise<boolean>;
  placeCaption(seqId: string, c: PlacedCaption): Promise<{ ok: boolean; error?: string }>;
  zoom(seqId: string, atSec: number, keys: ZoomKey[]): Promise<{ ok: boolean; error?: string }>;
}

// 26.5.2 실측: 0 초록 1 빨강 2 보라 3 주황 4 노랑 5 흰색 6 파랑 7 청록 (회색 없음)
export const MARKER_COLOR = { green: 0, orange: 3, white: 5 } as const;

function parse(r: any): any {
  if (typeof r === 'string') { try { return JSON.parse(r); } catch { return { success: false, error: r }; } }
  return r ?? {};
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

export class BridgePremierePort implements PremierePort {
  /** Hotkey-path calls must not hang for the bridge's 60s timeout when the panel is off. */
  private readonly quickMs: number;
  constructor(
    private readonly bridge: PremiereProTransport,
    private readonly tools: PremiereProTools,
    private readonly settings: () => Settings,
    opts: { quickMs?: number } = {},
  ) {
    this.quickMs = opts.quickMs ?? 2500;
  }

  async activeSequence() {
    const r = parse(await withTimeout(this.bridge.executeScript(`
      var s = app.project.activeSequence;
      if (!s) return JSON.stringify({ success: false });
      return JSON.stringify({ success: true, id: s.sequenceID, projectPath: app.project.path });
    `), this.quickMs, null));
    return r?.success ? { id: String(r.id), projectPath: String(r.projectPath) } : null;
  }

  async playhead() {
    const r = parse(await withTimeout(this.bridge.executeScript(`
      var s = app.project.activeSequence;
      if (!s) return JSON.stringify({ success: false });
      return JSON.stringify({ success: true, timeSec: s.getPlayerPosition().seconds });
    `), this.quickMs, null));
    return r?.success && typeof r.timeSec === 'number' ? r.timeSec : null;
  }

  async setMarker(o: VoiceOrder, color: 'orange' | 'green' | 'white') {
    if (o.timeSec === null) return null;
    const label = o.payload?.kind === 'caption' ? o.payload.text : o.payload?.kind === 'zoom' ? `확대 ${o.payload.scale}%` : (o.transcript ?? '음성 지시');
    const r = parse(await this.tools.executeTool('set_marker', {
      sequenceId: o.sequenceId ?? undefined,
      timeSec: o.timeSec,
      name: `[AI] ${label}`.slice(0, 120),
      comments: o.transcript ?? '',
      colorIndex: MARKER_COLOR[color],
      ...(o.markerId ? { markerId: o.markerId } : {}),
    }));
    return r?.success ? String(r.markerId) : null;
  }

  async existingCaptions(seqId: string) {
    const r = parse(await this.tools.executeTool('list_sequence_tracks', { sequenceId: seqId, includeSourceTimes: false, compact: false }));
    const name = this.settings().captionTrackName;
    const track = (r?.videoTracks ?? []).find((t: any) => t?.name === name);
    return (track?.clips ?? []).map((c: any) => ({ startSec: Number(c.startTime), endSec: Number(c.endTime) }));
  }

  async backup(seqId: string) {
    const r = parse(await this.tools.executeTool('backup_sequence', { sequenceId: seqId, label: 'before-voice-orders' }));
    return r?.success === true;
  }

  async placeCaption(seqId: string, c: PlacedCaption) {
    const s = this.settings();
    const r = parse(await this.tools.executeTool('place_mogrt_text', {
      sequenceId: seqId,
      templatePath: s.captionTemplatePath,
      trackName: s.captionTrackName,
      startSec: c.startSec,
      endSec: c.endSec,
      text: c.text,
      clipName: c.text,
    }));
    if (r?.success) return { ok: true };
    return { ok: false, error: String(r?.error ?? (Array.isArray(r?.verifyProblems) ? r.verifyProblems.join('; ') : 'place_mogrt_text failed')) };
  }

  async zoom(seqId: string, atSec: number, keys: ZoomKey[]) {
    const tracks = parse(await this.tools.executeTool('list_sequence_tracks', { sequenceId: seqId, includeSourceTimes: false, compact: false }));
    if (!tracks?.success) return { ok: false, error: String(tracks?.error ?? 'list_sequence_tracks failed') };
    const v1 = (tracks?.videoTracks ?? [])[0];
    const clip = (v1?.clips ?? []).find((c: any) => c.startTime <= atSec && atSec < c.endTime);
    if (!clip) return { ok: false, error: `V1에 ${atSec.toFixed(2)}초를 덮는 클립이 없음` };
    // A zoom that would run past the clip's end is pulled back so it eases out inside the clip
    // (set_clip_motion rejects keys outside the clip). Too short for both ramps → refuse.
    const end = Number(clip.endTime) - 1 / 60;
    const last = keys[keys.length - 1];
    if (last && last.time > end) {
      const d = last.time - end;
      keys = keys.map((k, i) => (i >= keys.length - 2 ? { ...k, time: k.time - d } : k));
      if (keys.length >= 3 && keys[keys.length - 2]!.time <= keys[1]!.time) return { ok: false, error: `V1 클립이 ${(Number(clip.endTime) - atSec).toFixed(2)}초 뒤에 끝나서 확대할 공간이 없음` };
    }
    const r = parse(await this.tools.executeTool('set_clip_motion', {
      clipId: String(clip.id),
      sequenceId: seqId,
      keyframes: keys.map((k) => ({ time: k.time, scale: k.scale, position: k.position })),
      timeBase: 'sequence',
      interpolation: 'bezier',
      clearExisting: false,
    }));
    return r?.success ? { ok: true } : { ok: false, error: String(r?.error ?? 'set_clip_motion failed') };
  }
}
