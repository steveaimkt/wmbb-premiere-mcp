---
name: detect-cut-points
description: 시퀀스에서 삭제할 구간(스팬셋)을 탐지해 계획을 만든다. 무음 구간·필러 단어·불필요 발화 탐지, 소스시간↔타임라인시간 판정, 기대 길이 계산, dryRun 검산까지. "무음 잘라줘", "컷 포인트 찾아줘", "어디 자를지 분석", "필러 제거", "삭제 구간 계획", "스팬셋 만들어" 요청 시 이 스킬을 사용할 것. 실제 삭제는 하지 않으므로, 자르기 전 계획 단계에서 반드시 먼저 사용한다. 계획 수정·임계값 조정·다시 탐지 요청에도 사용.
---

# detect-cut-points — 컷 계획 수립

삭제할 시간 스팬의 목록을 만든다. **타임라인을 변경하지 않는다.** 실행은 `apply-cuts-safely`가 한다.

## 1. 대상 확정 — 이름이 아니라 id로

`list_sequences`로 시퀀스 id와 길이를 확정한다. 이 프로젝트에는 "시퀀스 02 복사"와 "시퀀스 02 복사 복사"처럼 한 단어 차이 나는 이름이 실재한다. 이름으로 지목하면 엉뚱한 시퀀스를 편집한다.

원본 길이는 여기서 읽은 값을 기준으로 삼는다. 이후 모든 계산의 기준점이다.

## 2. 탐지

| 목적 | 도구 |
|---|---|
| 무음 구간 | `analyze_audio_edit_points` |
| 발화 기반 편집점 | `analyze_speech_edit_points` |
| 발화 구간 경계 | `find_speech_spans` |
| 자막 기반 필러 탐지 | `read_sequence_captions` + `src/utils/cutEditing.ts`의 `findFillerWords` / `findTextSpans` |

임계값(최소 무음 길이, 앞뒤 여유 패딩)은 소재에 따라 다르다. 기본값으로 한 번 돌려보고 결과 개수를 사람에게 보여준 뒤 조정하는 편이 낫다.

## 3. 시간 기준 판정 — 가장 흔한 사고 지점

`analyze_audio_edit_points` / `analyze_speech_edit_points`는 **소스 클립 시간**을 반환한다. 타임라인 시간이 아니다. 둘 중 하나를 명시적으로 판정해 계획에 기록하라:

- **`sourceTimes: true`** + `sourceMediaPath` — 분석 도구 출력을 그대로 쓸 때. 기본적으로 이쪽이 맞다.
- **`sourceTimes: false`** — 클립이 `start=0`, `inPoint=0`, `speed=1`이라 타임라인과 1:1 대응함을 `get_clip_properties`로 **직접 확인했을 때만.**

이 판정을 건너뛰면 스팬 전체가 어긋난 자리에 적용된다. 길이는 그럴듯하게 줄어들어서 검증에서도 놓치기 쉽다.

## 4. 스팬 정리

- 겹치는 스팬은 병합한다 — 겹친 채로 넘기면 기대 길이 계산이 틀어진다.
- 시작 시각 오름차순 정렬. (도구는 우→좌로 처리하지만 계획 자체는 정렬돼 있어야 사람이 검토할 수 있다.)
- 너무 짧은 스팬(< 0.2초)은 제거한다. 프레임 경계에서 반올림되어 아무것도 안 잘리거나 클립만 잘게 쪼갠다.

## 5. 기대 길이 계산 — 생략 불가

```
plannedRemovalSec  = Σ (end − start)
expectedDurationSec = originalDurationSec − plannedRemovalSec
```

이 값이 검증 게이트의 판정 기준이다. 없으면 `verify-cut-result`가 아무것도 검증할 수 없다.

## 6. dryRun 검산

`apply_timeline_removals`를 `dryRun: true`로 호출해 응답의 `plannedSec`이 네 `plannedRemovalSec`과 일치하는지 확인한다.

불일치하면 계획이 잘못된 것이다 — 시간 기준 오판이나 스팬 중첩을 의심하고, **고치기 전에는 실행 단계로 넘기지 마라.** dryRun은 타임라인을 바꾸지 않으므로 몇 번이든 반복해도 안전하다.

## 출력

`_workspace/01_planner_spanset.json` — 형식은 `.claude/agents/cut-planner.md`의 출력 프로토콜을 따른다. `expectedDurationSec`와 `toleranceSec`는 필수 필드다.

## 테스트 시나리오

**정상 흐름:** 539.17초 시퀀스 → 무음 탐지 18개 스팬(총 239.52초) → 클립이 start=0·inPoint=0·speed=1임을 확인해 `sourceTimes: false` 판정 → 기대 길이 299.65초 계산 → dryRun `plannedSec` 239.52 일치 → 스팬셋 파일 출력.

**에러 흐름:** dryRun `plannedSec`이 계산값과 다르게 나옴 → 스팬 중첩 확인(122.57~122.72 인접 스팬) 및 시간 기준 재판정 → 병합·수정 후 dryRun 재실행 → 일치 확인 후 진행. 끝내 불일치면 계획을 넘기지 않고 사람에게 보고.
