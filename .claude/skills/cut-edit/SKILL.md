---
name: cut-edit
description: Premiere 컷편집 전체 워크플로우를 조율하는 오케스트레이터. 탐지 → 백업·적용 → 독립 검증 파이프라인을 순서대로 실행하고 게이트에서 정지 판정한다. "컷편집 해줘", "무음 제거해줘", "영상 잘라줘", "자동 편집", "컷 따줘", "편집 파이프라인 실행" 요청 시 이 스킬을 사용할 것. 부분 재실행("검증만 다시", "계획만 수정", "다시 잘라줘"), 이전 결과 개선, 회귀 테스트 요청에도 사용한다. 단순 조회(시퀀스 목록, 길이 확인)는 이 스킬 없이 직접 응답 가능.
---

# cut-edit — 컷편집 오케스트레이터

**실행 모드: 서브에이전트** (Phase별 `Agent` 도구 직접 호출, 모두 `model: "opus"`)

컷편집을 `탐지 → 적용 → 검증` 파이프라인으로 실행한다. 세 역할을 분리하는 이유는 하나다 — **실행자가 자기 성공을 판정하면 부분 실패가 은폐된다.** 이 프로젝트에서 실제로 그렇게 터진 버그가 이 하네스의 출발점이다.

## Phase 0 — 컨텍스트 확인

작업 시작 전 `_workspace/` 상태로 실행 모드를 판별한다:

| 상태 | 모드 |
|---|---|
| `_workspace/` 없음 | **초기 실행** — Phase 1부터 전체 |
| 있음 + 부분 수정 요청 ("검증만 다시", "계획 임계값 조정") | **부분 재실행** — 해당 Phase만 |
| 있음 + 새 시퀀스/새 입력 | **새 실행** — 기존을 `_workspace_prev/`로 옮기고 Phase 1부터 |

부분 재실행 시 하류 Phase도 다시 돌려야 한다. 계획을 바꿨는데 검증을 갱신하지 않으면 리포트가 거짓이 된다.

## Phase 1 — 탐지 (cut-planner)

`Agent(subagent_type: "cut-planner", model: "opus")`. 스킬 `detect-cut-points` 사용.

산출: `_workspace/01_planner_spanset.json` (`expectedDurationSec`·`toleranceSec` 필수)

**게이트 1 — 계획 검산**
- dryRun `plannedSec` == 계획의 `plannedRemovalSec` 인가
- `sourceTimes` 판정이 명시돼 있는가
- 스팬이 정렬·비중첩인가

불통과 시 planner에게 1회 수정 요청. 재실패면 정지 후 보고.

**사람 확인:** 스팬 개수·총 삭제량·기대 길이를 제시하고 승인을 받는다. 타임라인을 바꾸기 전 마지막 되돌릴 수 있는 지점이다.

## Phase 2 — 적용 (cut-operator)

`Agent(subagent_type: "cut-operator", model: "opus")`. 스킬 `apply-cuts-safely` 사용.

산출: `_workspace/02_operator_result.json` (원시 응답 + 재조회 실측 길이)

operator는 성공을 판정하지 않는다. 응답에 "정상 적용됨" 같은 문구가 섞여 있으면 그 자체가 프로토콜 위반이다.

## Phase 3 — 검증 (cut-verifier)

`Agent(subagent_type: "cut-verifier", model: "opus")`. 스킬 `verify-cut-result` 사용.

Phase 1의 기대값과 Phase 2의 실행 사실을 **둘 다** 읽어 교차 대조한다. 한쪽만 읽는 검증은 무효다.

산출: `_workspace/03_verifier_report.json`

**게이트 2 — 최종 판정 (정지형)**

| 판정 | 동작 |
|---|---|
| `PASS` | 완료 보고. 사본 정리는 사람 승인 후 |
| `FAIL` | **즉시 정지.** 기대값·실측값·차이, 실패 항목, 사본 id, 원본 무사 여부를 보고. **자동 롤백·재시도 금지** |
| `UNVERIFIABLE` | **즉시 정지.** `fullyApplied` 필드 부재면 구버전 서버 — `npm run build` + MCP 재시작 안내 |

정지형인 이유: 고친 버그가 "조용히 통과"해서 생긴 것이라, 검증자가 조용히 복구하면 같은 실패가 은폐된다. 또 부분 적용된 타임라인에 재적용하면 엉뚱한 구간이 잘려 상태가 더 나빠진다.

`UNVERIFIABLE`을 `PASS`로 뭉개지 마라 — 검증 못 한 것과 통과한 것은 다르다.

## Phase 4 — 코드 감사 (contract-keeper, 조건부)

다음 중 하나면 실행한다:
- 같은 실패가 2회 이상 반복
- 변경계열 도구 코드를 수정했음
- 사용자가 도구 감사를 명시 요청

`Agent(subagent_type: "contract-keeper", model: "opus")`. 스킬 `tool-return-contract` 사용.
산출: `_workspace/04_contract_audit.md`

## 데이터 전달

**반환값 기반**(에이전트 결과 수집) + **파일 기반**(`_workspace/`, 감사 추적). 중간 파일은 지우지 않는다 — 사후 검증의 증거다.

파일명: `{phase}_{agent}_{artifact}.{ext}`

## 에러 핸들링

- 에이전트 1회 실패 → 재시도 1회. 재실패 시 그 결과 없이 진행하지 말고 **정지**한다(컷편집은 파괴적 작업이라 누락 진행이 불가).
- 상충하는 데이터(operator 보고 길이 ≠ 재조회 길이) → 삭제하지 말고 둘 다 출처와 함께 보고. 재조회 값이 판정 기준이다.
- 원본 백업 훼손 의심 → 최우선으로 보고하고 모든 작업 중단.

## 확장 슬롯 (미구현)

컷편집을 먼저 완성하고 하나씩 추가한다. 아래는 **선언만 되어 있고 구현되지 않았다** — 요청받으면 이 하네스 밖에서 처리하거나, 하네스 확장을 먼저 제안하라.

| 슬롯 | 도구 | 상태 |
|---|---|---|
| 자막 | `create_caption_track`, `export_captions`, `proofread_transcript` | 미구현 |
| 색보정 | `color_correct`, `apply_lut` | 미구현 |
| 익스포트 | `export_sequence`, `export_frame` | 미구현 |
| 숏폼 | `make_short`, `auto_reframe_sequence` | 미구현 |

각 슬롯 추가 시: 해당 도구를 `tool-return-contract`로 먼저 감사 → 전용 스킬 생성 → 이 파일에 Phase 추가 → CLAUDE.md 변경 이력 기록.

## 테스트 시나리오

**정상 흐름:** 539.17초 시퀀스 → planner가 18개 스팬(239.52초) 탐지, 기대 299.65초 → 게이트 1 통과, 사람 승인 → operator가 복제 후 1패스 적용, 실측 299.63초 기록 → verifier가 차이 0.02초·`fullyApplied: true`·`inSync: true` 확인 → `PASS` 보고.

**에러 흐름:** 같은 조건에서 실측 464초 → verifier가 차이 164초·`fullyApplied: false` 확인 → `FAIL` 정지, 사본 보존, 삭제 매칭 회귀 의심 보고 → 2회 반복 시 Phase 4로 `contract-keeper` 투입.
