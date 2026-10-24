# OpenCode Muse Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task, according to the approved execution method. Do not begin implementation until this plan is approved. The initial probe tasks are gates; stop and revise the design if a gate fails.

**Goal:** Build `opencode-muse`, an OpenCode plugin that bridges OpenCode model requests to Muse-native agent turns through `muse serve` without reading or handling Muse credentials.

**Architecture:** The plugin registers a static/fallback Muse provider catalog and supplies a `LanguageModelV3` through the verified `aisdk:` hook. A per-OpenCode-session `muse serve` host owns one durable Muse session; MSP view subscriptions and persisted cursors carry output, approvals, and recovery. OpenCode transcript history is a projection, not Muse's source of truth.

**Tech Stack:** TypeScript ES modules; `@opencode/plugin` v2 API; `@muse-code/sdk` pinned to the verified Muse CLI schema; `@ai-sdk/provider` V3 types; `tsc`; Bun test runner; npm-compatible package metadata. Match the strict TypeScript and ESM conventions in `opencode-claude` unless the initial compatibility probe requires otherwise.

**Spec:** [`docs/design.md`](../design.md), v1.3.

## Global Constraints

- Muse auth and inference stay inside `muse serve` over stdio JSON-RPC via `@muse-code/sdk`.
- The plugin must never open, parse, copy, cache, log, or transmit `~/.config/muse` or Muse credential values.
- No OpenChamber source changes in v1; verify UI surfaces before promising auth/approval UI.
- Pin and test against exact OpenCode and Muse CLI/schema versions; schema declarations not matched to the binary are provisional.
- One persistent `muse serve` process and one Muse session per OpenCode session for turns in v1; a short-lived, sessionless host may query `model/list` during provider discovery.
- V1 maps image/video through verified MSP parts; probe audio/PDF/strict JSON paths and report only bridge-specific limits. General stateless `generate` remains unsupported, and the plugin never fabricates `userInput/*` answers.
- Muse approval decisions use only currently offered `choiceId` + `requirementId`; no plugin-side persistent auto-allow.
- No automatic transcript rehydration or filesystem rollback on rewind; ambiguous side-effecting turns are never replayed automatically. Rewind/fork implementation stays blocked until explicit `session/fork.cutPoint` succeeds on a supported target runtime.
- Use the user's existing official-CLI Muse access for live probes (subscription-backed Contributor mode is preferred; configured PAYG is also acceptable); never require or extract credentials.
- Keep Contributor mode enabled for the user's subscription-backed live tests; the plugin and test harness must not toggle this account setting.

## Review Focus

- Missing or misrouted request metadata must not attach a Muse turn to the wrong OpenCode session; test concurrent sessions and the correlation fallback gate.
- Restart after `turn/start` acceptance must not duplicate file-changing work; test cursor replay, command IDs, and ambiguous outcomes.
- Compaction, same-length transcript edits, and rewind must not be conflated; test multiple compactions and explicit Muse fork cut points.
- Staged approvals and structured user-input prompts must fail closed when the UI cannot represent them; test stale requirement IDs and unsupported UI.
- Model/API capability must be mapped through MSP rather than rejected broadly; test image/video mapping, audio/PDF and strict-JSON protocol support, plus precise errors for genuinely unsupported requests.

---

## Planned File Structure

Create focused modules; adjust names only to match actual pinned SDK exports, and update this plan before changing responsibilities.

- `package.json`, lockfile, `tsconfig.json`: package/build/test metadata.
- `src/index.ts`: OpenCode v2 plugin entry and setup wiring.
- `src/provider.ts`, `src/catalog.ts`: provider registration, static fallback, live Muse model mapping/refresh.
- `src/msp/host.ts`, `src/msp/client.ts`: one child process and typed MSP connection per OpenCode session; command IDs and view subscriptions.
- `src/session/registry.ts`, `src/session/workspace-lock.ts`: durable mapping/recovery state and cross-process workspace exclusion.
- `src/model/context.ts`, `src/model/prompt.ts`: request metadata, role-aware context allowlist, supported input validation.
- `src/model/language-model.ts`, `src/model/stream.ts`, `src/model/meta.ts`: V3 `doStream`/`doGenerate`, event conversion, local title/compaction.
- `src/errors.ts`: safe typed Muse/OpenCode error mapping.
- `src/approvals.ts`, `src/narration.ts`: optional UI bridge and synthetic activity entries.
- `src/auth.ts`: `muse login` relay and verified wire-level state probe; no config-file access.
- `test/unit/**`, `test/integration/**`, `test/probes/**`: fake MSP/OpenCode tests and opt-in live probes.
- `docs/compatibility.md`: pinned version/schema fingerprints and probe outcomes, never credentials or raw sensitive output.

## Tasks

### Task 1: Pin the runtime and protocol contract

**Files:**
- Create: `docs/compatibility.md`
- No product code in this task.

**Interfaces:** Produces the exact Muse CLI version, exported MSP schema fingerprint, `@muse-code/sdk` version, and OpenCode version used by later tasks.

- [x] Record `muse --version` and `opencode --version`; record the SDK package version selected for the probe.
- [x] Use `muse schema --help` to identify the supported stable/experimental schema export commands; export both surfaces and record hashes plus the command used.
- [x] Compare the exported schema with vendored declarations for session durability/fork/cursors/command IDs, model selection, approval/user-input events, `TurnInputPart` media types and `media/upload`, and any structured-output control.
- [x] For any live protocol probe, use only the user's existing Muse login or a PAYG key configured through the official CLI; verify logs and artifacts contain no credential values. (No live model call was needed for Task 1.)
- [x] If the target schema differs in a way that changes v1 behavior, stop and update `docs/design.md` before proceeding. (No MSP schema drift found; OpenCode 2.1.2 target and the older 2.1.1 smoke baseline are recorded.)

**Verification:** `docs/compatibility.md` contains versions, hashes, and differences; secret scan/manual review finds no auth-file contents, tokens, API keys, or raw login output.

### Task 2: Probe OpenCode request correlation (hard stop gate)

**Files:**
- Create: `test/probes/correlation-plugin.js`
- Create: `test/probes/correlation-run.sh`
- Update: `docs/compatibility.md`

**Interfaces:** Probe a provider registered with the proven `aisdk:file://` factory and a custom LanguageModelV3. The test model records only sanitized metadata fields and outputs a fixed string.

- [x] Write the probe asserting `model.request` adds namespaced session ID, directory, kind, model ID/provider, and variant headers. Record whether profile ID is present directly; if not, resolve it through the selected catalog model mapping.
- [x] Run a session-associated request and assert those fields arrive intact in `doStream` options. Session-associated routes tested here invoked `doStream`; no session-associated `doGenerate` caller was observed.
- [x] Exercise `/api/session/:sessionID/generate` and `/api/experimental/generate` separately; session.generate correlated and left OpenCode history unchanged. The stateless route did not resolve the project-local provider at the model boundary, so it remains unsupported in v1; never attach context-free calls to a guessed Muse session.
- [x] Exercise two overlapping OpenCode sessions plus concurrent title/primary/compaction/generate calls on one server; assert context signatures match and sessions remain distinct.
- [x] Observe `session.generate` calls `doStream` in the pinned runtime; confirm the selected v1 behavior does not mutate Muse history or use the live Muse session.
- [x] Record sanitized output and PASS results in `docs/compatibility.md`, including catalog-based profile resolution and the context-free generate limitation.

**Gate:** If in-process request metadata is absent, incomplete, or racy, stop. Revise the design to the local-proxy architecture before writing the session bridge; do not use global “most recent request” state.

### Task 3: Create the TypeScript plugin scaffold and test harness

**Files:**
- Create: `package.json`, lockfile, `tsconfig.json`
- Create: `src/index.ts`, `src/types.ts`
- Create: `test/run.ts`, `test/helpers.ts`
- Modify: `README.md`

**Interfaces:** Export the OpenCode v2 plugin entry from `src/index.ts`; use the versions pinned in Task 1. `src/types.ts` owns internal types for `RequestContext`, `MuseModelSelection`, and error categories.

- [ ] Bootstrap `package.json`, `tsconfig.json`, and the Bun test script so tests/build can run; do not add bridge behavior in this step.
- [ ] Add a failing test asserting the package entry exports the OpenCode v2 plugin shape and strict TypeScript mode is enabled.
- [ ] Run the test and build to verify they fail for the missing plugin entry.
- [ ] Implement the ESM plugin entry and minimal setup that registers no provider until later tasks wire it.
- [ ] Add an npm-compatible published entry and only the pinned dependencies required by later tasks; follow `opencode-claude` conventions without unrelated dependencies.
- [ ] Run `npm run build` and `bun test`; verify both pass.

### Task 4: Probe Muse session durability and event recovery (hard stop gate)

**Files:**
- Create: `test/probes/msp-lifecycle.ts`
- Update: `docs/compatibility.md`

**Interfaces:** Use the pinned `@muse-code/sdk` connection to `muse serve`; record only IDs, event names, cursors, terminal kinds, and sanitized usage counts.

- [x] Echo probe: start a Muse session with an isolated workspace and record durability (`durable` from initialize).
- [x] Echo probe: verify start auto-attaches at the returned view cursor and a `turn/start` command retry with the same ID/payload returns the same turn with one `turn/started`; the local echo provider emitted no assistant text/item deltas and reported zero usage, so live response/usage verification remains pending.
- [x] Echo probe: disconnect and resume the same session; `view/subscribe` after the prior cursor replayed the terminal once, both before and after reconnect. `view/gap` recovery remains pending because no gap was induced.
- [x] Live authorized turn: verify `turn/started`, `userMessage` completion, `agentMessage` start/completion, and numeric session token usage through the official CLI; Contributor mode remained unchanged. The probe observed no `item/delta` and `turn/completed.usage` was absent.
- [ ] Verify streaming text deltas and model-authored per-turn usage (or document a safe fallback when `turn/completed.usage` is absent).
- [x] Echo probe: re-submit `turn/start` with the exact same `commandId` and payload; the host returned the same turn and did not create a duplicate start event. Result is recoverable from the view; same-command replay did not create a second turn.
- [ ] Probe cancel vs interrupt vs unqueue, `turn/start` dispositions beyond `started`, approval park/resolution, and `view/gap` recovery.
- [x] Probe explicit `session/fork.cutPoint` and `session/rename`: on Muse 1.4.11/Linux, fork returned internal `file birth time is unavailable`; rename capability was granted but rename returned internal `session naming is unavailable`. Rewind/fork is therefore blocked on this target; custom names are best-effort only.
- [x] Probe a small inline image and video upload through `muse serve`: one 16×16 PNG plus a 1-second MP4 (897 bytes) in a single Meta turn completed; `media/upload` accepted one chunk and echoed the receipt. No payload or generated text was logged; semantic image/video recognition was not asserted.
- [x] Verify the pinned stable MSP turn surface has no audio/PDF part and `turn/start` has no `responseFormat` member; record these as direct-bridge unrepresented unless a separate official path is verified. No alternate audio/PDF/strict-JSON route was tested live.
- [ ] Investigate alternate official CLI/host routes for audio and PDF and perform a strict-output probe if one is exposed; until then, do not claim model-level limitations.
- [ ] Verify whether a successful fork cut at Muse turn N excludes all later completed turns and whether it changes workspace files (it must not be treated as a filesystem rollback); blocked until the explicit fork call succeeds on a supported target.

**Gate:** Echo and subscription-backed Meta both reported durable sessions; cursor replay and reconnect resume passed for the exercised terminal event. This does not cover view-gap, cancel/interrupt/unqueue, or all item-delta/usage cases. The Muse 1.4.11/Linux fork failure is a hard stop for rewind/fork implementation: do not implement or advertise rewind until the runtime error is fixed or the explicit-cut probe passes on a supported target. Live approval and alternate-media work remains gated on the corresponding probes.

### Task 5: Probe OpenChamber UI and approval feasibility

**Files:**
- Create: `test/probes/openchamber-ui.md`
- Update: `docs/compatibility.md`

**Interfaces:** Use a test plugin against the user's OpenChamber/OpenCode runtime; do not alter OpenChamber source.

- [ ] Runtime-test a provider with a fallback model while Muse is missing or logged out.
- [x] Source-inspect `ctx.integration` auth presentation: the current OpenChamber provider UI handles OAuth/external/key methods but not command methods, so a plugin `muse login` button is not established. Use manual official-CLI login; runtime visibility remains unverified.
- [x] Source-inspect permission choices: UI offers generic allow-once/always/reject and cannot faithfully display arbitrary Muse choice IDs/labels/scopes. Defer Muse approval UI; changed stages/stale requirements were not runtime-tested.
- [ ] Runtime-check whether any available UI can collect the complete structured `userInput/requested` schema (single/multiple selection and free text). Until proven, record it as unsupported in v1.
- [ ] Runtime-verify whether OpenChamber detects/undoes files changed by Muse outside OpenCode-native tools. Source inspection only shows message/file restoration to the composer, not workspace rollback; do not infer file restore from file watching.

**Gate:** If auth methods are not surfaced, use the documented manual `muse login` fallback. If dynamic approvals cannot be represented, defer the approval UI rather than mapping to generic allow/deny. Do not implement structured user input without a matching UI.

### Task 6: Build the fake MSP host and protocol adapter

**Files:**
- Create: `src/msp/client.ts`, `src/msp/host.ts`, `src/errors.ts`
- Create: `test/unit/msp-client.test.ts`, `test/unit/msp-host.test.ts`, `test/helpers/fake-msp.ts`

**Interfaces:** `MspHost.start(options) -> Promise<MspHost>`; `MspHost.command(method, paramsWithCommandId) -> Promise<result>`; `MspHost.subscribe(sessionId, after?) -> AsyncIterable<MspNotification>`; `MspHost.close() -> Promise<void>`. The UUIDv7 `commandId` is part of the typed params, not a second independent argument. Adapt exact SDK signatures from Task 1 rather than inventing wire shapes.

- [x] Write fake-host tests for initialize, session start/resume/fork, view subscribe/replay, command IDs, notification ordering, child exit, malformed messages, and abort.
- [x] Run tests red: initially failed because `src/msp/client.ts` and `src/msp/host.ts` were absent; focused red cases also caught malformed-frame handling and close-error propagation, without SDK/network dependencies.
- [x] Implement a stdio child lifecycle with bounded startup/command timeouts, no raw stderr forwarding, graceful close, sanitized exit classification, and fail-closed handling of ambiguous command timeouts.
- [x] Implement one MSP connection per OpenCode session; require the exact pinned handshake fingerprint, use the SDK's JSON-RPC/frame validation, and pass unknown additive notification methods through for consumers to ignore safely.
- [x] Run `bun test test/unit/msp-client.test.ts test/unit/msp-host.test.ts` and `npm run build`.

### Task 7: Implement durable session registry and workspace lock

**Files:**
- Create: `src/session/registry.ts`, `src/session/workspace-lock.ts`
- Create: `test/unit/session-registry.test.ts`, `test/unit/workspace-lock.test.ts`

**Interfaces:** `SessionRegistry.get(opencodeSessionId, workspaceFingerprint)`, `put(entry)`, `updateCursor(...)`, `recordPendingCommand(...)`, `clearPendingCommand(...)`; `WorkspaceLock.acquire(workspaceFingerprint) -> LockLease | BusyError`, `LockLease.release()`.

- [x] Write tests for atomic persistence, schema versioning, restart load, corrupt-file recovery, wrong-workspace rejection, concurrent writers, independent workspaces, and stale lock recovery. Unsupported/corrupt versions are quarantined and treated as unmapped; no legacy schema migration exists yet because the plugin has no released registry format.
- [x] Assert persisted records contain IDs, hashes, cursors, and command fingerprints only—no prompt bodies, transcripts, Muse config values, workspace paths, or raw CLI output.
- [x] Run tests red, implement versioned atomic state under the selected OpenCode user data/state directory with restrictive permissions and a local single-writer lock, then run green.
- [x] Test a second OpenCode session on the same workspace receives a clear busy result; test different workspaces proceed independently.
- [x] Document platform paths and the local lock strategy in `docs/compatibility.md`.

### Task 8: Register the provider and resilient catalog

**Files:**
- Create: `src/provider.ts`, `src/catalog.ts`
- Create: `test/unit/catalog.test.ts`, `test/integration/provider-registration.test.ts`
- Modify: `src/index.ts`

**Interfaces:** `buildOpenCodeCatalog(museCatalog, fallbackCatalog) -> ModelInfo[]`; `createProviderPlugin(ctx) -> Promise<void>`. Register provider ID `muse`, package `aisdk:${import.meta.url}`, and `createMuse` factory; apply live catalog refresh through `ctx.provider.reload()` only after replacing the cached catalog.

- [x] Test mapping of Muse `providerId`, `profileId`, `modelId`, labels, context/output limits, release date, active/default sidecar status, and known effort variants.
- [x] Run the catalog mapping tests red against the missing implementation and then green.
- [x] Test an empty/fake catalog retains a clearly labeled, disabled fallback placeholder; no fallback model is runnable.
- [x] Test refresh preserves the last good catalog on fetch or reload failure; the fake provider integration verifies cache replacement precedes `provider.reload()`.
- [x] Implement registration with the proven `aisdk:file://` seam and named drift diagnostic. The npm `aisdk:@ai-sdk/openai-compatible` path remains documented only as a fallback.
- [x] Run focused catalog/registration tests, `npm run build`, strict test type-check, and live `muse model/list` discovery (no inference).
- [ ] Verify pinned OpenCode 2.1.2 provider discovery/reload with `test/probes/provider-list-smoke.sh`; current `opencode models` and `provider.list` endpoints hang even in an empty project without the Muse plugin, so this runtime gate is blocked by the local OpenCode baseline.

### Task 9: Implement request context, input validation, and selection routing

**Files:**
- Create: `src/model/context.ts`, `src/model/prompt.ts`, `src/model/agent-context.ts`
- Create: `test/unit/request-context.test.ts`, `test/unit/prompt.test.ts`, `test/unit/agent-context.test.ts`

**Interfaces:** `readRequestContext(callOptions, selectionIndex) -> RequestContext | ContextError`; `extractTurnInput(prompt, previousTranscriptFingerprints, contextAllowlist) -> ExtractTurnInputResult`; `validateModelOptions(options) -> ModelOptionsResult`. Transcript lineage is an ordered fingerprint array so same-length edits are detected without persisting prompt text.

- [x] Test correlation header parsing, missing/invalid metadata, concurrent session isolation, and context-free `doGenerate` handling for stateless generation; no session-associated `doGenerate` path was observed in the pinned runtime.
- [x] Test only new user content is sent; custom agent prompt context is isolated and labeled, while tool catalogs and volatile system boilerplate are excluded. Unknown custom-agent layouts fail closed; other host-only system context is an explicit v1 limitation. Transcript divergence fails closed using ordered fingerprints.
- [x] Test image data maps to MSP image parts and video is extracted to uploadable bytes; Task 10 will chunk with UUIDv7 `commandId`s plus one shared `uploadId`. No direct audio/PDF/strict-JSON MSP path is represented; alternate official paths remain unverified, and errors name the direct-bridge limitation.
- [x] Test ordinary user text requesting JSON remains normal text, strict `responseFormat=json` is rejected, non-empty tool definitions do not fail, and an explicitly required OpenCode tool is rejected. Unsupported sampling settings are reported by name only.
- [x] Test remote media references are not fetched, size limits are checked, and preflight cancellation aborts before returning turn input.
- [x] Test provider/model/profile/effort context maps through the catalog sidecar; persistent model switching and per-turn reasoning routing are wired in Task 10.
- [x] Run tests red, implement pure parsers/validators, then run green.

### Task 10: Implement LanguageModelV3 streaming and generation

**Files:**
- Create: `src/model/language-model.ts`, `src/model/stream.ts`
- Create: `src/session/manager.ts`, `test/unit/session-manager.test.ts`
- Create: `test/unit/language-model.test.ts`, `test/unit/stream-mapping.test.ts`, `test/integration/turn-bridge.test.ts`
- Modify: `src/index.ts`, `src/provider.ts`, `src/model/agent-context.ts`

**Interfaces:** `createMuseLanguageModel(runtime) -> LanguageModelV3`; `runMuseTurn(context, input, options) -> Promise<MuseTurnExecution>`; `MuseSessionManager.resolveSession(context)` creates/reuses one host/session, binds provider/model/profile, persists the mapping, and returns cursor/turn/lock callbacks. `doStream` and `doGenerate` share the same Muse turn execution.

- [x] Write fake-MSP tests for text start/delta/end, summarized reasoning, cancellation, successful/failed/zero-text terminals, unknown terminal values, and one session per OpenCode session.
- [x] Run tests red against the missing stream/session-manager modules and verify the intended behavior failures.
- [x] Assert object-form V3 `finishReason`, flat usage keys, no OpenCode tool-call parts, no usage fabrication, and no secret/error-text leakage. Strict JSON/forced OpenCode tool constraints are rejected by Task 9 preflight.
- [x] Test `turn/start` authoritative `turnId` and `disposition`; queued turns are unqueued on abort; running turns are interrupted.
- [x] Implement V3 text/reasoning/error/finish mapping, authoritative-completion reconciliation, foreground response finish, and continued monitoring/lock ownership through final terminal. Preflight/startup errors reject before stream creation; asynchronous failures emit a V3 error part.
- [x] Test `doGenerate` returns the same foreground response without creating a second Muse turn; final terminal updates are still monitored until release.
- [x] Wire `ctx.aisdk.hook("language")` to the catalog sidecar and per-session manager; preserve the named factory drift diagnostic.
- [x] Run fake-MSP unit/integration tests, package build, and strict test type-check.
- [ ] Pinned OpenCode echo-to-Muse runtime smoke remains blocked: `opencode models --standalone` timed out after 15s with an empty project and the plugin installed; the same CLI path also times out without the plugin. Re-run once the OpenCode baseline returns. See `docs/compatibility.md`.

### Task 11: Add local title, compaction, and history lineage

**Files:**
- Create: `src/model/meta.ts`, `src/session/fingerprint.ts`
- Modify: `src/model/prompt.ts`, `src/model/language-model.ts`, `src/session/registry.ts`, `src/session/manager.ts`, `src/provider.ts`
- Create: `test/unit/meta-request.test.ts`, `test/unit/fingerprint.test.ts`

**Interfaces:** `classifyMetaRequest(kind, prompt) -> "title" | "compaction" | "unsupported-generate" | "agent"`; `makeLocalTitle(prompt) -> string`; `makeCompactionDigest(prompt, maxOutputTokens) -> string`; `fingerprintTranscript(prompt) -> Fingerprint`.

- [x] Test title detection via `kind` and narrow unhooked prompt shapes; unknown stateless generate returns unsupported without resolving/starting a Muse session.
- [x] Test bounded deterministic digest preserves the initial request and recent complete exchanges, omits tool/system traffic, makes no inferred-decision claim, and handles multilingual text.
- [x] Persist only the compaction output hash; treat a history change as compaction only when that exact text hash appears later. A successful following Muse turn commits the compacted fingerprint baseline; failed/cancelled turns leave the candidate pending.
- [x] Test same-count earlier-message edits and genuine rewind diverge; exact observed compaction continues the existing Muse session.
- [x] Register local zero-model-call title/compaction session hooks and V3 prompt-shape fallback; candidate updates serialize through the workspace lock.
- [x] Run tests red, implement deterministic local handlers/fingerprints, then run green (131 tests plus build and strict test type-check).
- [ ] Pinned OpenCode local-meta runtime smoke remains blocked by the same empty-project CLI/provider-list timeout; a bounded 10s plugin run returned `OPEN_CODE_MODELS_TIMEOUT`. Rerun once OpenCode responds.

### Task 12: Add Muse session lifecycle, restart recovery, and rewind

**Files:**
- Create: `test/integration/session-recovery.test.ts`, `test/integration/rewind-fork.test.ts`
- Modify: `src/session/manager.ts`, `src/session/registry.ts`, `src/msp/client.ts`

**Interfaces:** `resolveSession(context) -> MuseTurnSession`; `startOrResume(binding) -> durable-or-fresh Muse session`; `recoverPendingTurn(binding) -> explicit user-choice-required result`. There is no `forkAt` in v1; mapped rewind/fork is deferred to #20.

- [x] Test one host/session, durable `session/start` and `session/resume`, cursor persistence/replay, and a fresh Muse session for a distinct OpenCode fork/session.
- [x] Exercise command-pending/turn-active crash boundaries: before ack and after accepted turn. Persist exact command IDs/fingerprints; never retry a pending side effect after restart without its reconstructable exact payload.
- [x] On process restart, resume only durable idle sessions at the observed cursor. Pending commands, absent/unknown `activeTurnId`, or active Muse turns require explicit user recovery choice.
- [x] Fill a `view/gap` with bounded `view/page` pagination, deduplicate replayed cursors, and preserve the live boundary event.
- [x] Transcript divergence returns an explicit fresh-session-required error before `turn/start`; rewind/fork remains excluded and tracked by #20. The bridge does not roll back workspace files.
- [x] Keep the workspace lock through foreground response/background work until terminal persistence; same-workspace writers receive `WorkspaceBusyError`.
- [x] Implement and fake-test these recovery boundaries in `src/session/manager.ts`, registry callbacks, and the turn monitor. SDK same-ID retry remains limited to an exact in-process command/payload.
- [ ] Live restart/recovery probe on the pinned CLI is not run in this slice: echo’s earlier lifecycle probe covered durable idle resume/cursor replay; OpenCode end-to-end is blocked by its empty-project CLI hang. Do not run PAYG without explicit approval; Contributor mode remains unchanged.

### Task 13: Add approval bridge and narration (conditional on UI gate)

**Gate result:** Task 5 source inspection failed: OpenChamber's generic permission UI cannot faithfully display Muse's dynamic choice IDs, labels, and requirement scopes. No approval/narration UI adapter or generic allow/deny mapping is implemented in v1. MSP initialize advertises `userInputDialogs:false`; the pinned SDK rejects unhandled server requests as method-not-found, so the plugin never fabricates an answer or choice.

- [x] Record the failed UI gate and defer exact-choice approval UI; no local always cache or invented choice IDs exist.
- [x] Test manager capabilities disable unsupported structured user-input dialogs; characterize default method-not-found handling for unregistered approval server requests.
- [x] Keep the LanguageModelV3 bridge from emitting OpenCode tool calls. Narration and native file diffs remain unavailable pending a UI/runtime presentation gate.
- [x] Do not run a live approval PAYG probe because the UI gate failed; Contributor mode is unchanged.

**2026-10-24 addendum:** Re-inspection for #22 found the piece missing from the v1 gate analysis: OpenChamber's UI is generic (once/always/reject plus typed forms) and the plugin SDK exposes `permission.create` as ask-and-await. The v1 gate failed on *displaying* dynamic Muse choices; the #22 design never displays them — verdicts map onto offered choices, satisfying the exact-choice rule differently. The approval slice proceeds under #22 with sessions on `approvalMode: "onRequest"`; the forms slice (`userInput` → form request) remains pending.

### Task 14: Add safe auth UX and OpenChamber integration fallback

**Gate result:** OpenChamber's current UI does not surface plugin command auth methods, and no exact billing/auth failure was verified on the pinned CLI. Do not add `src/auth.ts`, spawn `muse login` from OpenCode, or infer authentication from an empty session list. Use the official CLI manually and preserve generic typed Muse errors.

- [x] Document manual `muse login`, no sign-in card promise, no credential reads, and no Contributor/PAYG mode changes in README.
- [x] Preserve safe generic MSP/turn failures; no auth file parsing or raw stdout/stderr logging is implemented.
- [x] Verify UI auth method limitation via source inspection (#6); do not implement a login relay without a UI surface.
- [x] Keep credential/config path access prohibited and state-directory safety tests in place.

### Task 15: Final end-to-end gates and packaging

**Files:**
- Modify: `README.md`, `docs/compatibility.md`
- Modify: `package.json`, publish files only as required by build output.
- Create: `test/integration/e2e-payg.test.ts`

**Interfaces:** All earlier modules wired through `src/index.ts`; no OpenChamber source modifications.

- [x] Run `npm run build`, `npm test`, and strict test type-check; full fake suite is green.
- [ ] Run the full opt-in live E2E only when the OpenCode baseline responds and the chosen billing path is authorized. Current `opencode models`/`provider.list` hangs even in an empty project, so no PAYG E2E, clean-profile install, or OpenCode bridge smoke was run. No rewind/fork test is run until #20's runtime gate passes.
- [x] Resolve conditional approval UI gate: unsupported choices and structured input are unavailable and fail closed; no generic permission mapping was implemented.
- [ ] Verify an exact no-subscription billing response remains actionable; no auth/billing probe was sent. Source audit confirms no Muse credential/config path reads; preserve CLI stderr secrecy.
- [x] `npm pack --dry-run --json` lists the expected README, package metadata, and compiled `dist/` (34 files); clean OpenCode-profile install is blocked by the CLI baseline above.
- [x] Update README with pre-release status, manual `muse login`, supported direct-MSP inputs, gated UI behavior, workspace locking, and rewind/file-restore limitation.
- [ ] Re-verify the ToS position before public release or package publication; no release/publication is being performed in this task.
- [x] Record pinned versions, schema fingerprints, probe outcomes, and limitations in `docs/compatibility.md`.
- [ ] Perform the final adversarial review before release.

## Execution Stop Conditions

- Task 2 correlation failure: do not begin Tasks 8–12 on the in-process architecture; revise to local proxy first.
- Task 4 non-durable sessions or failed cursor replay: do not promise restart resume; revise v1 scope and recovery wording.
- Task 5 UI cannot represent Muse approvals: keep approvals unavailable in v1; do not weaken Muse policy.
- Any target-schema mismatch affecting command IDs, fork boundaries, usage, terminal events, media parts/uploads, or structured-output controls: revise this plan and design before implementing the affected task.
- No PAYG key: unit/fake-MSP work can proceed after gates that do not need inference; defer live turn/approval confirmation and do not claim it passed.
