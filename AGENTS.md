# Repository Guidance

## Before Making Changes

- Read `docs/design.md` and the current implementation plan under `docs/plans/` before changing product behavior. They are the source of truth; README status text may lag behind design review.
- Do not begin implementation until the user has approved the plan. The plan's initial compatibility probes are hard gates: if a gate fails, stop and revise the design/plan rather than silently changing architecture.
- Keep this repository plugin-only. Do not modify OpenChamber source as part of v1.

## Security and Credentials

- Communicate with Meta only through the official `muse` CLI and `@muse-code/sdk` over the `muse serve` stdio protocol. Do not call Meta endpoints directly.
- Never open, parse, copy, cache, log, or transmit `~/.config/muse` or any Muse credential. Do not inspect credentials to infer auth state; use verified CLI/MSP responses.
- Never log raw login stdout/stderr, API keys, tokens, or unsanitized provider diagnostics. Live tests must not print or commit secrets.
- Let the Muse CLI own authentication. The plugin may relay safe login instructions but must not extract credentials.

## Protocol and Session Invariants

- Pin the OpenCode binary, Muse CLI, exported MSP schema, and `@muse-code/sdk` versions used for implementation and tests. Vendored schema assumptions must be checked against the pinned CLI.
- Record every Muse CLI version used during development as a snapshot entry in the schema ledger plus a row in `docs/compatibility.md`; never commit full schema exports.
- Use the proven `aisdk:` language-model hook only after the request-correlation probe passes. Never infer session context from global “most recent request” state.
- Preserve MSP command idempotency for methods whose schema defines `commandId`: persist/reuse it with the exact payload. Each `media/upload` chunk has both a `commandId` and the upload's shared `uploadId`; `view/subscribe` is cursor-based and has no command ID. Never invent IDs or automatically replay an ambiguous side-effecting turn with a new command ID.
- Subscribe to Muse session views and persist cursors; resume/replay through the protocol rather than assuming notifications were received.
- In v1, use one `muse serve` process and one Muse session per OpenCode session. Respect workspace locking, explicit Muse fork cut points, and the documented lack of filesystem rollback on rewind.
- Model and modality support is a bridge/protocol question, not an assumption about model capability. Map media and structured-output features when the pinned MSP/CLI supports them; report only specific unsupported bridge paths.

## Safety and UX

- Muse's native agent loop owns tool execution. Do not emit OpenCode tool-call parts or imply that OpenCode tools were executed by Muse.
- Approval decisions must use a choice currently offered by Muse with its current requirement ID. Fail closed if the UI cannot represent the offered choice. Never invent choice IDs or add a plugin-side persistent auto-allow cache.
- Do not fabricate structured `userInput/*` answers. If the UI cannot collect the full answer schema, clearly interrupt/defer that feature.
- Do not silently discard user input. In particular, preserve supported image/video inputs; return a narrow, clear error only when the pinned bridge cannot represent the requested input/constraint.
- Treat OpenCode transcript history as a projection of Muse session state. Local compaction must not be mistaken for rewind; rewind must not silently retain discarded Muse turns.

## Development and Verification

- Use strict TypeScript/ES modules and follow the surrounding plugin conventions. Add focused tests before implementation (TDD); default to fake MSP hosts for unit/integration tests.
- Run the package build and test scripts after code changes. Run live PAYG probes only when needed, using the official CLI and sanitized logs; a subscription is not required for ordinary development.
- Before public release, re-check the applicable Meta terms and document exact supported versions, probe results, and limitations.

## Release

- npm publishes only through `.github/workflows/publish-npm.yml` (OIDC trusted publishing, triggered by `gh release create`). Never run `npm publish` from a laptop: account 2FA makes it fail with EOTP and the attempt is redundant once the release exists.
