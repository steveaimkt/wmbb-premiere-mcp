/** Voice orders: data model shared by the daemon, store, interpreter and panel. */

export type CaptionStyle = 'narration' | 'situation' | 'reaction' | 'item';

export type Anchor =
  | 'center' | 'top_left' | 'top' | 'top_right' | 'left' | 'right'
  | 'bottom_left' | 'bottom' | 'bottom_right';

export const ANCHORS: readonly Anchor[] = [
  'center', 'top_left', 'top', 'top_right', 'left', 'right', 'bottom_left', 'bottom', 'bottom_right',
];
export const CAPTION_STYLES: readonly CaptionStyle[] = ['narration', 'situation', 'reaction', 'item'];

export type OrderPayload =
  | { kind: 'caption'; style: CaptionStyle; text: string; placement: 'playhead' | 'after_previous' }
  | { kind: 'zoom'; scale: number; anchor: Anchor; holdSec: number };

export type OrderStatus =
  | 'processing' | 'ready' | 'unpolished' | 'no_speech' | 'failed'
  | 'no_position' | 'applied' | 'apply_failed';

export interface VoiceOrder {
  id: string;
  /** Orders spoken in one recording share a groupId. */
  groupId: string;
  sequenceId: string | null;
  /** Sequence time in seconds; null when the playhead could not be read. */
  timeSec: number | null;
  createdAt: string;
  transcript: string | null;
  recordingPath: string;
  payload: OrderPayload | null;
  status: OrderStatus;
  checked: boolean;
  /** Premiere marker id, once one has been placed. */
  markerId?: string | null | undefined;
  /** Interpreter outcome, kept so a no_position order regains ready/unpolished once a time is set. */
  polished?: boolean | undefined;
  error?: string | undefined;
}

export interface Settings {
  model: string;
  captionTemplatePath: string;
  captionTrackName: string;
  hotkeyKeyCode: number;
  markerMode: 'immediate' | 'onPause';
  zoomDefaults: { scale: number; holdSec: number; anchor: Anchor };
}

export const DEFAULT_SETTINGS: Settings = {
  model: 'claude-haiku-5-5',
  captionTemplatePath: '',
  captionTrackName: 'AI 자막',
  hotkeyKeyCode: 61, // 오른쪽 Option (맥북에 F13 없음). F13 = 105
  markerMode: 'immediate',
  zoomDefaults: { scale: 120, holdSec: 2, anchor: 'center' },
};
