# Install

Three things have to be in place before a tool call works:

```
your AI client  ──▶  MCP server (node)  ──▶  bridge panel inside Premiere  ──▶  your timeline
```

The bridge panel is the part people miss. **The MCP server cannot reach Premiere on its own** —
it writes request files to a temp directory, and a CEP panel running *inside* Premiere picks
them up, runs the ExtendScript, and writes the result back. If the panel is not open and
started, every tool call fails even though the client shows the server as connected.

---

## Requirements

| | |
|---|---|
| **Adobe Premiere Pro (Beta)** | See below — this is not optional in practice |
| **Node.js 18+** | `node -v` |
| **Python + faster-whisper** | `pip install faster-whisper` — needed for transcription |
| **ffmpeg** on PATH | `ffmpeg -version` |
| macOS | The installer script is macOS-only; Windows needs the manual path below |

### Use the Beta build

Install **Adobe Premiere Pro (Beta)** from Creative Cloud (Apps → Beta apps) and run the
bridge there.

The panel loads in the release build too, and the panel source claims release is supported,
but in real use tool calls do not come back on release — only on Beta. Until that is tracked
down, treat Beta as the requirement.

Beta and release install side by side and are separate applications
(`Adobe Premiere Pro (Beta).app` vs `Adobe Premiere Pro 2026.app`). Installing Beta does not
disturb your release install or your projects. **Open your project in Beta** when you want to
drive it from an AI client — a project open in the release build is invisible to the bridge.

> A project saved by Beta may warn when reopened in the release build. Work in one of them for
> a given project rather than alternating.

---

## macOS — scripted

```bash
git clone https://github.com/steveaimkt/Adobe_Premiere_Pro_MCP
cd Adobe_Premiere_Pro_MCP
npm run setup:mac
```

That one command does all of:

1. `npm install` + `npm run build`
2. Enables Adobe **CEP debug mode** (`PlayerDebugMode`) — required for any unsigned CEP
   extension to load at all
3. Copies `cep-plugin/` to `~/Library/Application Support/Adobe/CEP/extensions/MCPBridgeCEP`
4. Creates the bridge temp directory `/tmp/premiere-mcp-bridge`
5. Adds a `premiere-pro` entry to the Claude Desktop config

Then, **inside Premiere Pro (Beta)**:

1. Restart Premiere if it was open during the install.
2. `Window > Extensions > MCP Bridge (CEP)`
3. Set **Temp Directory** to `/tmp/premiere-mcp-bridge`
4. **Save Configuration**
5. **Start Bridge**
6. **Test Connection** — this must pass before anything else will work

Restart your AI client, open a project in Premiere (Beta), and ask:

```
What's my current Premiere Pro project info?
```

---

## macOS — manual

If you would rather not run the script, or you are on Windows:

**1. Build**

```bash
npm install && npm run build
```

**2. Enable CEP debug mode**

macOS:
```bash
for v in 10 11 12 13; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
```

Windows (`regedit`): under `HKEY_CURRENT_USER\Software\Adobe\CSXS.<version>`, add a string
value `PlayerDebugMode` = `1`.

> Set it for every CSXS version you might have. Which one your Premiere uses depends on the
> build, and an unset version silently refuses to load the panel.

**3. Install the panel**

Copy the `cep-plugin` folder into the CEP extensions directory, named `MCPBridgeCEP`:

- macOS: `~/Library/Application Support/Adobe/CEP/extensions/MCPBridgeCEP`
- Windows: `%APPDATA%\Adobe\CEP\extensions\MCPBridgeCEP`

**4. Create the temp directory**

```bash
mkdir -p /tmp/premiere-mcp-bridge
```

**5. Register the server with your client**

Claude Desktop — `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "node",
      "args": ["/absolute/path/to/Adobe_Premiere_Pro_MCP/dist/index.js"],
      "env": { "PREMIERE_TEMP_DIR": "/tmp/premiere-mcp-bridge" }
    }
  }
}
```

Claude Code:
```bash
claude mcp add premiere-pro --env PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge \
  -- node /absolute/path/to/Adobe_Premiere_Pro_MCP/dist/index.js
```

Codex — must be one line:
```bash
codex mcp add premiere_pro --env PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge -- node /absolute/path/to/Adobe_Premiere_Pro_MCP/dist/index.js
```

Restart the client after any config change.

---

## Run without cloning

The server alone can run straight from GitHub:

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

**The bridge panel still has to be installed by hand** — npx installs the server, not the
Premiere extension. Follow steps 2–4 of the manual path.

---

## Verify

```bash
npm run setup:doctor
```

Checks the build, the CEP extension, debug mode, and the client config.

For an end-to-end check against a live session, open a **scratch** project and run:

```bash
node scripts/live-tool-sweep.mjs
```

It creates disposable `Sweep ...` sequences, so do not point it at real work.

---

## When it does not work

The client shows the server but tool calls fail — walk these in order:

| Check | Fix |
|---|---|
| Is Premiere **(Beta)** open, with a project open? | Both are required |
| Is the panel open and **started**? | `Window > Extensions > MCP Bridge (CEP)` → Start Bridge |
| Does the panel's temp directory match the client's `PREMIERE_TEMP_DIR`? | Both must be `/tmp/premiere-mcp-bridge` |
| Did you update the repo since the panel was opened? | Right-click the panel → **Reload** |
| Is the project open in the **release** build by mistake? | Reopen it in Beta |

Still failing: click **Run Diagnostics** in the panel and read
`/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json`.

### The panel does not appear under Window > Extensions

CEP debug mode is not enabled for the CSXS version your Premiere uses, or the extension folder
is in the wrong place. Re-run step 2 for **all** CSXS versions, confirm the folder is named
`MCPBridgeCEP`, and restart Premiere.

### `setup:doctor` fails

The CEP extension is missing, `dist/index.js` was not built, debug mode is off, or the client
config points at the wrong path. The output names which one.

### Transcription tools fail

`faster-whisper` or `ffmpeg` is missing:

```bash
pip install faster-whisper
ffmpeg -version
```

---

## Uninstall

```bash
npm run uninstall:mac
```

Removes the CEP extension and the client entry. It leaves CEP debug mode on — other Adobe
extensions may rely on it.

---

See [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for confirmed runtime limits, and
[CONTRIBUTING.md](CONTRIBUTING.md) to work on the server.
