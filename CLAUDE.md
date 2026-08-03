# WMBB Premiere MCP

## 핵심 기능은 2가지

이 서버는 **컷편집**과 **자막**, 두 가지만 한다. 나머지 도구는 전부 이 둘을 받치는 것이다.

| # | 기능 | MCP 프롬프트 | 전역 스킬 | 트리거 |
|---|------|------------|----------|--------|
| 1 | **컷편집** — 분석 → 카테고리 제안 → 승인 → 리플 삭제 → 실측 검증 | `cut_edit_workflow` | `프리미어-컷편집` | "컷편집 시작하자" |
| 2 | **자막** — 매핑 재구성 → 원본 전사 재투영 → 큐 조립 → 오탈자 교정 → QC | `caption_review_workflow` | `자막-검수` | "자막 검수 시작하자" |

**둘은 독립적이다.** 자막은 컷편집을 거치지 않은 타임라인(사용자가 프리미어에서 직접 편집한 것)에도 단독으로 걸린다. 실사용에서 자막 쪽이 훨씬 자주 돌아간다 — 재편집할 때마다 필요하기 때문.

**자막의 1번 규칙: 편집본을 재전사하지 않는다.** `list_sequence_tracks(includeSourceTimes:true)`가 반환하는 클립별 소스 in/out이 곧 source→timeline 맵이다. 원본을 한 번만 전사하고 그 워드 타임스탬프를 재투영하면, 몇 번을 재편집해도 프레임 단위로 맞는다. 재전사는 느리고 누적 교정을 날리며 품질도 떨어진다(실측: 고쳐둔 용어가 엉뚱한 말로 되돌아감).

**스킬 위치:** 두 스킬의 원본은 저장소 `skills/`에 있고 `npm run skills:install`로 `~/.claude/skills/`에 설치한다(기본 심볼릭 링크 = 저장소가 단일 원본). 스킬 수정은 **저장소 쪽**에서 한다.

**진입점:** 작업은 전역 스킬(`~/.claude/skills/`)로 진입한다. 단순 조회(시퀀스 목록·길이 확인)는 스킬 없이 직접 응답.

**설치:** `docs/INSTALL.md`. 브릿지는 프리미어 **안에서** 도는 CEP 패널이라 패널을 켜지 않으면 클라이언트가 서버를 연결됐다고 표시해도 모든 툴 호출이 실패한다. **프리미어 Beta 빌드**를 쓴다 — 정식 빌드에서는 패널이 뜨지만 호출이 돌아오지 않는다.

**목표:** 두 파이프라인 모두 **검증 가능**하게 만든다. 변경계열 도구가 부분 실패를 `success: true`로 은폐하지 못하게 하는 것이 핵심.

> 2026-07-24 정리: 초기 서브에이전트 하네스(cut-edit 오케스트레이터 + 에이전트 4 + 스킬 5)는 **삭제**했다. 탐지 철학이 구식(`analyze_audio_edit_points` 진폭 기반, 평면 목록)이라 신방식 `proposals[]`와 충돌했고, 후크 삭제 사고의 조건을 그대로 갖고 있었다. 검증 원칙(아래)은 단일 스킬 STEP 4에 흡수됐다. 하네스가 다시 필요하면 git 이력에서 복원.

**핵심 원칙:** `success: true`는 "호출이 접수됐다"는 뜻이지 "의도한 편집이 됐다"는 뜻이 아니다. 판정은 항상 대상에서 값을 **재조회**해서 한다.

**탐지 원칙:** `analyze_audio_edit_points`(진폭 무음) 사용 금지 — 노이즈 플로어 −21dB 소재에서 임계값 2dB 차이로 결과가 폭주한다. `analyze_speech_edit_points`(Whisper `small`+, 자막 기반)만 쓴다.

**검증 계약(2026-08-03 신설):** 변경계열 도구는 **스스로 재조회한 결과를 함께 반환한다.**
`apply_timeline_removals` / `insert_clip`은 실행 후 타임라인을 다시 읽어 `verify`(실측 길이·갭 수·V/A 정합)를 붙이고,
문제가 있으면 **`success`를 `false`로 내린다**. 호출자는 도구의 자기 보고(`fullyApplied` 등)가 아니라 `verify`로 판정한다.
`list_sequences.duration`은 편집 중 과도 상태를 반환하므로 **길이 판정 근거로 쓰지 않는다** — `list_sequence_tracks.verify.measuredEndSec`를 쓴다.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-08-03 | **핵심 기능 2축 정립** — `caption_review_workflow` 프롬프트 신설, 스킬을 `프리미어-컷편집` / `자막-검수`로 분리 | `prompts/index.ts`, `~/.claude/skills/` | 자막이 컷편집의 마지막 단계로 묶여 있어, 편집만 손본 뒤 자막만 다시 만들려 할 때마다 컷편집 전체를 거쳐야 했다. 실사용에서 자막 요청이 훨씬 잦다 |
| 2026-08-03 | `insert_clip` 신규 | `tools/index.ts` | 서버에 **가산 편집이 전혀 없었다.** 콜드오픈·구간 복원·B롤을 전부 사용자가 수동으로 해야 했고, 실사용에서 두 번 막혔다. insert(리플)/overwrite 지원, projectItem in/out을 쓰고 원복 |
| 2026-08-03 | `list_sequence_tracks`에 소스 in/out + `verify` + `compact` | `tools/index.ts` | 클립별 `inPoint/outPoint`가 없어 자막 재매핑에 `get_clip_properties`를 클립 수만큼 호출해야 했다(실사용 15+회). 이제 **한 콜이 source→timeline 맵**. 갭·V/A 정합·실측 길이도 같이 반환. 클립 수백 개 토큰 초과는 `compact`로 해소 |
| 2026-08-03 | 변경계열 도구 자체 검증(`withVerification`) | `tools/index.ts` | `fullyApplied:true`·`inSync:true`·`shortfallSec:0`이 전부 정상인데 타임라인에 27초 구멍이 남은 사례. 이제 재조회해 갭이 있으면 `success:false` |
| 2026-08-03 | `createCaptionTrack` 파라미터 수정 | `tools/index.ts` | `export_captions(importToSequence)`가 **항상 `Illegal Parameter type`**. 원인은 시작시각을 초(number)로, 포맷을 이름(string)으로 넘긴 것. ticks 문자열 + 정수 상수로 교정하고 빌드별 시그니처 3형태 폴백 |
| 2026-07-22 | 초기 서브에이전트 하네스 구성 (에이전트 4 + 스킬 5) | 전체 | `apply_timeline_removals` 부분 적용 버그가 사람의 육안 검증 전까지 발견되지 않음 |
| 2026-07-24 | 하네스 삭제, 단일 스킬 `프리미어-컷편집`으로 일원화 | `.claude/` 전체 | 하네스가 구식 탐지(진폭·평면)를 써 신방식과 충돌·트리거 중복. 검증 원칙은 스킬에 흡수 |
| 2026-07-23 | `analyze_speech_edit_points` 카테고리형 제안으로 재작업 | `speechAnalysis.ts`, `silenceGaps.ts`, `tools/index.ts` | 실사용에서 제안이 평면 목록이라 인트로 여백이 무음으로 승인돼 후크가 삭제됨. proposals[]로 공백·반복·인트로·아웃트로·긴정적을 분리하고 인트로/아웃트로/긴정적은 `recommended:false`. `suggestedRemovals`는 권장 카테고리만 병합 |
| 2026-07-23 | 반복 탐지 시간창(초) + 데드에어 포함 | `speechAnalysis.ts` | 끊긴 테이크→긴 갭→재녹음 패턴을 세그먼트 수 창(lookback=2)이 못 잡음. lookbackSec=25로 바꾸고 removeSpan을 재테이크 시작까지 확장 |
| 2026-07-23 | 기본 모델 `base`→`small`, head-gap 경고 | `speechAnalysis.ts`, `tools/index.ts` | `base`가 한국어 오프닝 26초를 전사 실패→인트로 무음으로 오인 |
| 2026-07-23 | 갭 `kind`(head/inner/tail) 태깅 | `silenceGaps.ts` | 인트로/아웃트로를 컷에서 분리하기 위한 근거 |
