# 음성 지시 (Voice Orders) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 영상을 보다가 단축키를 누르고 말하면 그 위치에 지시(자막·확대)가 쌓이고, 패널에서 검토한 뒤 체크한 것만 프리미어 타임라인에 적용한다.

**Architecture:** 상주 Node 데몬(`src/voiceOrders/`)이 중심이다. macOS 단축키 도우미(Swift)가 녹음해서 데몬에 넘기고, 데몬이 상주 Whisper 워커로 받아쓴 뒤 Claude로 해석해 지시 저장소에 쌓는다. 프리미어 조작은 기존 파일 브릿지(`PremiereProBridge`)와 `PremiereProTools.executeTool`로 하고, 새 ExtendScript는 검증 계약을 지키는 MCP 도구 3개로 추가한다. 검토 UI는 같은 CEP 번들의 새 패널이며 데몬의 로컬 HTTP API만 쓴다.

**Tech Stack:** TypeScript(ESM, jest/ts-jest), `@anthropic-ai/sdk`, Python faster-whisper, Swift 6(AppKit·AVFoundation), CEP 11 HTML/JS, macOS launchd.

**Spec:** `docs/superpowers/specs/2026-11-06-voice-orders-design.md`

## Global Constraints

- 지시 종류는 1차에서 `caption`(style: `narration|situation|reaction|item`)과 `zoom`만.
- 해석 모델 기본값 `claude-haiku-5-5`, 설정으로 `claude-sonnet-5-5` 전환. 구조화 출력(`output_config.format`) 사용. Claude 코드를 쓰기 전에 `claude-api` 스킬의 `typescript/claude-api/README.md`를 읽는다.
- 자막 길이: 최소 1.5초, 최대 5초, 다음 자막 시작 전에 끝냄.
- 확대 기본값: 120%, 앵커 가운데, 0.3초 들어감 → 유지 2초 → 0.3초 나옴, 베지어.
- 단축키 기본값 `F13`(macOS keyCode 105). 녹음은 16kHz mono WAV.
- 데몬 포트 `127.0.0.1:47613`, 도우미 포트 `127.0.0.1:47614`. 외부 인터페이스에 바인드하지 않는다.
- 데이터 위치: `~/Library/Application Support/wmbb-premiere-mcp/voice-orders/` 아래 `glossary.json`, `settings.json`, `projects/<sha1(projectPath)>/orders.json`, `projects/<…>/recordings/*.wav`.
- 변경계열 도구는 재조회한 `verify`를 반환하고 문제가 있으면 `success:false` (CLAUDE.md 검증 계약).
- 목록은 영상 시간 순서. "앞 자막 뒤에"는 타임라인 기준 직전 자막. 검토 기본값은 전부 체크.
- 적용 전 `backup_sequence` 호출.
- API 키는 SDK 기본 해석 순서(`ANTHROPIC_API_KEY` → `ant auth` 프로필)에 맡기고 저장소·설정 파일에 저장하지 않는다.

## Review Focus

1. **브릿지가 꺼진 상태에서 단축키를 누름** — 재생헤드를 못 읽으면 지시는 `timeSec: null`, 상태 `위치 모름`으로 남고 사용자가 시간을 직접 넣을 때까지 적용 대상에서 빠진다. (Task 7 테스트)
2. **같은 위치에 자막 지시가 둘 이상** — 같은 트랙에 겹쳐 놓지 않고 두 번째를 첫 번째 끝에 붙인다. (Task 3 테스트)
3. **자막 문구에 따옴표·줄바꿈·이모지·역슬래시** — ExtendScript 문자열이 깨지지 않고 그대로 들어간다. (Task 6 테스트)
4. **단축키를 짧게 톡 누르거나 아무 말도 안 함** — 0.4초 미만 녹음은 버리고, 받아쓰기 결과가 비면 줄을 `인식된 말 없음`으로 표시한다. (Task 5·7 테스트)
5. **지시를 남긴 뒤 다른 시퀀스로 바꿈** — 지시는 `sequenceId`를 갖고, 적용은 현재 활성 시퀀스의 지시만 대상으로 한다. (Task 7 테스트)

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/voiceOrders/types.ts` | `VoiceOrder`, `OrderPayload`, `OrderStatus`, `Settings` 타입 |
| `src/voiceOrders/paths.ts` | 데이터 위치 계산 |
| `src/voiceOrders/store.ts` | 프로젝트별 지시 저장·정렬·수정 |
| `src/voiceOrders/glossary.ts` | 용어 사전 로드·치환·프롬프트 텍스트·추가 |
| `src/voiceOrders/timing.ts` | 자막 시작·길이, 확대 키프레임 계산 (순수 함수) |
| `src/voiceOrders/interpreter.ts` | Claude 해석(프롬프트·스키마·검증·폴백) |
| `src/voiceOrders/stt.ts` | 상주 Whisper 워커 래퍼 |
| `src/voiceOrders/premiere.ts` | 데몬이 쓰는 프리미어 조작(브릿지·도구 호출 묶음) |
| `src/voiceOrders/daemon.ts` | HTTP API, 파이프라인, 이벤트 스트림 |
| `scripts/voice_orders_stt.py` | 모델을 한 번 띄우고 JSONL로 요청 처리 |
| `src/tools/index.ts` | 새 도구 `get_playhead`, `set_marker`, `place_mogrt_text` |
| `helpers/VoiceHotkey/` | Swift 패키지: 전역 단축키, 녹음, 메뉴바 |
| `cep-plugin/voice-orders.html`, `cep-plugin/voice-orders.js` | 검토 패널 |
| `cep-plugin/CSXS/manifest.xml` | 두 번째 Extension 등록 |
| `scripts/install-voice-orders.sh` | 빌드·launchd 등록 |
| `src/__tests__/voiceOrders/*.test.ts` | 단위 테스트 |
| `scripts/voice-orders-live-test.mjs` | 26.5.2 실측 테스트 |

---

### Task 1: 실측 확인 (스파이크)

설계의 세 가지 미확인 사항을 실제 프리미어 26.5.2에서 확인하고 결과에 따라 이후 태스크의 분기를 정한다. 코드는 남기지 않고 결과만 기록한다.

**Files:**
- Modify: `CLAUDE.md` (변경 이력 표에 실측 사실 한 줄)
- Modify: `docs/superpowers/specs/2026-11-06-voice-orders-design.md` (가정 → 확인 결과)

- [ ] **Step 1:** 테스트용 복사 시퀀스에서 `seq.importMGT("~/Library/Application Support/Adobe/Common/Motion Graphics Templates/1말하는자막.mogrt", ticks, trackIdx, 0)` 후 재조회로 새 클립을 찾고 `clip.getMGTComponent()`가 있는지, 텍스트 파라미터 `setValue`로 문구가 바뀌는지 확인한다. 안 되면 AE 2026으로 "검은 반투명 띠 + 흰 글씨, 텍스트 파라미터 하나"인 `voice-orders-caption.mogrt`를 만들어 `cep-plugin/assets/`에 넣고 같은 확인을 한다.
- [ ] **Step 2:** 재생 중에 `seq.markers.createMarker(t)`를 evalScript로 실행해 재생이 멈추는지 확인한다.
- [ ] **Step 3:** 스크립트로 비디오 트랙 이름을 바꿀 수 있는지(`track.name = …` 후 재조회) 확인한다.
- [ ] **Step 4:** 세 결과를 CLAUDE.md 변경 이력과 스펙에 적고 커밋한다. 마커가 재생을 멈추면 Task 7의 `markerMode`를 `"onPause"`로, 아니면 `"immediate"`로 정한다. 템플릿 경로는 `settings.captionTemplatePath` 기본값이 된다.

```bash
git add CLAUDE.md docs/superpowers/specs/2026-11-06-voice-orders-design.md cep-plugin/assets
git commit -m "docs: record 26.5.2 probes for voice orders (mogrt text, live markers, track rename)"
```

---

### Task 2: 지시 모델·저장소·용어 사전

**Files:**
- Create: `src/voiceOrders/types.ts`, `src/voiceOrders/paths.ts`, `src/voiceOrders/store.ts`, `src/voiceOrders/glossary.ts`
- Test: `src/__tests__/voiceOrders/store.test.ts`, `src/__tests__/voiceOrders/glossary.test.ts`

**Interfaces:**
- Produces:
  - `type CaptionStyle = 'narration' | 'situation' | 'reaction' | 'item'`
  - `type OrderPayload = { kind: 'caption'; style: CaptionStyle; text: string; placement: 'playhead' | 'after_previous' } | { kind: 'zoom'; scale: number; anchor: Anchor; holdSec: number }`
  - `type Anchor = 'center'|'top_left'|'top'|'top_right'|'left'|'right'|'bottom_left'|'bottom'|'bottom_right'`
  - `type OrderStatus = 'processing' | 'ready' | 'unpolished' | 'no_speech' | 'failed' | 'no_position' | 'applied' | 'apply_failed'`
  - `interface VoiceOrder { id: string; groupId: string; sequenceId: string | null; timeSec: number | null; createdAt: string; transcript: string | null; recordingPath: string; payload: OrderPayload | null; status: OrderStatus; checked: boolean; error?: string }`
  - `class OrderStore { constructor(dir: string); list(sequenceId?: string): VoiceOrder[]; add(o: VoiceOrder): void; update(id: string, patch: Partial<VoiceOrder>): VoiceOrder; remove(id: string): void; save(): Promise<void>; static load(dir: string): Promise<OrderStore> }`
  - `class Glossary { static load(file: string): Promise<Glossary>; apply(text: string): string; promptTerms(): string[]; asPromptBlock(): string; add(term: string, heard: string): Promise<void> }`
  - `voiceOrdersRoot(): string`, `projectDir(projectPath: string): string`

- [ ] **Step 1: 실패하는 테스트 작성**

`store.test.ts`:
- `list()`는 `timeSec` 오름차순, `null`은 맨 뒤, 같은 시각은 `createdAt` 순.
- `list('seqA')`는 `sequenceId === 'seqA'`만.
- `add` 후 `save` → `OrderStore.load(dir)`로 다시 읽으면 같은 목록(임시 디렉터리 사용).
- 새 지시의 `checked` 기본값은 `true`.

`glossary.test.ts`:
- `{"AKS.7": ["에이케이에스 세븐", "에이케이 세븐"]}`에서 `apply("에이케이에스 세븐 주웠다")` → `"AKS.7 주웠다"`.
- 긴 들리는 말부터 치환(`"에이케이에스 세븐"`이 `"에이케이"`보다 먼저).
- `add("쿠엔", "코엔")` 후 파일을 다시 읽어도 반영.
- 파일이 없으면 빈 사전으로 시작하고 오류를 내지 않는다.

- [ ] **Step 2:** `npx jest src/__tests__/voiceOrders` → FAIL(모듈 없음).
- [ ] **Step 3:** 위 Interfaces대로 구현. `id`는 `uuid` v4(이미 의존성에 있음). 저장은 임시 파일에 쓴 뒤 rename.
- [ ] **Step 4:** `npx jest src/__tests__/voiceOrders` → PASS.
- [ ] **Step 5:** 커밋 `feat(voice-orders): order store and game glossary`.

---

### Task 3: 시간 계산

**Files:**
- Create: `src/voiceOrders/timing.ts`
- Test: `src/__tests__/voiceOrders/timing.test.ts`

**Interfaces:**
- Consumes: `VoiceOrder`, `OrderPayload`, `Anchor` (Task 2)
- Produces:
  - `captionDurationSec(text: string): number` — `clamp(0.8 + 0.12 * [...text].length, 1.5, 5)`
  - `interface PlacedCaption { orderId: string; startSec: number; endSec: number; text: string }`
  - `layoutCaptions(orders: VoiceOrder[], existing: { startSec: number; endSec: number }[]): PlacedCaption[]` — 체크된 caption 지시를 시간순으로 배치
  - `zoomKeyframes(startSec: number, scale: number, holdSec: number, anchor: Anchor): { time: number; scale: number; position: [number, number] }[]` — `timeBase:"sequence"`용 4개 키

- [ ] **Step 1: 실패하는 테스트 작성**
- `captionDurationSec("")` = 1.5, 5글자 → 1.5, 30글자 → 4.4, 100글자 → 5.
- `layoutCaptions`: 같은 `timeSec`의 자막 두 개 → 두 번째 `startSec` = 첫 번째 `endSec` (Review Focus 2).
- 다음 자막 시작이 앞 자막 끝보다 이르면 앞 자막 `endSec`을 다음 시작으로 줄인다(최소 1.5초 보장이 깨지면 그대로 두고 겹침을 다음 쪽 밀기로 해결).
- `placement:"after_previous"` → 타임라인에서 그 지시 `timeSec` 이전에 끝나는 자막(기존 + 이번 배치) 중 가장 늦은 것의 `endSec`에서 시작. 앞 자막이 없으면 `timeSec`.
- 체크 해제·`payload` 없음·`timeSec` null 지시는 제외.
- `zoomKeyframes(10, 120, 2, 'center')` → 시각 `[10, 10.3, 12.3, 12.6]`, 배율 `[100, 120, 120, 100]`, 위치 모두 `[0.5, 0.5]`.
- 앵커 점은 화면을 가로·세로 3등분한 칸의 중심(`top_left` = `[1/6, 1/6]`, `center` = `[0.5, 0.5]`, `bottom_right` = `[5/6, 5/6]`). 확대 중 위치는 그 점이 화면에서 제자리에 있도록 `position = 0.5 + (0.5 - anchorPoint) * (scale/100 - 1)`. 단언: `zoomKeyframes(10, 120, 2, 'bottom_right')`의 2·3번째 키 위치 ≈ `[0.4333, 0.4333]`(소수 4자리), 1·4번째 키는 `[0.5, 0.5]`.

- [ ] **Step 2:** `npx jest src/__tests__/voiceOrders/timing.test.ts` → FAIL.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** 같은 명령 → PASS.
- [ ] **Step 5:** 커밋 `feat(voice-orders): caption layout and zoom keyframe math`.

---

### Task 4: Claude 해석기

**Files:**
- Create: `src/voiceOrders/interpreter.ts`
- Modify: `package.json` (`@anthropic-ai/sdk` 추가)
- Test: `src/__tests__/voiceOrders/interpreter.test.ts`, `src/__tests__/voiceOrders/interpreter.live.test.ts`

**Interfaces:**
- Consumes: `OrderPayload` (Task 2), `Glossary.asPromptBlock()` (Task 2)
- Produces:
  - `interface InterpretResult { status: 'ready' | 'unpolished'; payloads: OrderPayload[]; error?: string }`
  - `class Interpreter { constructor(opts: { client: Pick<Anthropic, 'messages'>; model: string; glossary: Glossary }); interpret(transcript: string): Promise<InterpretResult> }`
  - `buildSystemPrompt(glossaryBlock: string): string`, `ORDERS_SCHEMA` (JSON schema `{orders: OrderPayload[]}`, `additionalProperties:false`)

- [ ] **Step 1: 실패하는 테스트 작성** (`client`는 가짜 객체)
- 가짜 응답 `{"orders":[{"kind":"caption","style":"situation","text":"(누군가가 밖에서 빠르게 달려오는 중)","placement":"playhead"}]}` → `status:'ready'`, payload 1개.
- 응답에 `orders` 2개(확대 + 자막) → payload 2개, 순서 유지.
- 스키마 위반(`style:"joke"`, `scale: 900`) → `status:'unpolished'`, payload는 받아쓴 문장을 그대로 담은 `{kind:'caption', style:'narration', text: transcript, placement:'playhead'}` 1개.
- `stop_reason:"refusal"` → 위와 같은 `unpolished` 폴백.
- 클라이언트가 예외(네트워크·401) → `unpolished` 폴백, `error`에 메시지.
- `buildSystemPrompt`는 사전 블록과 스타일 예시 4종(내레이션·상황·리액션·아이템, 스펙 2장 표의 예)을 포함하고, 사전이 같으면 바이트 단위로 같은 문자열(캐시 안정성).
- `zoom.scale`은 100~300, `holdSec`은 0.5~10으로 스키마에서 제한.

- [ ] **Step 2:** `npx jest src/__tests__/voiceOrders/interpreter.test.ts` → FAIL.
- [ ] **Step 3:** 구현. 요청은 `client.messages.create({ model, max_tokens: 1024, system: [{ type:'text', text: systemPrompt, cache_control: { type:'ephemeral' } }], messages: [{ role:'user', content: transcript }], output_config: { effort: 'low', format: { type:'json_schema', schema: ORDERS_SCHEMA } } })`. 정확한 SDK 필드 이름은 `claude-api` 스킬 문서로 확인하고 추측하지 않는다. 응답은 JSON 파싱 후 수동 검증.
- [ ] **Step 4:** `npx jest src/__tests__/voiceOrders/interpreter.test.ts` → PASS.
- [ ] **Step 5:** `interpreter.live.test.ts`: `VOICE_ORDERS_LIVE=1`일 때만 실행. 스펙 2장 표를 덮는 예시 20문장(두 지시 섞은 문장 3개 포함)의 지시 개수·`kind`·`style`·`placement`를 단언. 실행: `VOICE_ORDERS_LIVE=1 npx jest interpreter.live` → PASS (비용 발생, 사용자 승인 후 실행).
- [ ] **Step 6:** 커밋 `feat(voice-orders): Claude interpreter with structured output and fallback`.

---

### Task 5: 상주 Whisper 워커

**Files:**
- Create: `scripts/voice_orders_stt.py`, `src/voiceOrders/stt.ts`
- Test: `src/__tests__/voiceOrders/stt.test.ts`

**Interfaces:**
- Consumes: `Glossary.promptTerms()`, `Glossary.apply()` (Task 2)
- Produces:
  - Python 프로토콜: stdin 한 줄 `{"id": str, "wav": str, "prompt": str}` → stdout 한 줄 `{"id": str, "ok": bool, "text": str, "error"?: str}`. 시작 시 `{"ready": true}` 한 줄. 모델 `small`, `language="ko"`, `vad_filter=True`, `initial_prompt=prompt`. 기존 `whisper_transcribe.py`의 장치·compute_type 선택을 그대로 따른다.
  - `class SttWorker { constructor(opts: { pythonBin: string; scriptPath: string; glossary: Glossary; timeoutMs?: number }); start(): Promise<void>; transcribe(wavPath: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>; stop(): void }` — 파이썬 경로는 `process.env.PYTHON_PATH || 'python3'`(whisperRunner와 같게), 결과 텍스트에 `glossary.apply` 적용, 빈 문자열이면 `{ok:true, text:''}`.

- [ ] **Step 1: 실패하는 테스트 작성** — `pythonBin`을 `node`로, `scriptPath`를 테스트 안에서 만든 가짜 JS 워커(같은 JSONL 프로토콜로 에코)로 바꿔서:
  - 요청 두 개를 동시에 보내도 `id`로 짝지어 각자 결과를 받는다.
  - 가짜 워커가 응답하지 않으면 `timeoutMs` 후 `{ok:false}`.
  - 가짜 워커가 `"에이케이에스 세븐"`을 돌려주면 결과는 `"AKS.7"`(사전 적용).
  - 워커 프로세스가 죽으면 다음 `transcribe` 호출에서 다시 띄운다.
- [ ] **Step 2:** `npx jest src/__tests__/voiceOrders/stt.test.ts` → FAIL.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** 같은 명령 → PASS. 그리고 실제 확인: `say -v Yuna "괄호치고 누가 밖에서 뛰어온다" -o /tmp/vo.aiff && afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/vo.aiff /tmp/vo.wav` 후 `echo '{"id":"1","wav":"/tmp/vo.wav","prompt":""}' | $PYTHON_PATH scripts/voice_orders_stt.py` → `"ok": true`, 문장에 "괄호"와 "뛰어" 포함.
- [ ] **Step 5:** 커밋 `feat(voice-orders): resident whisper worker`.

---

### Task 6: 프리미어 도구 3개 (`get_playhead`, `set_marker`, `place_mogrt_text`)

**Files:**
- Modify: `src/tools/index.ts` (도구 정의 + `executeTool` 분기 + private 메서드)
- Test: `src/__tests__/tools/index.test.ts` (도구 목록·인자 검증·스크립트 문자열 검사)
- Create: `scripts/voice-orders-live-test.mjs`

**Interfaces:**
- Produces (모두 `executeTool(name, args)`로 호출, JSON 문자열 반환):
  - `get_playhead({ sequenceId? })` → `{ success, sequenceId, timeSec }`
  - `set_marker({ sequenceId?, timeSec, name, comments, colorIndex, markerId? })` → `{ success, markerId, verify: { timeSec, name } }` — `markerId`가 있으면 그 마커를 갱신(이동 포함), 없으면 생성. `colorIndex`: 주황 3, 초록 0, 회색 7(실측 후 Task 1 결과로 확정). 재조회해 이름·시각이 다르면 `success:false`.
  - `place_mogrt_text({ sequenceId?, templatePath, trackName, startSec, endSec, text, clipName })` → `{ success, clipId, trackIndex, verify: { startSec, endSec, text } }` — `trackName` 트랙이 없으면 맨 위에 비디오 트랙 추가 후 이름 설정(Task 1에서 불가로 나오면 트랙 인덱스를 `settings.json`에 저장하고 `trackIndex` 반환), `importMGT` 후 재조회로 새 클립 탐지, 텍스트 설정, 길이 맞춤, 클립 이름 설정, 다시 읽어 셋이 다르면 `success:false`.
- 모든 문자열은 `JSON.stringify`로 스크립트에 넣는다(직접 이어 붙이지 않음).

- [ ] **Step 1: 실패하는 테스트 작성**
  - 세 도구가 `getAvailableTools()`에 있고 필수 인자가 스키마에 있다.
  - `place_mogrt_text`에 `text: 'A "따옴표"\n줄바꿈 \\ 😀'`를 주면 생성된 스크립트가 `JSON.stringify(text)`를 그대로 포함하고, 그 스크립트를 `new Function`으로 구문 검사해 예외가 없다(Review Focus 3). 기존 테스트가 브릿지를 모킹하는 방식을 따른다.
  - `set_marker`에 `timeSec` 음수 → 브릿지 호출 없이 `success:false`.
- [ ] **Step 2:** `npx jest src/__tests__/tools/index.test.ts` → FAIL.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `npx jest` 전체 → PASS.
- [ ] **Step 5:** `scripts/voice-orders-live-test.mjs`: 활성 시퀀스를 `backup_sequence`로 복사한 시퀀스에서 `place_mogrt_text` 3개(같은 시각 두 개는 Task 3 `layoutCaptions`로 배치), `set_clip_motion`(Task 3 `zoomKeyframes`) 1개, `set_marker` 생성·갱신을 실행하고 `list_sequence_tracks`로 클립 3개·시작 시각·키프레임을 확인. 실행: 프리미어 26.5.2 + Start Bridge 상태에서 `npm run build && node scripts/voice-orders-live-test.mjs` → 마지막 줄 `ALL CHECKS PASSED`.
- [ ] **Step 6:** CLAUDE.md 변경 이력에 세 도구 추가, 커밋 `feat(tools): get_playhead, set_marker, place_mogrt_text with verify`.

---

### Task 7: 데몬 (파이프라인 + HTTP API)

**Files:**
- Create: `src/voiceOrders/premiere.ts`, `src/voiceOrders/daemon.ts`
- Modify: `package.json` (`"voice-orders": "node dist/voiceOrders/daemon.js"`)
- Test: `src/__tests__/voiceOrders/daemon.test.ts`

**Interfaces:**
- Consumes: Task 2~6 전부. `PremiereProBridge`, `PremiereProTools.executeTool`.
- Produces:
  - `interface PremierePort { activeSequence(): Promise<{ id: string; projectPath: string } | null>; playhead(): Promise<number | null>; setMarker(o: VoiceOrder, color: 'orange'|'green'|'gray'): Promise<string | null>; existingCaptions(seqId: string): Promise<{ startSec: number; endSec: number }[]>; backup(seqId: string): Promise<boolean>; placeCaption(c: PlacedCaption): Promise<{ ok: boolean; error?: string }>; zoom(atSec: number, keys: ReturnType<typeof zoomKeyframes>): Promise<{ ok: boolean; error?: string }> }` — `premiere.ts`의 `class BridgePremierePort implements PremierePort`가 Task 6 도구와 기존 `set_clip_motion`(V1에서 `atSec`을 덮는 클립, `timeBase:"sequence"`)·`backup_sequence`·`list_sequence_tracks`로 구현.
  - `class VoiceOrdersDaemon { constructor(deps: { premiere: PremierePort; stt: Pick<SttWorker,'transcribe'>; interpreter: Pick<Interpreter,'interpret'>; storeFor: (projectPath: string) => Promise<OrderStore>; settings: Settings }); onKeyDown(): Promise<string /* pendingId */>; onKeyUp(pendingId: string, wavPath: string, durationSec: number): Promise<void>; apply(): Promise<ApplyReport>; listen(port: number): Promise<void> }`
  - `interface ApplyReport { success: boolean; applied: string[]; failed: { id: string; error: string }[]; backupOk: boolean }`
  - HTTP: `POST /hotkey/down` → `{pendingId}`, `POST /hotkey/up {pendingId, wavPath, durationSec}`, `GET /orders`(현재 시퀀스, 시간순), `PATCH /orders/:id {checked?|timeSec?|payload?}`, `POST /orders/:id/repolish`, `POST /orders/:id/retry`, `DELETE /orders/:id`, `POST /apply`, `POST /glossary {term, heard}`, `POST /record/start`·`/record/stop`(도우미 47614로 전달), `GET /events`(SSE: `orders-changed`, `status`). 바인드 주소는 `127.0.0.1`.
  - `Settings`: `{ model: string; captionTemplatePath: string; captionTrackName: 'AI 자막'; hotkeyKeyCode: 105; markerMode: 'immediate' | 'onPause'; zoomDefaults: { scale: 120; holdSec: 2; anchor: 'center' } }`

- [ ] **Step 1: 실패하는 테스트 작성** (가짜 `PremierePort`·`stt`·`interpreter`)
  - `onKeyDown` 때 `playhead()` 값이 지시 `timeSec`이 되고, `markerMode:'immediate'`면 주황 마커를 만든다.
  - `playhead()`가 `null`(브릿지 꺼짐) → 지시 `status:'no_position'`, `timeSec:null`, `apply()` 대상에서 빠짐 (Review Focus 1).
  - `durationSec < 0.4` → 지시를 만들지 않고 pending 제거 (Review Focus 4).
  - STT 결과 빈 문자열 → `status:'no_speech'`, 해석기 호출 안 함 (Review Focus 4).
  - 해석 결과 payload 2개 → 같은 `groupId`·`timeSec`의 지시 2개.
  - `apply()`: 활성 시퀀스가 `seqB`면 `seqA` 지시는 건드리지 않음 (Review Focus 5); `backup()` 실패면 아무것도 적용하지 않고 `success:false`; 일부 `placeCaption` 실패 → 성공한 것은 `applied`(초록 마커), 실패는 `apply_failed`, 전체 `success:false`.
  - `PATCH timeSec` → 지시 시각과 마커 이동(`setMarker` 재호출), 목록 재정렬.
- [ ] **Step 2:** `npx jest src/__tests__/voiceOrders/daemon.test.ts` → FAIL.
- [ ] **Step 3:** 구현. HTTP는 Node 내장 `http` 모듈(새 의존성 없이).
- [ ] **Step 4:** `npx jest` 전체 → PASS.
- [ ] **Step 5:** 커밋 `feat(voice-orders): daemon pipeline and local API`.

---

### Task 8: 단축키 도우미 (Swift)

**Files:**
- Create: `helpers/VoiceHotkey/Package.swift`, `helpers/VoiceHotkey/Sources/VoiceHotkey/main.swift`, `helpers/VoiceHotkey/Sources/VoiceHotkey/Recorder.swift`, `helpers/VoiceHotkey/Sources/VoiceHotkey/DaemonClient.swift`, `helpers/VoiceHotkey/Info.plist` (`NSMicrophoneUsageDescription`)

**Interfaces:**
- Consumes: 데몬 HTTP `POST /hotkey/down`, `POST /hotkey/up` (Task 7)
- Produces: `127.0.0.1:47614`의 `POST /start`, `POST /stop` (패널 녹음 버튼용). 메뉴바 아이콘: 대기 ○ / 녹음 ● / 데몬 연결 끊김 ⚠.

- [ ] **Step 1:** `NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .keyUp])`로 keyCode 105(설정값) 감지, 키 반복(`isARepeat`) 무시. 누름 → `/hotkey/down` 응답의 `pendingId` 보관 + 녹음 시작, 뗌 → 녹음 종료 후 WAV를 `recordings/`에 저장하고 `/hotkey/up`.
- [ ] **Step 2:** `Recorder`는 `AVAudioRecorder`, 16kHz mono Linear PCM.
- [ ] **Step 3:** 빌드 확인 `swift build -c release --package-path helpers/VoiceHotkey` → 성공.
- [ ] **Step 4:** 수동 확인: 데몬을 띄운 상태(`npm run voice-orders`)에서 도우미 실행 → 손쉬운 사용·입력 모니터링·마이크 권한 허용 → F13 누르고 말함 → `curl -s 127.0.0.1:47613/orders`에 새 지시가 `ready`로 나타남.
- [ ] **Step 5:** 커밋 `feat(voice-orders): macOS hotkey and recorder helper`.

---

### Task 9: 검토 패널 (CEP)

**Files:**
- Create: `cep-plugin/voice-orders.html`, `cep-plugin/voice-orders.js`
- Modify: `cep-plugin/CSXS/manifest.xml` (Extension `com.mcp.premiere.cepbridge.voiceorders`, 메뉴 이름 `AI 음성 지시`, 기본 크기 높이 260 × 너비 900)

**Interfaces:**
- Consumes: 데몬 HTTP API와 `GET /events` (Task 7). 줄 클릭 시 재생헤드 이동은 `CSInterface.evalScript("app.project.activeSequence.setPlayerPosition('<ticks>')")`.

- [ ] **Step 1:** 시안(`docs/superpowers/specs/assets/2026-11-06-voice-orders-mockup.png`)의 1번 패널 구성대로 만든다: 상태 줄(녹음 중·단축키 안내·패널 녹음 버튼·설정), 표(체크·위치·내가 한 말·Claude가 이해한 것·고치기/다시 다듬기/삭제), 아래 줄(개수·"체크한 N개 적용"). 상태별 표시: `processing` 처리 중, `unpolished` 다듬기 안 됨, `no_speech` 인식된 말 없음, `failed` 실패 + 다시 처리, `no_position` 위치 모름 + 시간 입력칸, `applied` 적용됨.
- [ ] **Step 2:** 자막 글자를 고쳐 저장하면 받아쓴 말과 다를 때 "사전에 추가" 버튼을 띄우고, 누르면 `POST /glossary`.
- [ ] **Step 3:** 데몬에 연결 못 하면 패널 전체에 "음성 지시 데몬이 꺼져 있음 — `npm run voice-orders`" 안내. 데몬의 `status` 이벤트에 `bridge: false`가 오면 상단에 "MCP Bridge 패널에서 Start Bridge 필요"를 띄운다(녹음·해석은 계속 쌓임, 스펙 6장). 이를 위해 Task 7의 `GET /events` `status` 이벤트는 `{ bridge: boolean, stt: boolean, model: string }`를 담는다.
- [ ] **Step 4:** 수동 확인: 프리미어에서 창 → 확장 → AI 음성 지시 → Task 8 흐름으로 지시 3개 → 목록이 시간순, 체크 해제·고치기·시간 고치기가 반영되고 "적용" 후 타임라인에 자막·확대가 들어가며 마커가 초록으로 바뀜.
- [ ] **Step 5:** 커밋 `feat(voice-orders): review panel`.

---

### Task 10: 설치·문서·실사용 확인

**Files:**
- Create: `scripts/install-voice-orders.sh` (빌드, `swift build`, `~/Library/LaunchAgents/com.wmbb.voice-orders.daemon.plist`·`com.wmbb.voice-orders.hotkey.plist` 등록, `PYTHON_PATH` 전달)
- Modify: `package.json` (`"voice-orders:install": "bash ./scripts/install-voice-orders.sh"`), `docs/INSTALL.md`(음성 지시 절), `CLAUDE.md`(변경 이력)

- [ ] **Step 1:** 설치 스크립트 작성. 이미 등록돼 있으면 `launchctl bootout` 후 다시 등록. API 키는 묻지 않고, `ant auth status`도 `ANTHROPIC_API_KEY`도 없으면 설정 방법만 출력.
- [ ] **Step 2:** `npm run voice-orders:install` 후 `launchctl print gui/$(id -u)/com.wmbb.voice-orders.daemon | grep state` → `state = running`, `curl -s 127.0.0.1:47613/orders` → JSON.
- [ ] **Step 3:** 실사용: 11분 게임 영상에서 지시 20개 이상(자막 4종·확대·두 지시 섞기·뒤로 돌려 말하기 포함)을 남기고 적용 → 재생이 끊기지 않는지, 키를 뗀 뒤 목록 갱신까지 걸린 시간(데몬 로그) 기록. 결과를 CLAUDE.md 변경 이력에 적는다.
- [ ] **Step 4:** 커밋 `feat(voice-orders): installer, docs, field test results`.
