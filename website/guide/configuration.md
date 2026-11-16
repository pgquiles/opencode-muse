# Configuration

All knobs are process environment variables, read once when the plugin loads (OpenCode does not forward per-model plugin options, so an `opencode.json` field cannot reach the bridge). Restart OpenCode after changing one.

| Variable | Values | Default | Meaning |
|---|---|---|---|
| `OPENCODE_MUSE_CONTRIBUTOR_MODE` | `on` / `off` | `on` | Billing lane for spawned Muse children |
| `OPENCODE_MUSE_TOOL_BACKEND` | `muse` / `opencode` | `muse` | Who executes tools (see below) |
| `OPENCODE_MUSE_APPROVAL_MODE` | `onRequest` / `host-default` / `allowAll` / `promptUnmatched` / `denyUnmatched` | `onRequest` | Muse-side approval posture (Muse backend only) |

Any other value fails plugin setup fast with a clear error — the plugin never silently runs the wrong posture.

## Approval mode (Muse backend)

By default the bridge selects `approvalMode: "onRequest"` for every Muse session, so Muse asks through the bridge before side-effectful actions. That forced mode overrides the permission profile configured in Muse itself, so `OPENCODE_MUSE_APPROVAL_MODE` makes the posture explicit:

- `host-default` omits `approvalMode`: the Muse host's configured permission profile applies, exactly as in the native TUI.
- The other four values select that host-defined mode verbatim ("select, never create").

When Muse asks for approval, the bridge ends the turn with the offered choices as a lettered list, naming what each choice grants. Reply with one option (letter, number, or name). Anything unrecognized is asked once more, then denied — ambiguity never approves, and your message still runs as a fresh turn afterward instead of being eaten.

## Tool backend

- `muse` (default, vetted): Muse runs its own tools with its own prompt. OpenCode's forwarded tool definitions are registered but never executed by OpenCode.
- `opencode` (explicit opt-in): OpenCode executes tools and Muse acts as the model behind them, connected through a private per-session loopback bridge. OpenCode's native permission evaluation is the only fence (`allowAll` on the Muse side), and the knob above is ignored.

> **Current limitation:** the opencode backend is gated to Muse CLI fingerprints with a passing backend live-turn probe (seed: 1.4.14). On Muse 1.4.20 the CLI rejects session MCP servers in `run.toolset`, so setup fails fast with a clear error pointing at the tracking issue instead of failing every turn. See [Compatibility](/guide/compatibility).

## What the plugin never does

Never reads `~/.config/muse` (credentials share a file with metadata, so even "safe" fields are off limits) — login state comes only from wire-level probes. Never logs prompts, generated text, media payloads, or raw CLI output. Never auto-updates your Muse binary from under a running host.
