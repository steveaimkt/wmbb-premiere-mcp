#!/bin/bash
# 음성 지시 설치: 빌드 → 프리미어 패널 복사 → 단축키 앱 빌드 → launchd 등록(로그인하면 자동 실행).
# API 키는 묻지 않는다. 키체인에 없으면 넣는 방법만 알려 준다.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
UID_N="$(id -u)"
LA="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs"
EXT="$HOME/Library/Application Support/Adobe/CEP/extensions/MCPBridgeCEP"
NODE="$(command -v node)"
PY="${PYTHON_PATH:-$HOME/.local/share/premiere-dub-edit/venv/bin/python}"
TEMP_DIR="${PREMIERE_TEMP_DIR:-/tmp/premiere-mcp-bridge}"
DAEMON=com.wmbb.voice-orders.daemon
HOTKEY=com.wmbb.voice-orders.hotkey
APP="$REPO/helpers/VoiceHotkey/build/VoiceHotkey.app"

step() { printf '\n▶ %s\n' "$1"; }

step "1/5 빌드"
cd "$REPO" && npm run build --silent
"$REPO/helpers/VoiceHotkey/build-app.sh" >/dev/null && echo "  단축키 앱: $APP"

step "2/5 프리미어 패널 복사 (프리미어를 다시 켜야 반영)"
mkdir -p "$EXT/CSXS"
cp "$REPO/cep-plugin/CSXS/manifest.xml" "$EXT/CSXS/manifest.xml"
cp "$REPO/cep-plugin/"{index.html,bridge-cep.js,CSInterface.js,voice-orders.html,voice-orders.js} "$EXT/"
echo "  $EXT"

step "3/5 받아쓰기 파이썬 확인"
if "$PY" -c "import faster_whisper" 2>/dev/null; then echo "  OK $PY"; else echo "  ⚠ $PY 에 faster_whisper가 없습니다. PYTHON_PATH=<venv python> 으로 다시 실행하세요."; fi

step "4/5 자동 실행 등록 (launchd)"
# 손으로 띄운 것들은 내린다(포트 47613/47614 충돌 방지)
pkill -f "dist/voiceOrders/main.js" 2>/dev/null || true
pkill -f "VoiceHotkey.app/Contents/MacOS/VoiceHotkey" 2>/dev/null || true
mkdir -p "$LA" "$LOGS"
cat > "$LA/$DAEMON.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$DAEMON</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/dist/voiceOrders/main.js</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict>
    <key>PYTHON_PATH</key><string>$PY</string>
    <key>PREMIERE_TEMP_DIR</key><string>$TEMP_DIR</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/wmbb-voice-orders.log</string>
  <key>StandardErrorPath</key><string>$LOGS/wmbb-voice-orders.log</string>
</dict></plist>
EOF
cat > "$LA/$HOTKEY.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$HOTKEY</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/VoiceHotkey</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/wmbb-voice-hotkey.log</string>
  <key>StandardErrorPath</key><string>$LOGS/wmbb-voice-hotkey.log</string>
</dict></plist>
EOF
for L in $DAEMON $HOTKEY; do
  launchctl bootout "gui/$UID_N/$L" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_N" "$LA/$L.plist"
done
sleep 3
for L in $DAEMON $HOTKEY; do
  printf '  %-34s %s\n' "$L" "$(launchctl print "gui/$UID_N/$L" 2>/dev/null | awk -F'= ' '/^\tstate/{print $2; exit}')"
done

step "5/5 API 키"
if security find-generic-password -s wmbb-voice-orders >/dev/null 2>&1; then
  echo "  키체인에 키가 있습니다."
else
  echo "  키체인에 Anthropic 키가 없습니다. 아래를 실행하고 키를 붙여넣은 뒤(화면에 안 보임) Enter:"
  echo "    security add-generic-password -U -s wmbb-voice-orders -a anthropic -w"
  echo "  그다음 데몬 재시작: launchctl kickstart -k gui/$UID_N/$DAEMON"
fi
printf '\n완료. 로그: %s/wmbb-voice-orders.log\n' "$LOGS"
echo "단축키 앱을 새로 빌드했으면 손쉬운 사용 권한을 다시 켜야 할 수 있습니다(시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용)."
