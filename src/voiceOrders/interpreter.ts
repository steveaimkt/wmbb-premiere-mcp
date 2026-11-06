/**
 * Claude interpreter: one transcript -> one or more orders (caption / zoom).
 *
 * Structured output (output_config.format) shapes the reply; numeric limits are
 * not expressible in the API schema, so ranges are checked here. Anything that
 * does not validate — or a refusal, or a failed call — falls back to the raw
 * transcript as a narration caption marked "unpolished", so nothing is lost.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Glossary } from './glossary.js';
import { ANCHORS, CAPTION_STYLES, type OrderPayload } from './types.js';

export interface InterpretResult { status: 'ready' | 'unpolished'; payloads: OrderPayload[]; error?: string }

export const ZOOM_SCALE_RANGE = [100, 300] as const;
export const ZOOM_HOLD_RANGE = [0.5, 10] as const;

export const ORDERS_SCHEMA = {
  type: 'object',
  properties: {
    orders: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              kind: { const: 'caption' },
              style: { type: 'string', enum: [...CAPTION_STYLES] },
              text: { type: 'string' },
              placement: { type: 'string', enum: ['playhead', 'after_previous'] },
            },
            required: ['kind', 'style', 'text', 'placement'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              kind: { const: 'zoom' },
              scale: { type: 'number', description: 'percent, 100-300' },
              anchor: { type: 'string', enum: [...ANCHORS] },
              holdSec: { type: 'number', description: 'seconds held at full zoom, 0.5-10' },
            },
            required: ['kind', 'scale', 'anchor', 'holdSec'],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ['orders'],
  additionalProperties: false,
} as const;

const STYLE_GUIDE = `너는 한국어 게임 유튜브 영상의 편집 지시를 해석한다. 편집자가 영상을 보다가 말한 문장 하나를 받아, 그 위치에 넣을 지시 목록을 JSON으로 돌려준다.

## 지시 종류
- caption: 화면 자막. style 네 가지 중 하나.
  - narration: "~라고 적어서 다듬어" 또는 지시 문구가 없는 말. 과거형, 이야기하듯 담담하게.
  - situation: "괄호치고 ~". 지금 화면 상황을 괄호 안에 짧게 설명. 반드시 ( ) 로 감싼다.
  - reaction: 감탄·웃음 위주의 짧은 말. ㅋㅋㅋ, ?!, ... 같은 표현 허용.
  - item: "아이템 이름 ~". 아이템 이름만 적는다. 설명·조사 없음.
- zoom: "확대해줘". 기본 scale 120, anchor center, holdSec 2. "크게"는 150, "엄청 크게"는 200. "3초"는 holdSec 3. "왼쪽 위"는 top_left, "인벤토리 쪽"처럼 화면 위치를 말하면 가장 가까운 anchor.

## 위치
- placement는 보통 playhead.
- "앞 자막 뒤에 바로", "이어서" 같은 말이 있으면 after_previous.

## 규칙
- 지시 문구("라고 적어서 다듬어", "괄호치고", "아이템 이름", "확대해줘", "앞 자막 뒤에")는 자막 글자에 넣지 않는다.
- 한 문장에 지시가 둘 이상이면("확대하고 ~ 자막도") 말한 순서대로 각각 넣는다.
- 자막은 한 줄, 대략 25자 이내. 말한 뜻을 바꾸지 않는다.
- 게임 용어는 아래 사전의 표기를 그대로 쓴다.

## 예시
입력: 여기서 상자 열었는데 아무것도 없었다고 적어서 다듬어
출력: {"orders":[{"kind":"caption","style":"narration","text":"상자를 열어봤지만 텅 비어 있었다","placement":"playhead"}]}

입력: 괄호치고 누가 밖에서 빠르게 뛰어온다
출력: {"orders":[{"kind":"caption","style":"situation","text":"(누군가가 밖에서 빠르게 달려오는 중)","placement":"playhead"}]}

입력: 아 이거 대박 웃기다 ㅋㅋㅋ
출력: {"orders":[{"kind":"caption","style":"reaction","text":"ㅋㅋㅋㅋ 이게 되네?!","placement":"playhead"}]}

입력: 아이템 이름 에이케이에스 세븐
출력: {"orders":[{"kind":"caption","style":"item","text":"AKS.7","placement":"playhead"}]}

입력: 여기 왼쪽 위 크게 확대하고 앞 자막 뒤에 바로 괄호치고 적 발견이라고 써줘
출력: {"orders":[{"kind":"zoom","scale":150,"anchor":"top_left","holdSec":2},{"kind":"caption","style":"situation","text":"(적 발견)","placement":"after_previous"}]}`;

export function buildSystemPrompt(glossaryBlock: string): string {
  return `${STYLE_GUIDE}\n\n## 게임 용어 사전\n${glossaryBlock}`;
}

function inRange(v: unknown, [lo, hi]: readonly [number, number]): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

/** Strict validation of one payload; returns null if anything is off. */
export function validatePayload(x: any): OrderPayload | null {
  if (!x || typeof x !== 'object') return null;
  if (x.kind === 'caption') {
    if (!CAPTION_STYLES.includes(x.style)) return null;
    if (typeof x.text !== 'string' || !x.text.trim()) return null;
    if (x.placement !== 'playhead' && x.placement !== 'after_previous') return null;
    return { kind: 'caption', style: x.style, text: x.text.trim(), placement: x.placement };
  }
  if (x.kind === 'zoom') {
    if (!inRange(x.scale, ZOOM_SCALE_RANGE) || !inRange(x.holdSec, ZOOM_HOLD_RANGE)) return null;
    if (!ANCHORS.includes(x.anchor)) return null;
    return { kind: 'zoom', scale: x.scale, anchor: x.anchor, holdSec: x.holdSec };
  }
  return null;
}

export class Interpreter {
  constructor(private readonly opts: { client: Pick<Anthropic, 'messages'>; model: string; glossary: Glossary }) {}

  async interpret(transcript: string): Promise<InterpretResult> {
    const fallback = (error?: string): InterpretResult => ({
      status: 'unpolished',
      payloads: [{ kind: 'caption', style: 'narration', text: transcript, placement: 'playhead' }],
      ...(error ? { error } : {}),
    });

    let response: any;
    try {
      response = await this.opts.client.messages.create({
        model: this.opts.model,
        max_tokens: 1024,
        system: [{ type: 'text', text: buildSystemPrompt(this.opts.glossary.asPromptBlock()), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: transcript }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: ORDERS_SCHEMA as any } },
      } as any);
    } catch (e: any) {
      return fallback(String(e?.message ?? e));
    }

    if (response?.stop_reason === 'refusal') return fallback('refusal');
    if (response?.stop_reason === 'max_tokens') return fallback('max_tokens');

    const text = (response?.content ?? [])
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('');
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fallback('invalid JSON from model');
    }
    const raw = Array.isArray(parsed?.orders) ? parsed.orders : null;
    if (!raw || raw.length === 0) return fallback('no orders');
    const payloads = raw.map(validatePayload);
    if (payloads.some((p: OrderPayload | null) => p === null)) return fallback('order failed validation');
    return { status: 'ready', payloads };
  }
}
