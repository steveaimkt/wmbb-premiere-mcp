# WMBB Premiere Cut MCP

**Cut your Premiere Pro timeline by talking to Claude — silences and repeated takes gone in one review, hooks and live demos never touched.**

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

It does **one thing**: cut editing. 25 focused tools, no color/transitions/titles bloat.

---

## Install

Requires: **Adobe Premiere Pro (Beta)** with the MCP bridge panel, **Node 18+**, and **Python + faster-whisper** (`pip install faster-whisper`) and **ffmpeg** on PATH.

**Option A — run straight from GitHub (no clone):**

```json
{
  "mcpServers": {
    "premiere-cut": {
      "command": "npx",
      "args": ["-y", "github:steveaimkt/Adobe_Premiere_Pro_MCP"]
    }
  }
}
```

**Option B — clone and run locally:**

```bash
git clone https://github.com/steveaimkt/Adobe_Premiere_Pro_MCP
cd Adobe_Premiere_Pro_MCP
npm install && npm run build
```

```json
{
  "mcpServers": {
    "premiere-cut": {
      "command": "node",
      "args": ["/absolute/path/to/Adobe_Premiere_Pro_MCP/dist/index.js"]
    }
  }
}
```

Open Premiere (Beta), open the MCP bridge panel, set its temp directory, and click **Start Bridge**.

---

## Use it

Just ask, or invoke the built-in prompt **`cut_edit_workflow`**:

> "Cut the silences and repeated takes from my active sequence."

The flow, every time:

1. **`analyze_sequence_cuts`** — transcribe + categorize + freeze-check the screen. Read-only.
2. **You review** the plan: what gets cut per category, and for each long gap, static (dead air) or active (demo).
3. **`apply_sequence_cuts`** — backup → ripple-delete → **verify by re-query**.

Two calls, two gates (approve before, verify after). That's the whole thing.

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

## The tools (25, cut-edit only)

**Plan:** `analyze_sequence_cuts` · `analyze_speech_edit_points` · `proofread_transcript` · `export_captions` · `read_sequence_captions` · `find_speech_spans`
**Cut:** `apply_sequence_cuts` · `apply_timeline_removals` · `razor_timeline_at_time` · `remove_from_timeline` · `trim_clip`
**Safety:** `backup_sequence` · `restore_sequence_backup` · `duplicate_sequence` · `undo` · `save_project`
**Look:** `export_frame` · `export_sequence`
**Discovery:** `get_project_info` · `list_sequences` · `get_active_sequence` · `set_active_sequence` · `list_sequence_tracks` · `list_project_items` · `get_clip_properties`

---

## Trust, engineered

The cut logic is fuzzed against **1000+ generated transcripts per run** (`npm run simulate`) that assert the invariants a cut must never break — spans never overlap, more is never cut than exists, the held-back intro/outro/demos never leak into the recommended cut, a retake's removal never eats the take it keeps. Two real over-cut bugs were found and fixed this way. It edits your footage; it earns the trust first.

---

## License

See [LICENSE.md](LICENSE.md). Built on the Adobe Premiere Pro MCP foundation; refocused as a cut-editing specialist.
