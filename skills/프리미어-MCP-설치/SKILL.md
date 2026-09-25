---
name: 프리미어-MCP-설치
description: WMBB 프리미어 MCP(wmbb-premiere-mcp)를 처음부터 하나씩 설치한다. 준비물 점검 → 저장소 클론·빌드·브릿지 패널 설치 → 프리미어(Beta)에서 브릿지 켜기 → AI 클라이언트 등록 → 컷편집·자막 스킬 설치 → 연결 확인. 단계마다 결과를 보여 주고 사용자가 "다음"이라고 하면 넘어간다. "프리미어 MCP 설치하자", "프리미어 MCP 설치해줘", "wmbb-premiere-mcp 설치", "이 저장소 설치하자"(저장소 폴더 안에서), "프리미어 MCP 설치 점검", "프리미어 연결이 안 돼" 요청 시 사용. 설치 뒤 컷편집은 `프리미어-컷편집`, 자막은 `자막-검수` 스킬.
---

# 프리미어 MCP 설치

**사용자는 개발자가 아닐 수 있다.** 명령어를 설명 없이 늘어놓지 않는다. 단계마다 ① 지금 무엇을 하는지 한 줄 ② 실행 ③ 결과를 ✅/❌로 보여 주고, **"다음"이라고 하면 넘어간다.**

시스템에 무언가를 새로 설치하는 명령(`brew install`, `pip install`)은 **실행 전에 무엇을 설치하는지 말하고 승인을 받는다.**

진행 순서:

```
STEP 0  준비물 점검          (읽기만 한다)
STEP 1  저장소 받기·설치      npm run setup:mac
STEP 2  프리미어에서 브릿지 켜기  ← 사용자가 프리미어에서 직접 한다
STEP 3  AI 클라이언트 등록
STEP 4  컷편집·자막 스킬 설치
STEP 5  다시 시작하고 연결 확인
```

「설치 점검」「연결이 안 돼」로 불렸으면 STEP 0 → `npm run setup:doctor` → STEP 5의 문제 해결 표로 바로 간다.

---

## STEP 0 — 준비물 점검

아래를 **한 번에** 확인하고 표로 보여 준다. 이 단계에서는 아무것도 설치하지 않는다.

```bash
uname -s                                             # Darwin 이어야 한다
node -v                                              # v18 이상
python3 --version
python3 -c "import faster_whisper; print('ok')"      # 전사에 필요
ffmpeg -version | head -1                            # 정지 화면 검사에 필요
ls -d "/Applications/Adobe Premiere Pro (Beta)"      # 프리미어 Beta
command -v brew                                      # 없는 것을 설치할 때 쓴다
```

| 항목 | 없을 때 |
|---|---|
| macOS가 아니다 | **멈춘다.** 자동 설치는 macOS 전용이다. Windows는 `docs/INSTALL.md` 의 수동 설치를 안내하고 끝낸다 |
| Node 18 미만 / 없음 | 승인받고 `brew install node` |
| ffmpeg 없음 | 승인받고 `brew install ffmpeg` |
| brew 없음 | 직접 설치하지 않는다. https://brew.sh 의 설치 명령을 보여 주고, 사용자가 설치한 뒤 "다음"이라고 하면 다시 점검한다 |
| faster-whisper 없음 | STEP 1 끝에서 설치한다 (저장소 폴더가 있어야 가상환경을 만들 수 있다) |
| 프리미어 Beta 없음 | Creative Cloud 앱 → **앱 → 베타 앱** → Premiere Pro (Beta) 설치를 안내한다. 정식 빌드와 따로 설치되고 기존 프로젝트에 영향이 없다고 알려 준다. **정식 빌드에서는 호출 결과가 돌아오지 않으므로** Beta 없이는 STEP 2로 넘어가지 않는다 |

---

## STEP 1 — 저장소 받기·설치

**이미 클론돼 있으면 클론을 건너뛰고 그 폴더로 간다.** 지금 폴더가 저장소이거나(`package.json` 의 `name` 이 `wmbb-premiere-mcp`), README의 붙여넣기 문장으로 방금 클론한 경우다(기본 위치 `~/dev/wmbb-premiere-mcp`).

아니면 설치할 위치를 묻는다. 기본값은 `~/dev/wmbb-premiere-mcp`.
iCloud 폴더(`~/Library/Mobile Documents/...`, 데스크톱·문서가 iCloud에 동기화되는 경우 포함)는 피하라고 권한다. `node_modules` 수만 개가 동기화되며 느려지고 파일이 사라지는 경우가 있다.

```bash
git clone https://github.com/steveaimkt/wmbb-premiere-mcp "<설치 위치>"
cd "<설치 위치>"
npm run setup:mac
```

`setup:mac` 이 하는 일을 사용자에게 한 줄씩 알려 준다:
의존성 설치·빌드 → Adobe CEP 디버그 모드 켜기 → 브릿지 패널 복사 → 임시 폴더 `/tmp/premiere-mcp-bridge` 생성 → 클로드 데스크톱 설정에 `premiere-pro` 등록.

끝나면 **저장소의 절대 경로를 기억해 둔다** (`pwd`). STEP 3에서 쓴다.

### faster-whisper 설치 (STEP 0에서 없었을 때만)

승인받은 뒤 먼저 시스템 Python에 시도한다.

```bash
python3 -m pip install --user faster-whisper
```

`externally-managed-environment` 오류가 나면(Homebrew Python에서 흔하다) 저장소 안에 가상환경을 만든다.

```bash
python3 -m venv .venv
.venv/bin/pip install faster-whisper
```

이 경우 서버가 이 Python을 쓰도록 **STEP 3의 등록 명령에 `PYTHON_PATH=<저장소>/.venv/bin/python` 을 추가해야 한다.** 잊지 않도록 사용자에게도 알려 둔다.

확인: `<쓸 python> -c "import faster_whisper; print('ok')"`

---

## STEP 2 — 프리미어에서 브릿지 켜기

**이 단계는 사용자가 프리미어에서 직접 한다.** 아래를 그대로 보여 주고 기다린다.

```
1. 프리미어가 열려 있으면 완전히 종료한 뒤 **Premiere Pro (Beta)** 를 연다 (정식 빌드 ❌)
2. 아무 프로젝트나 연다
3. 메뉴 Window > Extensions > MCP Bridge (CEP)
4. Temp Directory 칸에  /tmp/premiere-mcp-bridge
5. Save Configuration → Start Bridge → Test Connection
```

사용자에게 Test Connection 결과를 묻는다.

| 사용자 답 | 할 일 |
|---|---|
| 통과 | STEP 3 |
| 메뉴에 MCP Bridge가 없다 | 프리미어 환경설정 → **UXP Plugins → Enable developer mode** 를 켜고 프리미어를 다시 시작하라고 안내한다. 그래도 없으면 `npm run setup:doctor` 로 CEP 디버그 모드와 패널 폴더를 확인한다 |
| 실패 | Temp Directory 철자를 다시 확인하게 하고, 패널의 **Run Diagnostics** 를 누른 뒤 `/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json` 을 읽어 원인을 설명한다 |

**패널은 프리미어를 켤 때마다 Start Bridge를 다시 눌러야 한다**고 알려 둔다. 나중에 "연결됨으로 뜨는데 안 된다"의 가장 흔한 원인이다.

---

## STEP 3 — AI 클라이언트 등록

어떤 클라이언트를 쓰는지 묻는다(여럿 가능). 지금 이 대화가 클로드 코드라면 클로드 코드는 기본으로 포함한다.

| 클라이언트 | 할 일 |
|---|---|
| **클로드 데스크톱** | STEP 1에서 이미 등록됐다. 추가 작업 없음 |
| **클로드 코드** | 아래 명령을 실행한다 |
| **Codex** | 아래 명령을 실행한다 (반드시 한 줄) |
| 그 밖의 MCP 클라이언트 | README의 JSON 설정을 보여 주고 경로를 채워 준다 |

`<저장소>` 는 STEP 1의 절대 경로로 바꿔서 실행한다. 사용자에게 경로를 직접 입력하게 하지 않는다.

```bash
# 클로드 코드 — 모든 폴더에서 쓰도록 user 범위로 등록
claude mcp add premiere-pro --scope user \
  --env PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge \
  -- node "<저장소>/dist/index.js"

# Codex
codex mcp add premiere_pro --env PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge -- node "<저장소>/dist/index.js"
```

STEP 1에서 가상환경을 만들었으면 두 명령 모두에 `--env PYTHON_PATH=<저장소>/.venv/bin/python` 을 더한다. 클로드 데스크톱은 설정 파일(`~/Library/Application Support/Claude/claude_desktop_config.json`)의 `mcpServers.premiere-pro.env` 에 같은 값을 넣는다.

이미 `premiere-pro` 가 등록돼 있다는 오류가 나면, 기존 등록이 가리키는 경로를 보여 주고 바꿀지 묻는다(`claude mcp remove premiere-pro --scope user` 후 다시 등록).

---

## STEP 4 — 컷편집·자막 스킬 설치

```bash
npm run skills:install
```

`~/.claude/skills/` 에 링크로 설치된다: `프리미어-컷편집`, `자막-검수`, 그리고 이 설치 스킬. 저장소를 `git pull` 하면 스킬도 함께 바뀐다.

| 결과 | 할 일 |
|---|---|
| `linked` 3개 | STEP 5 |
| `! ... already exists as a real directory` | 같은 이름의 폴더가 이미 있다. 무엇이 들어 있는지 보여 주고, 백업 폴더로 옮긴 뒤 다시 설치할지 묻는다. 묻지 않고 지우지 않는다 |

사용자에게 알려 둔다:
- 스킬은 **클로드 코드**에서 「컷편집 시작하자」「자막 검수 시작하자」로 부른다.
- 스킬을 읽지 않는 클라이언트에서는 MCP 프롬프트 `cut_edit_workflow`, `caption_review_workflow` 로 같은 절차를 실행한다.

---

## STEP 5 — 다시 시작하고 연결 확인

```bash
npm run setup:doctor
```

`[missing]` 이 있으면 무엇이 빠졌는지 설명한다. 클로드 데스크톱을 쓰지 않는 사용자에게는 **"Claude Desktop config" 항목의 missing은 무시해도 된다**고 알려 준다.

그다음 사용자에게 안내하고 이 스킬을 끝낸다. **MCP 서버는 클라이언트를 다시 시작해야 잡히므로 이 대화에서는 확인할 수 없다.**

```
1. AI 클라이언트(클로드 코드·데스크톱)를 완전히 종료하고 다시 연다
2. 프리미어(Beta)에서 프로젝트를 열고, 브릿지 패널이 Start 상태인지 본다
3. 새 대화에서 입력한다:  지금 프리미어 프로젝트 정보 알려줘
4. 프로젝트 이름과 시퀀스 목록이 나오면 설치 끝
5. 이제 「컷편집 시작하자」 또는 「자막 검수 시작하자」
```

### 설치 뒤에 연결이 안 될 때

| 증상 | 확인할 것 |
|---|---|
| 서버가 연결됐다고 뜨는데 툴 호출이 전부 실패 | 프리미어 **Beta** 인가 · 프로젝트가 열려 있나 · 패널에서 **Start Bridge** 를 눌렀나 |
| 시간 초과 | 패널 Temp Directory와 등록한 `PREMIERE_TEMP_DIR` 가 둘 다 `/tmp/premiere-mcp-bridge` 인가 |
| 저장소를 업데이트한 뒤부터 이상하다 | `npm run build` 후 패널 오른쪽 클릭 → **Reload** |
| 전사 툴만 실패 | faster-whisper가 설치된 Python을 서버가 쓰고 있나 (`PYTHON_PATH`) |
| 서버가 목록에 없다 | 클라이언트를 완전히 다시 시작했나 · `claude mcp list` 에 `premiere-pro` 가 있나 |

지울 때는 `npm run uninstall:mac`. 패널과 클로드 데스크톱 등록을 지운다(CEP 디버그 모드는 다른 Adobe 확장이 쓸 수 있어 남긴다).
