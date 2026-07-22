---
name: verify-cut-result
description: 컷편집 결과를 독립 검증한다. 시퀀스 실측 길이와 기대 길이 대조, fullyApplied·shortfallSec·inSync 자가검증 필드 검사, 알려진 스팬셋으로 회귀 재현 테스트를 수행. 컷편집·리플삭제·무음제거를 실행한 직후, "제대로 잘렸는지 확인", "길이 맞는지 검증", "회귀 테스트", "편집 결과 검증", "cut 검증" 요청 시, 그리고 apply_timeline_removals·razor·remove_from_timeline 등 변경계열 도구 코드를 수정한 뒤에는 반드시 이 스킬을 사용할 것. 재검증·다시 검증·검증 결과 갱신 요청에도 사용.
---

# verify-cut-result — 컷편집 결과 검증

## 이 스킬이 존재하는 이유

Premiere MCP의 변경계열 도구는 `success: true`를 "호출이 접수됐다"는 뜻으로 반환한다. 의도한 편집이 실제로 일어났다는 보장이 아니다. 실측 사례: `apply_timeline_removals`가 계획한 18개 스팬 중 일부만 리플 삭제하고도 `success: true`를 반환했고, 사람이 시퀀스 길이를 눈으로 재보기 전까지 아무도 몰랐다.

그래서 이 검증의 제1 원칙은 하나다 — **도구의 자기 보고를 믿지 말고, 시퀀스에서 값을 다시 읽어라.**

## 검증 절차

### 1. 실측 길이 대조 (필수, 가장 강한 신호)

`list_sequences`로 작업 시퀀스 길이를 **재조회**한다. 실행 도구가 반환한 숫자를 재사용하지 마라.

```
기대 길이 = 원본 길이 − Σ(각 스팬의 end − start)
판정      = |실측 − 기대| ≤ 허용오차 (기본 0.1초)
```

이 대조 하나가 부분 적용·시간 기준 오판(source vs timeline)·중복 적용을 전부 잡아낸다. 다른 검사가 다 통과해도 이게 어긋나면 불합격이다.

### 2. 자가검증 필드 검사

실행 응답에서 확인한다:

| 필드 | 불합격 조건 |
|---|---|
| `fullyApplied` | `false` |
| `shortfallSec` | `> 0` |
| `skippedCount` | `> 0` (`skipped[]`에 어떤 스팬이 빠졌는지 있다) |
| `inSync` | `false` |
| `applyWarning` · `syncWarning` | `null`이 아님 |

**`fullyApplied` 키 자체가 없으면 판정은 `UNVERIFIABLE`이다.** 서버가 구버전 코드로 돌고 있다는 뜻이므로(빌드 누락 또는 재시작 실패), 통과로 처리하지 말고 `npm run build` 후 MCP 서버 재시작을 안내하라.

### 3. A/V 싱크 교차 대조

`removedSecPerTrack`의 비디오·오디오 삭제량 차이가 1프레임(≈0.033초)을 넘으면 불합격. 길이가 맞아도 싱크가 깨진 결과물은 쓸 수 없다.

### 4. 회귀 재현 테스트

도구 코드를 수정한 뒤에는 필수다. `assets/regression-fixtures.json`을 읽어 실행한다:

1. 픽스처의 `sourceSequenceId`를 `duplicate_sequence`로 복제 — **원본은 읽기 전용 기준물이다. 절대 편집하지 마라.**
2. 복제 직후 `list_sequences`로 **새 id를 확인**한다. `duplicate_sequence`는 rename에 실패하고도 성공을 반환하므로 이름으로 사본을 찾으면 안 된다.
3. 픽스처의 `removals`와 `params`를 그대로 적용한다.
4. `expect` 블록의 모든 값과 대조한다.
5. 사본을 `delete_sequence`로 정리한다 — **단, 불합격 시에는 남긴다.** 사람이 열어봐야 할 증거다.

`knownFailureSignature`는 과거 실패의 지문이다. 실측 길이가 그 값 근처면 어떤 회귀인지 바로 알 수 있다.

## 판정과 보고

판정은 `PASS` / `FAIL` / `UNVERIFIABLE` 셋 중 하나다. `UNVERIFIABLE`을 `PASS`로 뭉개지 마라 — 검증 못 한 것과 통과한 것은 다르다.

**불합격 시 정지하고 사람에게 보고한다. 자동 복구·재시도를 하지 마라.** 이번에 고친 버그가 "조용히 통과"해서 생긴 것이라, 검증자가 조용히 복구하면 같은 실패가 은폐된다. 또 부분 적용된 타임라인에 같은 스팬셋을 재적용하면 엉뚱한 구간이 잘려 상태가 더 나빠진다.

보고에 포함할 것: 기대값·실측값·차이 / 실패한 체크 항목 / 작업 사본 id(사람이 직접 열어볼 수 있게) / 원본 백업 무사 여부.

## 출력

`_workspace/03_verifier_report.json` — 형식은 `.claude/agents/cut-verifier.md`의 출력 프로토콜을 따른다.

## 테스트 시나리오

**정상 흐름:** 539.17초 시퀀스에 18개 스팬(총 239.52초) 적용 → 실측 299.63초 조회 → 기대 299.65초와 차이 0.02초(허용오차 내) → `fullyApplied: true`, `shortfall: 0`, `inSync: true` → `PASS`.

**에러 흐름:** 같은 조건에서 실측이 464초로 나옴 → 차이 164초로 허용오차 초과 → `fullyApplied: false`, `shortfallSec > 0` 확인 → `FAIL` 판정, 사본 보존, 삭제 매칭 회귀(포함관계 기준 복귀) 의심을 명시해 보고 → `contract-keeper`에 도구 코드 감사 제안.

**검증 불능 흐름:** 응답에 `fullyApplied` 키 없음 → `UNVERIFIABLE` → 빌드·재시작 안내 후 중단.
