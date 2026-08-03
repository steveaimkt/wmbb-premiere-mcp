# Known Issues

Current, confirmed limits. Not a backlog of already-fixed prototype bugs.

## Current State (August 3, 2026)

The catalog is a cut-edit specialist set (~26 tools). Anything you read below was
observed in a real editing session, not inferred.

---

## Fixed in 2026-08-03

These were live defects; they are listed so the symptom is searchable.

| Symptom | Cause | Fix |
|---|---|---|
| `export_captions(importToSequence)` always returned `Illegal Parameter type`, caption track never created | `createCaptionTrack` was called with start time as **seconds (number)** and format as a **name (string)**; the API wants **ticks (string)** and an **integer** format constant | ticks + integer constant, with a 3-form signature fallback |
| A ripple delete reported `fullyApplied: true`, `inSync: true`, `shortfallSec: 0` while leaving a **27-second hole** in the timeline and removing ~30s of the wrong content | change tools trusted their own summary; nothing re-queried the timeline | `apply_timeline_removals` / `insert_clip` now re-query and attach `verify`; `success` drops to `false` when a gap or A/V mismatch is measured |
| Rebuilding captions for an edited timeline needed one `get_clip_properties` call per clip (15+ per pass) | `list_sequence_tracks` returned timeline positions but not source in/out | `includeSourceTimes` (default on) — one call is now the full source→timeline map |
| `list_sequence_tracks` blew the token budget on long timelines | whole clip list always returned | `compact: true` returns `verify` + first/last clip per track |
| No way to place a clip — cold opens and restored sections had to be done by hand | server had removal/razor/trim only | `insert_clip` (insert with ripple, or overwrite) |

---

## Confirmed Limitations

### `list_sequences`.duration is not authoritative

Mid-edit it returns a stale or transient value. Observed in one session:
`1352.75` → `1310.21` → `1279.67` for the same sequence within minutes, while the
clip list said something else again.

**Use `list_sequence_tracks` → `verify.measuredEndSec`.** `verify.durationMatchesClips`
tells you whether the reported duration currently agrees with the clips.

### `undo` only walks back about two operations

Further calls return `success: true` and do nothing. It is not a safety net.
Premiere's own `Cmd+Z` history is deeper and more reliable — when an edit goes wrong,
tell the user to undo in the app.

Approval before deletion remains the only real defense.

### `trim_clip` is shrink-only

A trimmed head cannot be restored through the API. Do not trim heads/tails you may
want back; use `insert_clip` to put material back from the source instead.

### No clip speed control

There is no tool to change clip speed, so a demo section cannot be sped up through
the server. Report the spans and a suggested rate and let the user apply it.

### `move_clip` has no ripple

Moving one clip leaves a gap that shifts to the wrong place and produces a black
flash. Do not use it to remove a leading gap or shift a whole timeline.

### Leading empty space (a "leader") cannot be rippled away

If the first clip starts at, say, 1.8s, `apply_timeline_removals` on `[0, X]` removes
only the clip portion; the leader stays and is reported through `shortfallSec`.
Handle it by setting the render/export start point at the first frame of content.

### `get_render_queue_status` needs Adobe Media Encoder

Without AME integration the server returns a truthful failure rather than fake success.

---

## Test Suite Debt

`npm test` currently runs **8 of 10 suites (102 tests, all passing)**. Two suites —
including `src/__tests__/tools/index.test.ts`, which covers the largest file in the
repo — fail to load and are silently skipped:

```
SyntaxError: Cannot use 'import.meta' outside a module
  src/utils/whisperRunner.ts:24
```

Running with the ESM flag loads them but exposes further breakage:

```
NODE_OPTIONS=--experimental-vm-modules npx jest
→ 5 failed / 5 passed suites, 16 failed tests
```

Two separate causes:

1. **`jest.mock` does not work under ESM** — the bridge-mocking suites
   (`tools`, `bridge`, `resources`, `integration`) need `jest.unstable_mockModule`
   plus dynamic import.
2. **`logger.test.ts` console spies** fail under ESM module semantics.
3. Some expectations are **stale from before the 44→23 tool pruning**
   (e.g. `build_brand_spot_from_mogrt_and_assets`, `expect(tools.length).toBeGreaterThan(50)`).

The flag was deliberately **not** added to the `test` script: turning a quiet skip into
a red build without doing the migration would not make the code any better tested.

**This means `src/tools/index.ts` has no executing test coverage today.** Treat changes
there as needing live verification against a real Premiere session.
