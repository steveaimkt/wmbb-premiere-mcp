#!/bin/zsh
# swift build → VoiceHotkey.app (메뉴바 앱, 마이크 권한 문구 포함) → 임시 서명
set -e
cd "${0:A:h}"
swift build -c release
APP=build/VoiceHotkey.app
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
cp .build/release/VoiceHotkey "$APP/Contents/MacOS/VoiceHotkey"
cp Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - --identifier com.wmbb.voicehotkey "$APP"
echo "built $PWD/$APP"
