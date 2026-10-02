# gemini2api-mcp

MCP wrapper, credential auto-sync, and service patches for
[gemini2api](https://github.com/xwteam/gemini2api) — a self-hosted service that
turns the **Gemini web UI into an OpenAI-compatible API** using browser cookies.

This repository contains everything that runs on the **client side** of such a
deployment:

| Component | What it does |
|---|---|
| `server.mjs` | MCP server exposing a `gemini_chat` tool (text, images, PDF/Office attachments) to any MCP client — ZCode, Claude Code, Codex, OpenAI agents, … |
| `check.mjs` + `run-scheduled.mjs` + `ssh_tunnel.py` | Credential auto-sync: keeps the server's Google cookies fresh by reading the signed-in Chrome session, comparing SHA-256 fingerprints via the admin API, and submitting at most one idle-window web-form update |
| `launchagent/` | macOS LaunchAgent template that runs the checker every 5 minutes |
| `service-patch/` | Hardening and bug-fix patches for the upstream gemini2api service (non-root Docker, masked credentials in admin API, idle-reservation cookie updates, atomic persistence + regression test) |
| `calibration/` | Research: how Gemini reports pixel coordinates, and the prompt recipe that makes them pixel-accurate (28/28 targets ≤1px) |

## Required dependencies / upstream projects

1. **[xwteam/gemini2api](https://github.com/xwteam/gemini2api)** (upstream service, **non-commercial license**)
   The server this repo wraps. Deploy it first; it provides the
   `http://host:5918/openai/v1` endpoint, the `/admin` management API, and the
   cookie-based account pool. The files under `service-patch/` are derivatives
   of this project and follow its license.
2. **[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)**
   (`@modelcontextprotocol/server`, npm) — MCP protocol implementation used by
   `server.mjs`.
3. **[zod](https://github.com/colinhacks/zod)** (npm) — tool input schemas.
4. **[paramiko](https://github.com/paramiko/paramiko)** (Python) — loopback SSH
   tunnel for management traffic (`ssh_tunnel.py`).
5. **A Chrome automation bridge speaking the `{action, args}` JSON protocol on
   `127.0.0.1:10086`** (navigate / fill / click / evaluate / cdp `Network.getCookies`).
   The reference setup uses the Kimi WebBridge extension + native daemon
   (`~/.kimi-webbridge/bin/kimi-webbridge`); any CDP-based bridge with the same
   command shape works.
6. **Node.js ≥ 20** (built-in `fetch`, `AbortSignal.timeout`) and
   **Python ≥ 3.11**. The scheduler/notifier part is macOS-only (LaunchAgent +
   `osascript`); the MCP wrapper itself is cross-platform.

Related: [UI-Venus-MCP](https://github.com/q1820926174-cpu/UI-Venus-MCP) — a
cross-platform computer-use MCP that can use this endpoint as a pluggable
vision provider (see its `docs/gemini-coordinate-calibration.md`).

## Quick start

```bash
git clone https://github.com/q1820926174-cpu/gemini2api-mcp
cd gemini2api-mcp
npm install
cp .env.example .env   # fill in your server URL + keys
npm start              # stdio MCP server
```

Register in an MCP client (ZCode `~/.zcode/cli/config.json` example):

```json
{
  "mcp": { "servers": {
    "gemini2api": {
      "command": "node",
      "args": ["/absolute/path/to/gemini2api-mcp/server.mjs"]
    }
  }}
}
```

Tool surface (`gemini_chat`):

```jsonc
{
  "prompt": "What is in this image?",
  "model": "gemini-flash",              // or gemini-pro / -lite / -thinking
  "system": "optional system instruction",
  "images": ["/abs/path/pic.png"],       // up to 8, image types
  "attachments": ["/abs/path/doc.pdf"],  // up to 8, pdf/text/office
  "max_tokens": 4096
}
```

Limits: single-round only (no conversation state), max 8 files / 20 MiB per
call, 180 s upstream timeout (image calls take 5–120 s; MCP client timeouts
below ~180 s will cut image requests short).

## Credential auto-sync (optional)

Google rotates the `__Secure-1PSID*` cookies behind gemini2api; when that
happens the service starts failing until someone re-pastes cookies into the
admin dashboard. The checker automates this safely:

- Reads the two cookies from your signed-in Chrome (in memory only).
- Compares SHA-256 fingerprints of local vs. server-configured vs.
  server-persisted credentials.
- Only on mismatch **and** an idle server, submits exactly one update through
  the real web form, then verifies persistence. Busy server → `DEFERRED_BUSY`,
  unresolved attempt → blocks further writes until confirmed.
- Everything else (SSH tunnel, keys) is loopback-only; state files hold hashes,
  never credentials. Details: [CREDENTIAL-CHECK.md](CREDENTIAL-CHECK.md).

```bash
npm test               # unit tests (no network)
npm run check          # one manual check
npm run check -- --read-only
cp launchagent/com.example.gemini2api-credential-check.plist \
   ~/Library/LaunchAgents/   # edit paths first
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.gemini2api-credential-check.plist
```

## Coordinate calibration (for automation use)

Gemini's reported coordinates are **not** in the image's pixel space by
default — the model guesses a coordinate system per answer (800×600, 1000×750,
711×711 observed on the same image). Declaring the exact dimensions in the
prompt makes it pixel-accurate: **28/28 targets ≤1px** across 4:3 / 2:1 / 16:9.
Prompt recipe, conversion formula, and reproducible experiments:
[calibration/README.md](calibration/README.md).

## Security notes

- No credentials in code or logs: everything comes from `.env` (gitignored) or
  the environment; see `.env.example`.
- The tunnel rejects unknown SSH hosts (`RejectPolicy` + `known_hosts`).
- Cookie updates go through the dashboard's own form with masked inputs; the
  checker clears filled fields and the tunnel-origin management token
  afterwards.
- `service-patch/` additionally masks `psid` in admin API responses and runs
  the container as non-root.

## License

MIT — except `service-patch/`, which derives from
[xwteam/gemini2api](https://github.com/xwteam/gemini2api) and follows its
**non-commercial license** (personal study / research / self-deployment only).
See [service-patch/LICENSE-NOTE.md](service-patch/LICENSE-NOTE.md).
