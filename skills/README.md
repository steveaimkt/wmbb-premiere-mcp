# Skills

Two agent skills, one per capability. They are the operator's side of the server:
the MCP prompts tell a client *what* the workflow is, these carry the accumulated
judgement about *how it goes wrong* — thresholds measured on real footage, failure
modes that cost a re-edit, and the checks that catch them.

| Skill | Trigger | MCP prompt |
|---|---|---|
| `프리미어-컷편집` | "컷편집 시작하자" | `cut_edit_workflow` |
| `자막-검수` | "자막 검수 시작하자" | `caption_review_workflow` |

They are independent. Captioning runs on a timeline cut by hand in Premiere with no
cut session in front of it — and in practice it runs far more often, because every
re-edit needs new captions.

## Install

```bash
npm run skills:install
```

Symlinks both into `~/.claude/skills/`, so the repo stays the single source of truth
and `git pull` updates them.

To copy instead of link (if your client does not follow symlinks):

```bash
npm run skills:install -- --copy
```

Verify with `/skills` or by asking "컷편집 시작하자".

## Editing

Edit them **here**, not in `~/.claude/skills/`. With the symlink install both paths
are the same file; with `--copy` you must re-run the install to push changes.

What earns a place in these files: something measured, or something that already
went wrong once. A threshold with the footage it came from. A failure mode with the
symptom that reveals it. Not restatements of what the tool descriptions already say.

## Language

Korean. They encode a specific channel's editing conventions (cue length, caption
style, review checklist), so they are written for that operator rather than
generalised. Treat them as a worked example if you are adapting to another workflow.
