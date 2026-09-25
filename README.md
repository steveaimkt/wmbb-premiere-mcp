<h1 align="center">프리미어 MCP (wmbb-premiere-mcp)</h1>

<p align="center">
  <strong>클로드에게 말로 시켜 프리미어 프로 타임라인을 컷편집하고, 편집본 자막을 다시 전사하지 않고 만든다.</strong>
</p>

<p align="center">
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Premiere%20Pro-Beta-9999FF?style=flat-square" alt="Premiere Pro Beta">
  <img src="https://img.shields.io/badge/tools-26-blue?style=flat-square" alt="tools: 26">
  <img src="https://img.shields.io/github/stars/steveaimkt/wmbb-premiere-mcp?style=flat-square" alt="GitHub stars">
</p>

<p align="center">
  <a href="#설치">설치</a> ·
  <a href="#툴-26개">툴 26개</a> ·
  <a href="docs/INSTALL.md">설치 상세</a> ·
  <a href="skills/README.md">스킬</a> ·
  <a href="docs/KNOWN_ISSUES.md">알려진 이슈</a> ·
  <a href="LICENSE.md">MIT</a>
</p>

---

## 이게 뭔가

프리미어 프로를 클로드 같은 AI 클라이언트에서 조작하게 해 주는 MCP 서버다. 하는 일은 두 가지다.

1. **컷편집.** 촬영본에서 말이 없는 구간과 다시 찍은 NG 구간을 찾아 잘라 낸다.
2. **자막.** 편집이 끝난 타임라인에 맞춰 자막을 만든다. 편집본을 다시 전사하지 않는다.

**AI 클라이언트**가 계획을 세워 보여 주고, **사용자**가 승인하면 자른다. 자른 뒤에는 타임라인을 다시 조회해 결과가 계획과 같은지 확인한다.

클로드 데스크톱, 클로드 코드, Codex에서 사용할 수 있다. 지금은 macOS 기준으로 만들었다.

## 여기서 시작

컷편집하려면 → **「컷편집 시작하자」**
자막을 만들려면 → **「자막 검수 시작하자」**
연결이 되는지 보려면 → 「지금 프리미어 프로젝트 정보 알려줘」

툴 이름은 외울 필요가 없다. 하고 싶은 일을 평소 말로 입력하면 AI 클라이언트가 알맞은 툴을 골라 실행한다.
위의 두 문장은 [스킬](skills/README.md)을 설치했을 때 쓰는 말이다. 스킬 없이도 MCP 프롬프트(`cut_edit_workflow`, `caption_review_workflow`)로 같은 절차를 실행할 수 있다.

## 무엇이 다른가

일반 무음 컷 도구는 음량을 기준으로 한 번에 자른다. 이 서버는 말한 내용을 기준으로 계획을 세우고, 승인을 받은 뒤 자르고, 자른 결과를 다시 확인한다.

- **말한 내용을 기준으로 자른다.** Whisper로 단어 단위 전사를 만들고, 단어와 단어 사이 간격으로 무음을 찾는다. 음량 기준은 방 소음이 깔린 촬영본에서 잘 맞지 않는다. 같은 말을 다시 한 재테이크와 문단을 통째로 다시 녹음한 구간도 찾는다.
- **카테고리로 나눠 제안한다.** 반복 테이크와 공백은 삭제를 추천한다. 인트로 후킹, 아웃트로, 긴 화면 시연은 따로 빼 두고 사용자가 판단하게 한다. 무음을 한꺼번에 지울 때 후킹 구간이 같이 사라지지 않는다.
- **화면을 확인한다.** 긴 무음 구간은 정지 화면 검사를 거친다. 화면이 멈춰 있으면 지워도 되는 공백으로, 화면이 바뀌고 있으면 시연 중인 구간으로 보고 남긴다.
- **자르기 전에 계획을 확인받는다.** 카테고리마다 무엇이 잘리는지 표로 보여 주고, 사용자가 승인한 뒤에 자른다.
- **자른 결과를 다시 확인한다.** 자르기 전에 시퀀스를 백업하고, 오디오와 비디오를 함께 잘라 싱크가 어긋나지 않게 한다. 끝나면 타임라인을 다시 조회해 예상 길이와 실제 길이를 함께 보고한다.
- **프리미어 안에서 편집한다.** 파일을 내보냈다가 다시 가져오지 않고, 재인코딩도 하지 않는다. 지금 작업 중인 타임라인을 직접 고친다.

## 이렇게 쓴다

**촬영을 마친 직후.** 프리미어에서 시퀀스를 열고 「컷편집 시작하자」라고 입력한다. 무음, 반복 테이크, 인트로, 아웃트로, 긴 시연이 카테고리별 표로 나온다. 표를 보고 승인하면 자르고, 자른 뒤 실제 길이를 보고한다. 무음과 NG 구간을 찾느라 타임라인을 2시간 동안 훑던 작업이 검토 한 번으로 줄어든다.

**직접 다듬은 뒤 자막이 필요할 때.** 프리미어에서 손으로 편집한 타임라인에서도 「자막 검수 시작하자」라고 입력하면 된다. 앞에서 컷편집을 이 서버로 하지 않았어도 된다. 편집을 다시 할 때마다 같은 말로 자막을 새로 맞춘다.

**자막 오타를 잡을 때.** 자막을 만든 뒤 오탈자 사전으로 Whisper가 자주 틀리는 말을 고치고, 한 줄 20자 규칙에 맞춰 큐를 나눈다. 사전은 [references/korean-typo-glossary.md](skills/자막-검수/references/korean-typo-glossary.md)에 있고, 새 오인식이 나오면 직접 추가한다.

## 되는 것과 준비가 필요한 것

| ✅ 설치하면 바로 된다 | 🧩 준비하면 된다 |
|---|---|
| 프로젝트·시퀀스·클립 조회 | 전사와 컷 분석 (`pip install faster-whisper`, ffmpeg 설치) |
| 백업, 되돌리기, 저장 | 「컷편집 시작하자」「자막 검수 시작하자」로 부르기 (`npm run skills:install`) |
| 구간 삭제, 자르기, 클립 넣기 | Windows에서 사용 ([수동 설치](docs/INSTALL.md#macos--manual)) |
| 프레임·시퀀스 내보내기 | |

> **프리미어 Beta와 브릿지 패널이 반드시 필요하다.** 서버는 프리미어 안에서 도는 브릿지 패널을 거쳐 프리미어와 통신한다. 패널을 열고 시작하지 않으면 클라이언트에 "서버 연결됨"으로 떠도 모든 툴 호출이 실패한다. 정식 빌드에서도 패널은 열리지만 호출 결과가 돌아오지 않으므로 **Beta**를 쓴다.

## 구성

```
사용자 (자르기 전에 계획을 승인한다)
   │
AI 클라이언트      요청을 받아 분석하고, 계획을 보여 주고, 승인받은 뒤 툴을 실행한다
   │
MCP 서버 (node)    요청을 임시 폴더에 파일로 쓴다
   │
브릿지 패널        프리미어 안에서 요청을 읽어 실행하고 결과를 돌려준다
   │
프리미어 타임라인
```

| 구성 | 내용 |
|---|---|
| **MCP 프롬프트 2개** | `cut_edit_workflow`(컷편집), `caption_review_workflow`(자막). 스킬이 없는 클라이언트도 같은 절차로 실행한다 |
| **스킬 2개** | `프리미어-컷편집`, `자막-검수`. 실제 촬영본에서 잰 기준값과, 재편집 비용을 치르며 알게 된 실패 사례를 담았다 |
| **툴 26개** | 컷 계획·적용, 자막, 클립 배치, 안전장치, 화면 확인, 조회 |
| **브릿지 패널** | 프리미어 `Window > Extensions > MCP Bridge (CEP)` |

### 컷편집은 이렇게 진행된다

1. **`analyze_sequence_cuts`** 로 전사, 카테고리 분류, 정지 화면 검사를 한다. 읽기만 하고 타임라인은 바꾸지 않는다.
2. **사용자가 계획을 검토한다.** 카테고리마다 무엇이 잘리는지, 긴 공백이 정지 화면인지 시연인지 확인한다.
3. **`apply_sequence_cuts`** 로 백업 → 리플 삭제 → 재조회 검증을 한다.

툴 호출은 두 번이고, 확인 지점도 두 번이다(자르기 전 승인, 자른 뒤 검증).

### 자막은 이렇게 만든다

편집본을 다시 전사하지 않는다. `list_sequence_tracks` 는 클립마다 타임라인 위치와 원본 구간(in/out)을 함께 돌려준다. 이 두 값으로 원본의 어느 시점이 타임라인의 어느 시점으로 갔는지 알 수 있다. 처음 전사할 때 얻은 단어별 시간을 이 대응 관계에 맞춰 옮기면, 몇 번을 재편집해도 자막이 프레임 단위로 맞는다.

편집본을 다시 전사하면 시간이 더 걸리고, 그동안 고쳐 둔 용어가 다시 틀린 말로 돌아가거나 문장이 중간에서 잘린다. 그래서 이 서버는 다시 전사하지 않는다.

## 설치

**Adobe Premiere Pro (Beta)**, **Node 18 이상**, **Python과 faster-whisper**, **ffmpeg**가 필요하다.
Beta는 Creative Cloud의 「앱 → 베타 앱」에서 설치한다. 정식 빌드와 따로 설치되므로 기존 프로젝트에는 영향이 없다.

### macOS (추천)

```bash
git clone https://github.com/steveaimkt/wmbb-premiere-mcp
cd wmbb-premiere-mcp
npm run setup:mac
```

이 명령 하나가 빌드, 브릿지 패널 설치, 클로드 데스크톱 연결까지 한다. 끝나면 프리미어(Beta)에서 이렇게 한다.

1. 설치하는 동안 프리미어가 열려 있었다면 다시 시작한다
2. `Window > Extensions > MCP Bridge (CEP)` 를 연다
3. **Temp Directory** 를 `/tmp/premiere-mcp-bridge` 로 지정한다
4. **Save Configuration** → **Start Bridge** → **Test Connection**

Test Connection이 통과하면 AI 클라이언트를 다시 시작하고, 프리미어(Beta)에서 프로젝트를 연 뒤 「지금 프리미어 프로젝트 정보 알려줘」라고 입력한다.

### 클로드 코드

`npm run setup:mac` 을 마친 뒤 서버를 등록한다.

```bash
claude mcp add premiere-pro --env PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge \
  -- node /절대경로/wmbb-premiere-mcp/dist/index.js
```

### 스킬 (선택)

```bash
npm run skills:install
```

`~/.claude/skills/` 에 링크로 설치된다. 저장소를 `git pull` 하면 스킬도 함께 바뀐다. 설치한 뒤 클라이언트를 다시 시작하면 「컷편집 시작하자」「자막 검수 시작하자」로 부를 수 있다.

> **점검.** 연결이 안 되면 `npm run setup:doctor` 를 실행한다. 빌드, 브릿지 패널, 디버그 모드, 클라이언트 설정 중 무엇이 빠졌는지 알려 준다. Windows 설치, 클론 없이 npx로 실행하는 방법, 문제 해결 순서는 [docs/INSTALL.md](docs/INSTALL.md) 에 있다.

## 툴 26개

| 분류 | 툴 |
|---|---|
| 컷 · 계획 | `analyze_sequence_cuts` · `analyze_speech_edit_points` · `find_speech_spans` |
| 컷 · 적용 | `apply_sequence_cuts` · `apply_timeline_removals` · `razor_timeline_at_time` · `remove_from_timeline` · `trim_clip` |
| 자막 | `export_captions` · `proofread_transcript` · `read_sequence_captions` |
| 배치 | `insert_clip` |
| 안전장치 | `backup_sequence` · `restore_sequence_backup` · `duplicate_sequence` · `undo` · `save_project` |
| 확인 | `export_frame` · `export_sequence` |
| 조회 | `get_project_info` · `list_sequences` · `get_active_sequence` · `set_active_sequence` · `list_sequence_tracks` · `list_project_items` · `get_clip_properties` |

색보정, 트랜지션, 타이틀 같은 기능은 넣지 않았다.

## 성공 보고 대신 실측으로 판단한다

툴이 "성공했다"고 돌려준 값만으로는 실제로 잘렸는지 알 수 없다. 이 서버도 한때 `fullyApplied: true`, `inSync: true`, `shortfallSec: 0` 을 돌려주면서 타임라인에 27초짜리 빈 구간을 남겼다. 그 뒤로 타임라인을 바꾸는 툴은 결과를 스스로 다시 조회한다.

```jsonc
// apply_timeline_removals / insert_clip
{
  "fullyApplied": true,
  "verify": {                    // ← 타임라인에서 다시 조회한 값. 판단은 이 값으로 한다
    "measuredEndSec": 1279.667,
    "gapCount": 0,
    "contiguous": true,
    "avParity": true
  },
  "verified": true,
  "verifyProblems": null
}
```

빈 구간이나 오디오·비디오 불일치가 측정되면 `success` 가 `false` 로 바뀌고, `verifyProblems` 에 무엇이 잘못됐는지 나온다.
편집 중에는 `list_sequences` 의 길이 값이 갱신되지 않으므로, `list_sequence_tracks` 의 `verify.measuredEndSec` 을 쓴다.

컷 계산 로직은 실행할 때마다 자동으로 만든 전사 1000개 이상으로 검사한다(`npm run simulate`). 삭제 구간끼리 겹치지 않는지, 있는 것보다 많이 자르지 않는지, 따로 빼 둔 인트로·아웃트로·시연이 추천 컷에 섞이지 않는지, 재테이크를 지울 때 남길 테이크까지 지우지 않는지 확인한다. 과하게 자르는 버그 두 개를 이 검사로 찾아 고쳤다.

## 이것이 아닌 것

- **프리미어 전체를 조작하는 도구가 아니다.** 미디어 관리, 이펙트, 트랜지션, 타이틀, 렌더 큐는 컷편집을 믿을 수 있게 유지하려고 뺐다. 프리미어 전체를 조작하려면 [원본 프로젝트](https://github.com/hetpatel-11/Adobe_Premiere_Pro_MCP)를 쓴다.
- **사람을 빼는 도구가 아니다.** 자르기 전에 계획을 사용자가 승인해야 하고, 되돌리기(`undo`)는 여러 번 연속으로 믿을 수 없으므로 승인이 가장 확실한 안전장치다.
- **모든 촬영본에 맞춘 도구가 아니다.** 한 유튜브 채널이 실제로 쓰는 컷편집·자막 과정을 옮긴 것이다. 한국어 스킬은 그대로 쓰기보다 각자 촬영본에 맞게 고쳐 쓰는 예시로 보는 편이 맞다. 확인된 한계는 [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) 에 적었다.

## 출처

**[hetpatel-11/Adobe_Premiere_Pro_MCP](https://github.com/hetpatel-11/Adobe_Premiere_Pro_MCP)** 를 기반으로 만들었다. 프리미어와 실제로 통신하는 브릿지 패널과 MCP 서버는 그 프로젝트가 만들었고, 이 포크도 그 위에서 돈다.

이 포크에서 더한 것은 다음과 같다.

- 말한 내용을 기준으로 한 컷 탐지 (단어 간격 무음, 반복 테이크)
- 화면 시연을 공백으로 착각하지 않게 하는 정지 화면 검사
- 인트로 후킹·아웃트로·긴 시연을 따로 빼 두는 카테고리형 제안
- 성공 보고 대신 타임라인을 다시 조회하는 편집 툴
- 편집본을 다시 전사하지 않고 자막을 만드는 원본→타임라인 대응
- 기준값과 실패 사례를 담은 스킬 2개

## 더 보기

- **[docs/INSTALL.md](docs/INSTALL.md)** 수동 설치, Windows, npx 실행, 문제 해결
- **[skills/README.md](skills/README.md)** 스킬 2개의 설치와 편집 규칙
- **[docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md)** 확인된 한계와 고친 결함
- **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** 서버를 고치고 검사를 돌리는 방법

---

<p align="center">
  <sub><a href="https://github.com/steveaimkt">WMBB</a> 한성국이 만들었다 · 마케팅 트루먼쇼 채널의 컷편집·자막 워크플로</sub><br>
  <sub>MIT, © 2025-2026 hetpatel-11 · <a href="LICENSE.md">LICENSE</a></sub>
</p>
