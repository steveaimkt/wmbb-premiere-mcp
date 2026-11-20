#!/bin/zsh
# Anthropic 키를 클립보드에서 읽어 맥 키체인에 저장하고 데몬을 다시 켠다. 키는 화면·파일·로그에 남지 않는다.
echo "1) Claude Console에서 키(sk-ant-...)를 복사하세요."
read -rs '?2) 복사했으면 Enter: '
echo
K="$(pbpaste | tr -d '[:space:]')"
if [[ "$K" != sk-ant-* ]]; then echo "클립보드에 sk-ant- 로 시작하는 키가 없습니다. 복사한 뒤 다시 실행하세요."; exit 1; fi
security add-generic-password -U -s wmbb-voice-orders -a anthropic -w "$K" && unset K
print -n "" | pbcopy
launchctl kickstart -k "gui/$(id -u)/com.wmbb.voice-orders.daemon"
sleep 4
grep -q "API key from keychain" "$HOME/Library/Logs/wmbb-voice-orders.log" && echo "저장 완료 — 데몬이 키체인 키로 다시 켜졌습니다." || echo "저장했지만 데몬 로그에서 확인이 안 됩니다: ~/Library/Logs/wmbb-voice-orders.log"
