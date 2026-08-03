# WMBB Premiere MCP

**Cut your Premiere Pro timeline by talking to Claude, then caption the result without transcribing it again.**

Point it at a sequence. It transcribes the speech, finds the dead air and the flubbed retakes, *looks at the screen* to tell a live demo from a frozen one, and shows you a categorized plan. You approve. It cuts — backed up, A/V in sync, and verified by re-reading the timeline, not by trusting itself.

> 2 hours of scrubbing for silences and bad takes → one reviewed pass.

<!-- ▶️ DEMO: record a 20-second screen capture — a spoken command, the proposal table, the cut landing — and drop it here. This is the single biggest thing you can do for stars. -->
<p align="center"><em>(demo GIF goes here)</em></p>

---

## Why this one

Every silence cutter dies the same way: it makes a cut you don't trust. `auto-editor` over- and under-cuts on a real noise floor. `jumpcutter` was abandoned. Transcript tools mis-align. So the whole design here is built around **one promise — never a wrong cut**:

- 🎯 **Categorized, never a flat list.** Duplicates and pauses are recommended; the intro hook, the outro, and long on-screen demos are held back for you to decide. A hook can't get swept into a bulk "remove silence."
- 👁️ **It watches the screen.** Every long silent gap is run through freeze detection — a frozen screen is dead air (safe to cut), a changing screen is a live demo (kept). No more deleting the part where you're actually showing something.
- 🗣️ **Cuts by what was said.** Whisper word-level transcript finds real silences (gaps between words, not amplitude — which is useless on room tone) and repeated takes, including the "flub → long reset → clean retake" and whole re-recorded paragraphs.
- 🔁 **Reversible and verified.** Every cut backs up the sequence first, ripple-deletes A/V linked so they never desync, then re-queries the timeline and reports measured length vs expected. `success: true` is never mistaken for "it worked."
- ✂️ **Inside Premiere.** No export/import round-trip, no re-encode — it edits your real timeline.

It does **two things** — cut, and caption the cut. 26 focused tools, no color/transitions/titles bloat.

---

## Install

Requires **Adobe Premiere Pro (Beta)**, **Node 18+**, **Python + faster-whisper**
(`pip install faster-whisper`) and **ffmpeg** on PATH.

```bash
git clone https://github.com/steveaimkt/wmbb-premiere-mcp
cd wmbb-premiere-mcp
npm run setup:mac
```

Then in Premiere (Beta): `Window > Extensions > MCP Bridge (CEP)` → set Temp Directory to
`/tmp/premiere-mcp-bridge` → **Save Configuration** → **Start Bridge** → **Test Connection**.

> **The bridge panel is not optional.** The server talks to Premiere through a CEP panel
> running inside the app; if it is not open and started, every tool call fails even though
> your client shows the server as connected. And use the **Beta** build — the panel loads in
> release, but calls do not come back there.

Manual install, Windows, npx-without-cloning, and troubleshooting:
**[docs/INSTALL.md](docs/INSTALL.md)**

Both workflows also ship as agent skills — `npm run skills:install`. See **[skills/](skills/README.md)**.

---

## Two things, two prompts

The server does exactly two jobs, and ships one prompt for each.

### 1. `cut_edit_workflow` — cut the timeline

> "Cut the silences and repeated takes from my active sequence."

1. **`analyze_sequence_cuts`** — transcribe + categorize + freeze-check the screen. Read-only.
2. **You review** the plan: what gets cut per category, and for each long gap, static (dead air) or active (demo).
3. **`apply_sequence_cuts`** — backup → ripple-delete → **verify by re-query**.

Two calls, two gates (approve before, verify after).

### 2. `caption_review_workflow` — caption the edit

> "Make subtitles for the sequence as it is now."

**It does not transcribe the cut.** `list_sequence_tracks` returns each clip's source
in/out beside its timeline position — that pairing *is* the source→timeline map. The
word timestamps you already have get re-projected through it, so the captions are
frame-accurate after any number of re-edits and cost nothing extra.

It works on a timeline you cut by hand in Premiere. No cut-edit session required in front of it.

Re-transcribing an edit is the obvious approach and it is worse in every measurable way:
slower, and it destroys the corrections you accumulated (a fixed term reverting to
nonsense, sentences truncated mid-clause). So the server refuses to do it that way.

---

## vs the alternatives

| | this MCP | auto-editor | lossless-cut | Descript |
|---|---|---|---|---|
| Edits your real Premiere timeline | ✅ | export XML | ❌ separate app | ❌ separate app |
| Silence detection robust to room tone | ✅ word-gap | ⚠️ amplitude | manual | ✅ |
| Repeated-take / paragraph-retake removal | ✅ | ❌ | ❌ | ⚠️ |
| Protects live on-screen demos | ✅ freeze check | ❌ | n/a | ❌ |
| Reviewed plan before cutting | ✅ | ❌ one-shot | manual | ✅ |
| Backup + re-queried verification | ✅ | n/a | lossless | n/a |
| Driven from your AI client | ✅ | CLI | GUI | app |

---

## The tools (26)

**Cut · plan:** `analyze_sequence_cuts` · `analyze_speech_edit_points` · `find_speech_spans`
**Cut · apply:** `apply_sequence_cuts` · `apply_timeline_removals` · `razor_timeline_at_time` · `remove_from_timeline` · `trim_clip`
**Caption:** `export_captions` · `proofread_transcript` · `read_sequence_captions`
**Place:** `insert_clip`
**Safety:** `backup_sequence` · `restore_sequence_backup` · `duplicate_sequence` · `undo` · `save_project`
**Look:** `export_frame` · `export_sequence`
**Discovery:** `get_project_info` · `list_sequences` · `get_active_sequence` · `set_active_sequence` · `list_sequence_tracks` · `list_project_items` · `get_clip_properties`

---

## Measured, not reported

A cut tool that says it worked is not evidence it worked. This one came back
`fullyApplied: true`, `inSync: true`, `shortfallSec: 0` while leaving a 27-second
hole in the timeline. So the change tools now check themselves:

```jsonc
// apply_timeline_removals / insert_clip
{
  "fullyApplied": true,
  "verify": {                    // ← re-queried from the timeline, judge from this
    "measuredEndSec": 1279.667,
    "gapCount": 0,
    "contiguous": true,
    "avParity": true
  },
  "verified": true,
  "verifyProblems": null
}
```

If a gap or an A/V mismatch is measured, `success` drops to `false` and
`verifyProblems` says what is wrong. `list_sequences`.duration reports a stale value
mid-edit — use `list_sequence_tracks` → `verify.measuredEndSec` instead.

## Trust, engineered

The cut logic is fuzzed against **1000+ generated transcripts per run** (`npm run simulate`) that assert the invariants a cut must never break — spans never overlap, more is never cut than exists, the held-back intro/outro/demos never leak into the recommended cut, a retake's removal never eats the take it keeps. Two real over-cut bugs were found and fixed this way. It edits your footage; it earns the trust first.

---

## Docs

[Install](docs/INSTALL.md) · [Skills](skills/README.md) · [Known issues](docs/KNOWN_ISSUES.md) · [Contributing](docs/CONTRIBUTING.md)

---

## Credits

Built on **[hetpatel-11/Adobe_Premiere_Pro_MCP](https://github.com/hetpatel-11/Adobe_Premiere_Pro_MCP)**.
That project wrote the CEP bridge and the MCP server that actually talk to Premiere —
the hard part, and the part this still runs on. None of this exists without it.

What this fork is: **one editor's workflow, built on top of that.** A YouTube channel's
own cut-and-caption process, encoded as skills and prompts, with the server shaped
around it. Everything here came from editing real footage and hitting real problems:

- speech-based cut detection — word-gap silences and repeated takes, not amplitude
- freeze checking, so a live on-screen demo is never mistaken for dead air
- categorized proposals that hold back the intro hook, the outro and long demos
- mutations that re-query the timeline instead of trusting their own success report
- a source→timeline map, so an edit can be re-captioned without transcribing it again
- two agent skills carrying the thresholds and failure modes that cost real re-edits

The general-purpose surface (media management, effects, transitions, titles, render
queue) was pruned to keep the cut path trustworthy. **If you want full Premiere
control, use the upstream project** — it does more, and it is the foundation here.
Take this one if a reviewed cut and frame-accurate captions are what you are after,
and treat the Korean skills as a worked example to adapt rather than a general answer.

## License

MIT, © 2025-2026 hetpatel-11. See [LICENSE.md](LICENSE.md).
