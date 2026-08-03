#!/usr/bin/env bash
#
# Install the repo's agent skills into ~/.claude/skills/.
#
# Symlinks by default so the repo stays the single source of truth — editing a
# skill here or there is the same file, and `git pull` updates both. Pass --copy
# if your client does not follow symlinks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$REPO_ROOT/skills"
DEST_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

MODE="link"
for arg in "$@"; do
  case "$arg" in
    --copy) MODE="copy" ;;
    --link) MODE="link" ;;
    -h|--help)
      echo "usage: $(basename "$0") [--link|--copy]"
      echo "  --link  symlink into $DEST_DIR (default)"
      echo "  --copy  copy instead, for clients that do not follow symlinks"
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

mkdir -p "$DEST_DIR"

installed=0
for skill_path in "$SRC_DIR"/*/; do
  [[ -f "$skill_path/SKILL.md" ]] || continue
  name="$(basename "$skill_path")"
  target="$DEST_DIR/$name"

  # Refuse to clobber a real directory that is not ours — it may be hand-written.
  if [[ -e "$target" && ! -L "$target" ]]; then
    if [[ "$MODE" == "link" ]]; then
      echo "  ! $name already exists as a real directory in $DEST_DIR"
      echo "    move or delete it first, or re-run with --copy to overwrite"
      continue
    fi
  fi

  rm -rf "$target"
  if [[ "$MODE" == "link" ]]; then
    ln -sfn "${skill_path%/}" "$target"
    echo "  linked  $name"
  else
    cp -R "${skill_path%/}" "$target"
    echo "  copied  $name"
  fi
  installed=$((installed + 1))
done

if [[ "$installed" -eq 0 ]]; then
  echo "No skills installed."
  exit 1
fi

echo
echo "$installed skill(s) installed to $DEST_DIR"
echo "Restart your client, then try: \"컷편집 시작하자\" or \"자막 검수 시작하자\""
