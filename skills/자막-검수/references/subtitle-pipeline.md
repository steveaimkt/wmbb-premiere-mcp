# 편집본 자막 생성 — 매핑 재구성 방식

> **재전사하지 않는다.** 원본 1회 전사의 워드 타임스탬프를 타임라인 클립의 소스 in/out으로 재매핑한다.
> 편집을 아무리 반복해도 이 방식이면 프리미어 실측과 **프레임 단위로 일치**한다.
> 단, **큐 경계 시각은 Whisper 값이 아니라 편집점·실제 소리로 정한다**(§4).

## 왜 재전사하면 안 되나

`export_captions(filePath, importToSequence)`로 편집본을 다시 전사해봤을 때(2026-08-03 실측):
- 품질이 오히려 하락 — 이미 고쳐놓은 용어가 엉뚱한 말로 되돌아가고, 브랜드명이 띄어쓰기로 쪼개지고, 문장이 `"…된다."`처럼 중간에서 끊김
- `importToSequence`는 **`Illegal Parameter type`으로 항상 실패** (캡션 트랙 0개)
- 20분 재전사에 수 분 소요

원본 전사는 이미 있고, 매핑은 산술이다. 재전사는 시간을 쓰고 품질을 잃는다.

---

## 1단계 — 타임라인에서 매핑 테이블 만들기

`list_sequence_tracks(includeSourceTimes:true)` 한 콜이 V1·A1 클립별 소스 in/out을 준다. 클립이 많으면 결과가 파일로 저장되니 그 파일을 파싱한다(MCP content 배열이면 `json.loads(d[0]["text"])`, 문자열이면 한 번 더 `json.loads`).

```python
# NEW = [(src_start_frame, src_end_frame, timeline_start_frame), ...]
NEW = []; acc = 0
for cv, ca in zip(v1, a1):
    a, b = round(cv["inPoint"]*FPS), round(cv["outPoint"]*FPS)
    assert (a, b) == (round(ca["inPoint"]*FPS), round(ca["outPoint"]*FPS))
    assert round(cv["startTime"]*FPS) == acc
    NEW.append((a, b, acc)); acc += b - a
assert abs(acc/FPS - verify["measuredEndSec"]) < 1e-4     # ← 반드시 통과
```

**검증 실패하면 매핑이 틀린 것이다. 자막을 만들지 말고 멈춘다.**
타임라인 시각 → 소스 시각: `f = t*FPS`; `c ≤ f < c+(b-a)`인 클립에서 `src = (a + f - c)/FPS`.

---

## 2단계 — 단어를 타임라인으로 투영

```python
for w in sentence["words"]:                       # keep 문장만 (decisions.json의 delete 제외)
    sa, sb = w["start"]*FPS, w["end"]*FPS
    iv = [((c+max(sa,a)-a)/FPS, (c+min(sb,b)-a)/FPS, (min(sb,b)-max(sa,a))/FPS)
          for a,b,c in NEW if min(sb,b) > max(sa,a)]
    ov = sum(x[2] for x in iv)
    if not iv or (ov < 0.12 and ov < 0.4*(sb-sa)/FPS): placed = None    # 빠짐
    else: placed = dict(w=w["word"], s=iv[0][0], e=iv[-1][1], sid=sentence["id"])
```
- 길이 0 단어: 그 점이 클립 안이면 점으로 투영, 아니면 빠짐.
- **빠진 단어 처리:** `cut_words`(잘린 목소리 판정으로 확정한 진짜 잘린 단어 + 컷편집에서 의도적으로 뺀 소리)에 있으면 버린다. 그 밖은 Whisper 시각 오류이므로 같은 문장의 앞 단어 끝(없으면 다음 단어 시작)에 점으로 붙인다.

### 잘린 목소리 판정 (빠진 단어가 진짜 잘렸는지)
원본 에너지(10ms)에서 `레벨 > noise+10dB` 프레임 중 **타임라인 맵에 없는(잘린) 프레임**을 덩어리로 묶는다. 삭제 의도 구간(delete 문장, 머리·꼬리)은 제외. 덩어리 ≥120ms, peak ≥ noise+15dB를 나열하고 각 구간을 slice ASR로 들어 라벨을 붙인다. 필러·숨·첫 시도 반복이면 정상, 실제 단어면 컷 오류.

---

## 3단계 — 의미 단위 분할 (동적계획법)

문장(같은 sid, 0.7초 이상 쉼이면 분리) 단위로:
```python
best[0] = 0
for j in 1..n:
    for i in j-1 .. 0:
        L = len(text(u[i:j]).replace(" ", ""))          # 공백 제외 글자수
        if L > MAXC: break                                # MAXC = 25
        dur = (u[j].s if j < n else next_unit_start) - u[i].s   # 실제 노출 = 다음 큐 시작까지
        cost = 2
        if L < 6 and total_len >= 6: cost += 4
        if dur < 0.7: cost += (0.7 - dur) * 12
        if dur > 5.5: cost += 2
        if L > 18:   cost += (L - 18) * 0.4
        if j < n:    cost += boundary_cost(u[j-1], u[j], cut_between)
        best[j] = min(best[j], best[i] + cost)
```
3자 이하 문장 전체("네", "그렇죠")는 다음 문장 앞에 붙여 한 단위로 만든다(혼자 0.2초 뜨는 것 방지).

### boundary_cost(앞 단어 w, 뒤 단어 n)
| 조건 | 비용 |
|---|---|
| 쉼표로 끝남 | 0 |
| 종결 `다/요/죠/까/네요` | 0.5 |
| 연결 `는데 건데 은데 던데 지만 니까 거든요 잖아요 고 서 면 면서 거나 는지 인지 건지 때문에 위해서 도록 다가 든가 든지 아니라 텐데` (단 `에서` 제외) | 0.5 |
| 주제어(`저는/거는/보다는/에는/에서는/으로는/분은` 및 꾸밈이 아닌 `-은/-는`) | 2.5 |
| 꾸밈어미 `하는 되는 있는 없는 오는 가는 보는 주는 드는 시는 리는 지는 히는 기는 같은 많은 작은 높은 좋은 적은 다른 하던 했던 하셨던 할 될 한 된 던 적인 의 않는 않은 않을 었던 았던 하신 되신 보이는 생기는 만드는` | 8 |
| 목적 `을/를` | 5 |
| 기타 조사 `이 가 도 에 에게 한테 으로 로 와 과 만` | 4.5 |
| 그 밖(맨 명사·부사) | 5 |
| `~기 / 위해서·위한` | 9 |
| `~기` 로 끝남 (명사형, `예측하기 / 어려운`) | ≥ 6 |
| `~고 / 있·싶·계` (진행·희망) | 9 |
| `~해야·어야·아야 / 된·돼·되·한·합·해` | 9 |
| `~면 / 좋·될·된·돼` (관용) | 7 |
| `~다고·라고·냐고 / 생각·하·말·얘기·들·봐·보` (인용) | 6 |
| `점·거·것·게 / 하나` | 9 |
| `~지 / 않·못·말` (부정) | 9 |
| 뒤가 `NO_START`로 시작 | +8 (2자 이하 단어) / +6 |
| 앞이 `NO_END` | +6 |
| 뒤가 접속어·주어(`그게 그래서 그리고 근데 하지만 그러면 아니면 또 특히나 일단 왜냐하면 그럼 결국 그러니까 나는 저는 제가 내가 우리가`) | −1 |
| 뒤가 `해야·돼야·되어야`로 시작 | +4 |
| 뒤가 `이상·이하·정도·이내·만큼·쯤`으로 시작 | +6 |
| 두 단어 사이에 **컷**이 있음 (원본에서 쉼이 있던 자리) | −1.5 |
| 단어 사이 타임라인 간격 ≥0.5초 / ≥0.25초 | −2 / −1 |

`NO_START` 한 글자 항목(`수 것 거 게 건 적 중 때 점`)은 **단어 전체가 그 글자이거나 그 글자+조사 1자일 때만** 매칭한다. 앞글자만 보면 `수술`·`중요한`·`때문에`가 걸려 엉뚱한 곳을 피한다(실측: "결과를 얻기 위해서 / 수술을 하는 건데"를 못 고르고 "결과를 / 얻기 위해서…"를 골랐다).

`NO_END` 추가분: `수 것 거 다시 이때 많이 제일 오래 여러 특히나 아무래도 아무리 하지만 어떤 그러한 이러한 요런 어느 내가 우리가 또는`

> 가중치를 하나 바꾸면 다른 곳이 새로 나빠진다(`해야` 앞을 비싸게 → `한 번 / 이상` 발생). **바꿀 때마다 큐 전체를 다시 출력해 읽는다.**

---

## 4단계 — 큐 경계 정렬 (편집점·실제 소리)

```python
cut_frames = [c for a,b,c in NEW if c > 0]
bounds = [0]
for A, B in zip(cues, cues[1:]):
    lo = min(A[-1].s + 0.05, B[0].s); hi = max(B[0].e - 0.02, B[0].s + 0.05)
    cands = [f for f in cut_frames if lo*FPS <= f <= hi*FPS and f > bounds[-1]]
    if cands:
        f = min(cands, key=lambda x: abs(x/FPS - B[0].s))           # 컷에 정확히
    else:
        ts = arange(max(lo, B[0].s-0.35), min(hi, B[0].s+0.15), 0.01)
        f = round(min(ts, key=timeline_db) * FPS)                     # 가장 조용한 지점
        near = [x for x in cut_frames if abs(x-f) <= 10 and x > bounds[-1]]
        if near: f = min(near, key=lambda x: abs(x-f))
    bounds.append(max(f, bounds[-1]+1))
bounds.append(END_F)
```
`timeline_db(t)` = 타임라인 t → 소스 시각 → 원본 10ms 에너지.

### 정렬 QC
- 모든 컷 프레임 f: 가장 가까운 경계 nb와의 거리 d. `d==0` 일치 / `d>10` 또는 `nb`가 다른 컷 = 정상 / 그 밖 = **어긋남(실패)**
- 컷이 아닌 경계의 레벨 > noise+12dB = **말소리 위 경계(실패)** → 그 단어쌍을 3단계 규칙에 추가

---

## 5단계 — 오탈자 교정

`references/korean-typo-glossary.md`(공통)와 프로젝트 전용 `caption_glossary.json`을 **토큰 단위로 먼저**, 큐 병합 **후에 한 번 더** 적용한다.

```json
{
 "token": [["복고", "복코"], ["엉덩이만", "원장님은", 8], ["분은", "", 27], ["환자", "환자분은", 27]],
 "cue":   [["여기까지 밖에", "여기까지밖에"]],
 "cut_words": [[26, "이제"], [42, "하지만"]],
 "unresolved": [[8, "여기까지밖에", "두 판독이 다름 — 확인 필요"]]
}
```
- 세 번째 값 = 문장 ID 범위. 범위 규칙을 먼저, 범위 없는 규칙을 나중에 적용.
- 한 토큰에 규칙이 **순서대로 연쇄** 적용된다 — 삭제 규칙을 앞에, 대체어가 다른 규칙 대상을 포함하지 않게.
- 파일은 BOM 없이 쓰고 `utf-8-sig`로 읽는다.

> 병합 전에는 `"필히"`+`"이 거래명세서에서"`가 따로 있어서 `"필이 이"` 규칙이 안 걸린다.
> 반대로 병합 후에는 줄바꿈이 끼어 `"바이브 코딩라면"`이 안 걸린다.
> **양쪽 다 돌려야 잡힌다.**

---

## 6단계 — QC (전부 0이어야 통과)

```
겹침 · 역순 · 길이0 · 시퀀스 초과 · 큐 사이 공백 · 여러 줄 큐 · 글자수 초과(공백 제외)
· 잔여 오탈자 · 어긋난 컷 · 말소리 위 경계
```
마지막 큐 끝 = 시퀀스 끝 프레임.

---

## 7단계 — SRT 쓰기

```python
def tc(sec):                                  # 올림: 프레임 경계가 ms로 안 떨어짐
    ms = math.ceil(sec*1000 - 1e-6) ...
first_start = "00:00:00,001" if first_frame == 0 else tc(...)   # 0 시작 큐는 프리미어가 떨굼
last_end = floor_ms(END_F/FPS)                                    # 시퀀스 끝을 넘지 않게
```
저장 후 SRT를 다시 읽어 큐 시작 프레임을 floor/round로 각각 계산해 같은지 확인한다.

---

## 8단계 — 프리미어에 올린 뒤 대조

사용자가 SRT를 올리고 **저장**하면 `read_sequence_captions(sequenceId)`가 저장된 `.prproj`에서 읽는다
(`CaptionDataClipTrackItem`의 Start/End ticks, 254016000000 ticks/초). 대조 결과 실측(2026-11-15):
큐 사이 경계 120곳 전부 일치, 첫 큐(0 시작) 누락, 마지막 끝 1프레임 짧음 → 7단계 규칙이 그 대응이다.

## 캡션 트랙으로 넣기

MCP로는 넣지 않는다(`importToSequence`는 재전사 경로). 사용자에게:
> 프리미어 `파일 › 가져오기`로 SRT를 불러온 뒤 프로젝트 패널에서 타임라인으로 드래그

유튜브 업로드용이면 파일 그대로 올리면 된다.
