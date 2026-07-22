---
name: tool-return-contract
description: MCP 변경계열 도구의 공통 반환 규약(요청량/실행량/fullyApplied/부족분/경고)을 정의·전파하고, "요청 접수 = success:true"로 부분 실패를 은폐하는 도구를 감사·수정한다. "도구 감사", "반환 규약", "success true 문제", "부분 실패 안 잡힘", "도구에 검증 필드 추가", "MCP 도구 고쳐줘", 새 변경계열 도구를 추가·수정할 때, 그리고 검증에서 같은 실패가 반복될 때 이 스킬을 사용할 것.
---

# tool-return-contract — 변경계열 도구 반환 규약

MCP 서버 **코드 쪽** 작업. `src/tools/index.ts`의 변경계열 도구가 부분 실패를 숨기지 못하게 만든다.

## 문제

도구들이 "요청을 접수했다"는 뜻의 `success: true`를 "의도한 변경이 일어났다"는 뜻처럼 반환한다. 실측 사례:

- `apply_timeline_removals` — 계획한 18개 스팬 중 일부만 적용하고 `success: true`. 원인은 삭제 대상 매칭이 **포함관계 기준**이라 razor로 쪼갠 조각이 스팬에 완전히 포함되지 않으면 누락된 것. **중점(midpoint) 기준**으로 바꿔 해결. 자가검증 필드가 이때 도입됐다.
- `duplicate_sequence` — 이름 변경 실패하고도 `success: true`. `renamedAtProjectItem: false`를 조용히 담아 반환한다. **미수정.**

현재 이 규약을 갖춘 도구는 `apply_timeline_removals` 하나뿐이다.

## 규약

변경계열 도구는 다섯 가지 의미를 반드시 채운다. 필드명은 도메인에 맞게 조정하되 의미는 빠뜨리지 않는다.

| 의미 | 예 (`apply_timeline_removals`) |
|---|---|
| 요청량 | `plannedSec`, `spanCount` |
| 실행량 | `removedSecPerTrack`, `removedClipCount` |
| 완전 적용 여부 | `fullyApplied` |
| 부족분 | `shortfallSec`, `skippedCount`, `skipped[]` |
| 경고 | `applyWarning`, `syncWarning` |

**실행량은 반드시 대상에서 재조회한 값이어야 한다.** 자기가 보낸 명령 수를 세어 실행량이라고 반환하면 규약이 아무것도 보장하지 못한다 — 이번 버그가 정확히 그 형태였다. 명령을 18번 보냈으니 18개가 처리됐다고 가정한 것이다.

`success`의 의미도 좁혀라: **`success: true` = "호출이 예외 없이 끝났다"**. **"의도가 달성됐다" = `fullyApplied`**. 이 둘을 섞으면 규약이 무너진다.

## 감사 절차

1. **분류** — 읽기 전용 / 변경계열로 나눈다. 변경계열만 대상.
2. **우선순위** — 컷편집 파이프라인이 쓰는 것부터: `apply_timeline_removals`(완료) → `duplicate_sequence` → `razor_timeline_at_time` → `remove_from_timeline` → `auto_cut_edit` → `trim_clip` → `move_clip`. 자막·색보정·익스포트 계열은 그 기능을 실제로 쓰기 시작할 때 처리한다. **44개를 한꺼번에 고치지 마라.**
3. **결함 식별** — 각 도구에서 확인할 것:
   - 실행 후 대상을 재조회하는가, 아니면 명령 수를 세는가
   - 부분 성공을 표현할 수단이 있는가
   - 실패를 조용히 삼키는 분기가 있는가 (`catch` 후 `success: true`, 무시되는 불리언 반환값 — `renamedAtProjectItem`이 그 예다)
4. **수정 + 테스트** — 규약 필드를 추가하고 `src/__tests__/`에 **부분 실패가 `fullyApplied: false`로 드러나는 케이스**를 넣는다. 성공 경로만 테스트하는 것은 이 문제에 무력하다. 잡으려는 버그가 "성공한 척하는 실패"이기 때문이다.
5. **기록** — `_workspace/04_contract_audit.md`에 표로 남긴다 (도구명 / 변경계열 / 규약 준수 / 발견 결함 / 조치).

## 작업 원칙

- **한 번에 한 도구.** 매 수정마다 `npm test` + `npm run build`. 한꺼번에 바꾸고 마지막에 테스트하면 실패 원인을 특정할 수 없다.
- **기존 필드명을 깨지 않는다.** `apply_timeline_removals`의 필드명은 `verify-cut-result`가 읽는 운영 계약이다. 새 도구는 이 명명을 따르되 기존 필드 rename은 금지.
- **추측으로 고치지 마라.** 결함이 의심되면 실제 호출로 재현한 뒤 고친다. 재현 불가면 감사 표에 "의심"으로 기록하고 넘어간다.
- **수정 후 회귀 테스트 필수.** 도구 코드를 바꿨으면 `verify-cut-result`의 회귀 픽스처를 돌려 기존 동작이 깨지지 않았는지 확인한다.
- **빌드 후 MCP 서버 재시작을 안내하라.** 코드를 고쳐도 재시작 전까지 구버전이 돈다. 검증에서 `fullyApplied` 필드가 안 보이면 십중팔구 이것이다.

## 테스트 시나리오

**정상 흐름:** `duplicate_sequence` 감사 → `renamedAtProjectItem`이 false여도 성공 반환함을 코드에서 확인 → rename 실패를 `fullyApplied: false` + `warning`으로 표면화 → 부분 실패 테스트 케이스 추가 → `npm test`·`npm run build` 통과 → 서버 재시작 → 회귀 픽스처 통과 → 감사 표 갱신.

**에러 흐름:** 수정 후 기존 테스트가 깨짐 → 해당 도구 수정을 되돌리고 원인을 감사 표에 기록 → 깨진 채로 다음 도구로 넘어가지 않는다.
