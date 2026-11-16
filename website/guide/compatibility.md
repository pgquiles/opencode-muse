# Compatibility

Supported means probed, not declared. Every version below has live evidence behind it — catalog listing, real text turns, rewind/fork, approval flows — recorded in the repo's [compatibility record](https://github.com/pgquiles/opencode-muse/blob/main/docs/compatibility.md), which also holds the full schema-snapshot ledger. This page summarizes; the record rules.

## Current pins

| Component | Status |
|---|---|
| Muse CLI | `1.4.14` exact pin (SDK fingerprint matches, no warning); `1.4.20` verified under the recorded fingerprint warning |
| `@muse-code/sdk` | `1.4.14` |
| OpenCode | `2.1.4` verified target; `2.3.0` in active use |
| OpenChamber embedded OpenCode | `2.0.32` (smoke-tested) |

A served CLI fingerprint that differs from the SDK pin does not block startup — the host records a `fingerprintWarning` and continues. Only a missing/malformed fingerprint or a different envelope version fails closed.

## Which combinations work

| Muse CLI | Default backend (`muse`) | Opt-in backend (`opencode`) |
|---|---|---|
| 1.4.12 – 1.4.14 | Verified | Verified on 1.4.14 |
| 1.4.20 | Verified (fingerprint warning) | Blocked — setup fails naming [#58](https://github.com/pgquiles/opencode-muse/issues/58) |
| Other 1.x (envelope v1) | Starts with warning, unverified | Blocked until a backend live-turn probe passes |

On the OpenCode side the verified range is 2.0.32 (embedded) through 2.3.0 for both backends; outside it the plugin starts but is untested. When in doubt, the default backend on a verified CLI is the combination with live evidence behind it.

## Known 1.4.20 limitation: opencode tool backend

Muse CLI 1.4.20 rejects session MCP servers in `run.toolset` (`configError: unknown tool`), and without the pin MCP tools never load into the run. The opencode backend therefore fails setup fast with a clear error on 1.4.20. The default muse backend is unaffected on all verified CLIs. Tracked upstream; the backend re-opens per CLI version once a backend live-turn probe passes.

## What "verified" costs

Adding a version means: offline schema export, snapshot + additive-delta classification, catalog and text-turn probes on each billing path in use, an explicit-cut fork probe, and (for the opencode backend) a live tool turn. No export is ever committed — only the snapshot ledger.
