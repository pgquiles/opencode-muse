# opencode-muse — Design

**Status:** working v1.4 · 2026-10-22 (v1.3 approved baseline; compatibility findings incorporated; user approved continuing without rewind/fork, deferred to #20)
**Decision basis:** spike issue [#1](https://github.com/pgquiles/opencode-muse/issues/1) (probe record: Q1 verdict, close-out, smoke-test comment). Companion context: TheStreamCode/opencode-muse-auth#12 (compliance concern that motivates this design).

---

## 1. Goal and non-goals

**Goal.** Let OpenChamber (an IDE wrapping OpenCode) use a Muse Code subscription through a new OpenCode plugin, `opencode-muse`. The plugin drives `muse serve` (MSP — Muse's JSON-RPC session protocol, spoken through the `@muse-code/sdk` npm client): auth and inference stay inside the Muse CLI. OpenCode's model seam receives a custom `LanguageModelV3` implementation; Muse's CLI runs its own agent loop and tools.

**Non-goals (this phase).**
- No changes to OpenChamber source. Plugin-registered providers surface in OpenChamber automatically.
- Never extract, cache, or inject the subscription credential into OpenCode. The plugin never reads `~/.config/muse` contents (not even auth metadata — see §2).
- Not a replacement for the existing direct-API providers (pay-as-you-go `META_API_KEY` works today, documented by Meta).

## 2. Compliance invariants (design-wide, tested in review)

1. The plugin talks to Muse **only** through the `muse` CLI (host process over stdio JSON-RPC). No direct calls to Meta endpoints using any credential the CLI holds.
2. The plugin **never parses or copies** `~/.config/muse/auth.json` or settings files — not even "safe" metadata fields (`subs_active`, `mechanism`, `user_email` live in the same JSON as the `access_token`, so field-level access is not enforceable: parsing the file loads the tokens into plugin memory, and one stray log line or error serializer becomes a leak). State is inferred exclusively from wire-level surfaces (handshake result, session/list, typed turn failures, CLI exit codes). If identity display is ever wanted, the sanctioned route is MSP `account/read` under the experimental capability flag — negotiated and typed, never file parsing.
3. `muse login` remains the user's action; the plugin only relays its output (device code + instructions).
4. Before public release, re-verify ToS position (§3.2/§13.4 cited in opencode-muse-auth#12) for "integration through the CLI as a client".

**Trust boundary (documented, not ours to solve).** OpenCode's plugin model is the trust boundary: any project plugin can spawn `muse serve` or register hooks for the `muse` provider id. This design guarantees only *this plugin's* behavior; it cannot and does not claim to protect the user from other plugins.

## 3. Verified runtime foundations

Evidence below includes the live spike/smoke test, source inspection, and vendored MSP declarations. Treat schema-derived details as provisional until checked against the pinned CLI version (see §14).

| Foundation | Evidence |
| --- | --- |
| `aisdk.hook("sdk" \| "language")` seam works for user plugins | Smoke test on OpenCode 2.1.1: provider `seam-smoke/echo` served a hand-rolled `LanguageModelV3`; run rendered its text, exit 0. Separate correlation probe passes on 2.1.2. |
| OpenCode 2.1.2 session request metadata reaches in-process V3 `doStream` | Probe `test/probes/correlation-run.sh`: two overlapping sessions, title/primary/generate/compaction kinds, matching sanitized hook/call signatures; profile is not a direct `request.model` field and is resolved from catalog selection |
| Session-scoped `session.generate` uses `kind="generate"` but does not mutate OpenCode message history | Same probe: before/after message listings identical; do not forward as a normal live Muse turn |
| Muse 1.4.11 echo host reports durable sessions; same-command `turn/start` retry returns the same turn; cursor replay and reconnect resume each replay one terminal | `test/probes/msp-lifecycle.ts` on an isolated echo host; no Meta inference, no text deltas, zero usage |
| Muse 1.4.11 Meta live turn emits `userMessage` and `agentMessage` start/completion and session usage; no `item/delta` or `turn/completed.usage` observed | Two subscription-backed `test/probes/msp-lifecycle.ts` runs; logging omitted prompt/generated text; Contributor mode unchanged |
| Muse 1.4.11 Meta accepts an inline 16×16 PNG and a 1-second MP4 in one turn; one-chunk `media/upload` returns the same receipt and turn completes | `test/probes/msp-media.ts`; payload and generated text not logged; semantic media recognition not asserted |
| Muse 1.4.11/Linux runtime behavior on tested sessions | Echo `session/fork` failed with `file birth time is unavailable`; `session/rename` failed with `session naming is unavailable` despite the granted capability; rewind/fork is blocked on this target |
| Hook path engages **only** if the provider's `package` starts with `aisdk:` | Same smoke test: plain packages bypass hooks entirely |
| No npm needed at plugin load: `aisdk:file://<module-url>` + a `create*` export lets the bundled dynamic-provider plugin build the SDK host object from the plugin module itself | Smoke test log: `createSeamSmoke called → sdk hook → language hook → doStream` |
| OpenCode forwards its full builtin toolset (18 tools) into `doStream` params; a model that ignores them suppresses OpenCode tools **without any OpenCode-side config** | Smoke test: `forwarded-opencode-tools=18` |
| Meta-request classes (title generation, compaction) arrive as ordinary model calls; OpenCode rejects tool calls during summary generation | Listener capture of the `/title-gen` system prompt; opencode-cursor `request-classifier.ts` precedent |
| Muse 1.4.11 has **no** client-side tool-disable knob (muse always advertises its 26-member `muse` toolset) | Probe Q1 (#1, fake-provider harness) |
| `model/list` (stable) returns a source-tagged catalog with effort variants | Q8 probe plus `test/probes/msp-catalog.ts` on Muse 1.4.11/Linux returned a Meta provider catalog (profile `tbh`, three rows); no inference turn was sent |
| Failures are typed on the wire: `turn/completed` with `terminal="failed"`, `error.kind`, `retryable`; host exit 3 = credentials | Probes Q7 + live 402 |
| Meta-request precedent: opencode-claude (`request-kind.ts`, `session-store.ts`) and opencode-cursor (`request-classifier.ts`) both detect title/summary requests and serve them off the live session | Source inspection |
| OpenCode plugin context offers `permission.create`/`reply` (`allow\|deny\|ask`) and `session.synthetic` | Type inspection (#1 close-out) |
| OpenCode removes providers with **zero models** from `provider.list()` (hides them in OpenChamber) | opencode-cursor `fallback-catalog.ts` (comment) |
| Stable-MSP surface audit: `userInput/*` family, `session/rename`, `session/sideChat`, `turn/retryScheduled`/`retracted`/`unqueued` exist; `session/promptHint` is **experimental-only** and a read-only table query; no `session/delete` exists | Vendored `msp.d.ts` inspection (stable + experimental bundles) |
| `session/fork` without `cutPoint` copies all completed turns; explicit `cutPoint.lastTurnId` is needed to cut history | Muse 1.4.11 stable schema export; runtime fork call fails on the tested Linux echo session, so schema alone is not evidence of usable rewind |
| `session/tokenUsage.cumulative` is a running session total; `turn/completed.usage` is the optional per-turn aggregate | Muse 1.4.11 stable schema export; live Meta probe reported session usage but omitted terminal per-turn usage, so the bridge must not fabricate it |
| `turn/unqueued` means a queued turn was reclaimed before launch; `turn/started` signals launch | Muse 1.4.11 stable schema export; live queue/cancel/interrupt behavior remains unprobed |
| `session/sideChat` requires a source session; its new side session opens empty | Vendored stable schema; not a stateless generation API |
| The pinned `TurnInputPartType` includes `text`, `image`, `video`, and `skill`; image uses base64/media type, video uses a `media/upload` receipt; no direct `audio` or `pdf` turn part appears | Muse 1.4.11 stable schema export; one combined image/video turn passed through Meta `muse serve`; alternate audio/PDF paths remain unverified |
| Meta Model API model support for image/audio/video or structured JSON does not by itself prove the same feature is exposed through `muse serve`/MSP | Official [model capabilities](https://dev.meta.ai/docs/models) and [structured output guide](https://dev.meta.ai/docs/cookbook/structured-output); protocol requires separate verification |
| `view/subscribe` can replay notifications after an observed cursor; `view/gap` signals a missed range | Vendored stable schema; re-verify against the pinned Muse CLI schema before implementation |
| Durable MSP command methods that define `commandId` use UUIDv7 idempotency handles; each `media/upload` chunk has both `commandId` and shared `uploadId`; `view/subscribe` is cursor-only | Vendored stable schema; do not invent command IDs for methods that omit them |
| A session can be durable or ephemeral | Vendored stable schema; restart-resume must verify durable mode at runtime |

## 4. Architecture overview

```
OpenChamber ── spawns ──> opencode serve (2.1.2 target; prior smoke on 2.1.1)
                             │  loads plugins (.opencode/plugins or config "plugin")
                             ▼
                      opencode-muse plugin (this repo)
                             │
        ┌────────────────────┼─────────────────────────────┐
        │                    │                             │
  provider.transform    aisdk.hook("language")      session/permission hooks
  registers provider    supplies LanguageModelV3    approvals + narration
  "muse" + models       bridge per model+variant
        │                    │                             │
        └──────────┬─────────┴──────────────┬──────────────┘
                   ▼                        ▼
          muse session registry      MSP client (@muse-code/sdk)
          (OpenCode session ↔        spawns `muse serve --provider meta`
           muse session map)         one host per OpenCode session in v1
                                      session/start · turn/start · item/* ·
                                      approval/* · turn/cancel …
```

One architecture, two planes:

- **Model plane** (per model call): `LanguageModelV3` ⇄ MSP turn lifecycle. Stateless from OpenCode's perspective; muse holds the conversation.
- **Session plane** (per session lifecycle): mapping, one host per OpenCode session, cursor-based resume, approvals.

## 5. Plugin surface and registration

**Entry:** npm package `opencode-muse`, v2 plugin shape `{ id, setup(ctx) }` (consumed via config `"plugin": ["opencode-muse"]`). The same module bundle must also expose a provider *package* factory for the bundled dynamic plugin (§5.2).

### 5.1 Provider registration

```ts
await ctx.provider.transform((providers) => {
  providers.add({
    info: {
      id: "muse",
      name: "Muse Code",
      activation: "enabled",
      // Route model construction through the hook system: the "aisdk:"
      // specifier is what OpenCode's model resolver keys on. Point it at
      // THIS module so the dynamic provider plugin imports it locally.
      package: `aisdk:${import.meta.url}`,   // aisdk:file:///…/dist/index.js
      settings: { /* carrier only; hooks ignore it */ },
    },
    models: buildCatalog(currentCatalog()),  // §8
  });
});
```

- `import.meta.url` works both when loaded from `.opencode/plugins/` (dev) and from the npm cache (`~/.cache/opencode/npm/...`) — no hardcoded paths, no npm fetch for the SDK package.
- Fallback registration if the `file://` factory trick regresses in a future OpenCode: `package: "aisdk:@ai-sdk/openai-compatible"` (real published package; the bundled dynamic plugin installs it from the registry — proven to reach the registry in probes) plus the plugin's own `language` hook replacing the model in place. Last-resort fallback: opencode-claude-style local proxy.
- The `sdk` hook fills in only when absent; the `language` hook **always** provides the muse bridge for `providerID === "muse"`:

```ts
await ctx.aisdk.hook("language", async (input) => {
  if (input.model.providerID !== "muse") return;
  input.language = getBridge(input.model);           // §6
}, { providerID: "muse" });
```

### 5.2 The `create*` export (SDK-package role of the same module)

```ts
export function createMuse(options) {
  // Called by the bundled dynamic provider plugin BEFORE this plugin's sdk
  // hook runs (proven ordering). Return a stand-in host object; the real
  // model is supplied by the language hook below.
  return {
    languageModel: () => {
      // Reached only if the language hook did NOT replace us — i.e. the
      // hook seam regressed. Throw a named drift diagnostic rather than a
      // mystery TypeError: this is the seam-regression tripwire.
      throw new Error(
        "opencode-muse: language hook did not engage (OpenCode seam drift?)",
      );
    },
  };
}
```

The dynamic plugin expects a `model()`-less factory that yields an SDK host; our `language` hook replaces the eventual `LanguageModelV3` before construction, so `languageModel()` is never called in a healthy run — its throw is the named tripwire for seam regression (distinct from §5.1's fallback registration, which handles the same failure by another route).

## 6. The language bridge — `LanguageModelV3` over MSP

One bridge object per selected model/variant, with session-scoped routing metadata from the correlation carrier. `doStream` and `doGenerate` share one Muse transaction and event mapper; `doGenerate` does not start a second turn. The per-OpenCode-session manager owns one Muse host/session, persists mapping and turn metadata, and acquires the workspace lock for each call.

**Request correlation (hard Phase-1 gate).** `doStream` gets the prompt and tool definitions, not a typed OpenCode session context. The `session.hook("model.request")` layer stamps namespaced headers with `{sessionID, directory, kind, modelID, providerID, variant}`; the V3 bridge must read them from call options. The pinned OpenCode 2.1.2 probe passed for two concurrent sessions and `title`/`primary` calls: session ID, directory, kind, model/provider ID, and variant survived into `doStream`. It did **not** expose a direct `profileID` property on `request.model`; resolve the Muse profile from the selected catalog/model mapping. The same probe observed session-scoped `session.generate` calls with kind `generate` and a session ID; the OpenCode transcript remained unchanged. Stateless `/api/experimental/generate` was not reachable through the project-local provider and remains unsupported in v1. Tested paths invoked `doStream`, not `doGenerate`; retain a separate compatibility probe for any session-associated `doGenerate` path. If session-associated correlation is incomplete or racy, stop and use the local-proxy architecture, where headers are explicit. Never infer the active session by “most recent request” or a global mutable variable; concurrent title/compaction/agent calls make that racy.

Stateless `/api/experimental/generate` is a special case: OpenCode's session hook may not run. V1 does not claim general stateless generation support (§6.1); title/compaction are recognized by tested prompt-shape detection when hook metadata is absent.

### 6.1 Request-kind routing (decided)

OpenCode makes model calls of different kinds. Use `kind` from the session hook when it ran; for unhooked requests, use narrow, tested prompt-shape detection for title/compaction. Unknown stateless requests are not silently treated as agent turns.

| OpenCode request kind | Handling | Muse calls |
| --- | --- | --- |
| `title` (thread title) | **Local, zero model calls.** Derive a short title from the first user message only if present; otherwise return a safe generic title. Verify request shape; never route it into the live Muse session. | none |
| `compaction` (summary) | **Local, zero model calls.** Produce a bounded deterministic summary from the messages carried by the compaction request itself; no transcript mirror required. Must not emit tool calls. | none |
| `generate` (stateless one-shot, `/api/experimental/generate`) | **Not supported in v1**, except recognized title/compaction requests. Return a clear unsupported-operation error for other stateless requests. Do not use `session/sideChat`: it requires a source session and is not a stateless generation API. | none |
| `session.generate` (session-scoped one-shot, `/api/session/:sessionID/generate`) | **Not supported in v1.** The pinned OpenCode probe shows it reaches the session hook with `kind="generate"` and a session ID, but leaves OpenCode history unchanged. Do not send it as a normal turn to the authoritative Muse session; add only if a non-mutating Muse route preserves required context. | none |
| default (agent turn) | **Muse turn** on the mapped muse session (§7); serialize per session and honor `turn/start.disposition` | `turn/start` (or an explicit, user-originated `turn/steer`) |

Rationale: a Muse turn generated about 13 internal model calls in one probe (§14); that is not a 13× token-cost claim, but it makes avoidable Muse turns costly. Title/compaction do not benefit from Muse's context because Muse owns the authoritative conversation.

**What "local" means (compaction).** The summary is written by plugin code running inside the `opencode` process — deterministic, zero model calls of any kind (no muse turn, no other OpenCode model). It is entirely separate from muse's own context management (`session/compact`), which muse applies to its authoritative session independently and is untouched by this path.

**Why answer compaction locally at all** — muse never consumes the result (the bridge sends only *new* user content each turn), but the call isn't optional for OpenCode: when compaction fires, something must come back successfully. The options considered:

| Option | Outcome |
| --- | --- |
| Forward to the live muse session | The summarization prompt and answer land in Muse's history, polluting the real conversation and consuming an unnecessary Muse turn |
| Route to a scratch muse session | Real LLM summary, no pollution — but consumes a Muse turn for output Muse will never read |
| Fail the request | OpenCode's compaction step errors (surfaced to the user, possibly retried) and its transcript grows unbounded |
| **Answer locally (chosen)** | Step succeeds, costs nothing, no side effects anywhere |

**What the local summary is for** — bookkeeping for the projection only: (1) OpenCode's compaction step completes cleanly; (2) the transcript OpenCode/OpenChamber holds and renders stays bounded in long sessions; (3) portability — if a session is later moved to another provider, that provider *does* receive the transcript; (4) OpenCode features that read session history (subagent flows, export) operate on the trimmed transcript. Heuristic quality is acceptable precisely because the real context lives in muse.

**V1 compaction algorithm.** Do not call this a semantic synthesis. Emit a labelled, deterministic bounded transcript digest: preserve the initial user request and the most recent complete user/assistant exchanges; include a constraint or decision only when its words are actually retained, never infer one. Omit tool definitions and repetitive system boilerplate. Truncate at message/part boundaries where possible and include an explicit truncation note. The current deterministic implementation caps output by codepoint count using `maxOutputTokens` as a conservative character budget plus a hard character ceiling; it does not have the provider tokenizer, so this is a size guard rather than a token-count guarantee. If even the minimum labels cannot fit, return a clear compaction error rather than unbounded output. This is intentionally lower quality than an LLM summary, so test long, tool-heavy, multilingual and repeated-compaction histories and label it as a transcript digest in the output.

**Compaction must not read as rewind (§7).** After the complete compaction response succeeds, persist a candidate fingerprint of the exact summary output—never the raw summary text. Do not advance the committed fingerprint ledger merely because the plugin began returning a response. On the next model request, confirm that output fingerprint appears in the transcript, then commit the new fingerprint/compaction boundary. If the response was cancelled, not persisted, or the next transcript does not match, do not suppress rewind detection. Compare the retained sequence of message fingerprints (not only message count) so edits at the same count are detected. A visible text marker may aid diagnosis but is not authoritative; user-editable text can imitate it.

### 6.2 Touching muse: the turn protocol

For an agent-kind call the bridge:

1. **Resolve the muse session** for the correlated OpenCode session (§6 correlation; §7). On first use, call `session/start` with the selected `providerId`, `modelId`, `workspaceRoot` and `approvalMode: "onRequest"` (if confirmed by the pinned CLI schema). A non-sensitive `session/rename` label is best-effort only: Muse 1.4.11/Linux granted `sessionRename` but returned an internal “session naming is unavailable” error, so continue without a custom label for that specific runtime response and never use the user's first prompt. For MSP methods whose schema defines a UUIDv7 `commandId`, persist/reuse it for an exact retry; each `media/upload` chunk also has its own command ID and a shared upload ID.
2. Apply the OpenCode selection before the turn: if it differs from the Muse session selection, call `session/setModel` with the full selected provider/model/profile and a `commandId`. `session/start` has no profile selection field in the pinned schema, so apply a non-default profile with `session/setModel` immediately after start. Map the selected effort variant to `turn/start.reasoningEffort` (per-turn override); do not change the standing session default unless the user explicitly changes that default.
3. Build the input from the new user request plus the explicit host-context allowlist in §6.4. Never replay the entire OpenCode transcript as a new Muse turn.
   - user text → MSP text input items; file paths remain text unless file content is explicitly present in the allowed prompt context. V1 has no implicit file-upload or file-content injection path;
   - system/agent/project context → only the curated, labelled context defined in §6.4; `session/promptHint` is not a context channel;
   - image parts → map supported in-memory image data to MSP `type:"image"` with `base64Data` and `mediaType` (dimensions when available). Do not fetch arbitrary remote URLs; if a prompt contains only an unsupported remote reference, return a precise bridge-input error.
   - video parts → upload via MSP `media/upload` chunks, each with its own persisted/reused UUIDv7 `commandId` and the same client-minted `uploadId`; then send `type:"video"` with the receipt. Test chunk ordering, retries, size, cancellation, and errors; do not reject merely because upload plumbing is required.
   - audio and PDF parts → probe for a supported `muse serve`/MSP or official CLI path. The current vendored turn schema has no direct audio/PDF part; if no supported route exists in the pinned CLI, report that specific bridge limitation rather than claiming the model lacks the capability. File paths in the workspace remain ordinary text and Muse may use its own workspace tools to read them.
4. `session/start` and `session/resume` attach the connection to the session view automatically at the returned `viewCursor`; persist that cursor and consume notifications in cursor order. Do not send a redundant `view/subscribe` on initial attach. For recovery from an older persisted cursor or after `view/unsubscribe`, explicitly call `view/subscribe({sessionId, after:lastPersistedCursor})` to replay the missed range before live events; handle `view/gap` via `view/page` (§7).
5. Call `turn/start`, inspect its `disposition` and authoritative `turnId`, then translate the view stream into V3 stream parts. The V3 response finishes at `turn/foregroundCompleted`; the session monitor continues draining through `turn/completed` before clearing the active-turn marker or releasing the workspace lock. If no foreground terminal is produced, finish at `turn/completed`:

| Muse event | Bridge → V3 part |
| --- | --- |
| Stream begins | `stream-start {warnings:[]}` |
| `item/started` (assistant text) | `text-start {id}` |
| `item/delta` (text) | `text-delta {id, delta}` |
| `item/completed` (assistant text) | `text-end {id}`; reconcile a missing authoritative suffix, but fail safely if completed text contradicts text already streamed |
| reasoning item deltas (if muse emits them) | `reasoning-start/delta/end` (build-time probe) |
| `item/…` (tool/file events) | **not** model output → narration path (§9) |
| `session/tokenUsage` (notification) | cumulative member is a session snapshot—never sum snapshots. For provisional foreground usage, count each per-call `promptTokens`/`totalTokens` and output/reasoning counter once per exact notification, keyed by opaque view cursor plus canonical method/params identity; prefer the aggregate at `turn/completed.usage` when present, otherwise keep the deduplicated per-call total. If neither reports usage, pass unknown counters rather than inventing zeroes. |
| `turn/completed` terminal `completed` | `finish { finishReason:{unified:"stop"}, usage }`, using this event's per-turn aggregate usage |
| `turn/completed` terminal `failed` | if streaming already began, emit the V3 `{type:"error", error}` part with a safe typed error and close; if failure precedes stream creation, reject `doStream`/`doGenerate`. Preserve Muse `error.kind` and `retryable`; map only verified billing/auth failures to actionable UI text (§11) |
| `turn/completed` terminal `cancelled` | `finish { finishReason:{unified:"other"} }`; unknown future terminal values are surfaced without guessing |
| `turn/retryScheduled` / `turn/modelRetryScheduled` | keep the stream open (the turn is still in flight); narrate a retry note |
| `turn/started` | mark the accepted turn as running; match by returned `turnId` |
| `turn/unqueued` | the queued turn was reclaimed before launch; resolve that OpenCode request as cancelled/retracted, not as started |
| `turn/retracted` | end the stream with `finish { finishReason:{unified:"other"} }` |
| `turn/foregroundCompleted` | finish the OpenCode V3 response here (foreground answer is ready); keep the Muse view monitor, host, and workspace lock until `turn/completed`. Report usage known at foreground completion; reconcile final aggregate usage/terminal status in the registry. |

If `turn/foregroundCompleted` already closed the OpenCode response, a later `turn/completed` is session-monitor state only; never emit a second V3 finish. OpenCode's per-call usage may therefore be provisional when Muse continues background work. Persist the terminal cursor/active-turn transition before releasing the workspace lock; do not claim OpenCode's completed-call usage is final when Muse continues background work.

Wire-format facts verified in the smoke test (must hold for all emitted parts): `finishReason` is the **object form** (`{unified:"stop"}`) — string literals fail OpenCode's internal schema; `usage` uses **flat number keys** (`inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`) — not the nested V3-spec shape. The V3 adapter must implement both `doStream` and `doGenerate` through the same Muse transaction/collector, unless a Phase-1 probe proves a supported OpenCode path never calls `doGenerate`; no unexplained throw is acceptable.

6. **Abort/OpenCode cancel:** map the abortSignal to the appropriate Muse operation (`turn/cancel` or `turn/interrupt`) using the explicit active `turnId`; distinguish reclaiming a queued turn via `turn/unqueue`. Probe terminal/event ordering. A pending approval is resolved or the exact Muse turn is interrupted; do not kill a host that might own another session.

### 6.3 “Suppression” invariant (test)

The bridge never emits OpenCode `tool-input-start`/`tool-call` parts. OpenCode's tool definitions stay registered and are forwarded into `doStream` params, but Muse's native agent loop owns execution. Do not fail merely because the tool list is non-empty. If OpenCode explicitly requires a particular OpenCode-side tool call that the Muse bridge cannot perform, return a precise unsupported-operation error; do not pretend Muse's differently scoped native tool is equivalent. For strict JSON/structured-output options, probe for an MSP/CLI setting and map it if available; if the caller requires a schema guarantee and the pinned bridge has no such setting, fail that strict mode only. A user asking for JSON in ordinary text remains a normal Muse prompt. V1 reports but does not apply sampling options that `turn/start` cannot represent: `maxOutputTokens`, `temperature`, `topP`, `topK`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, `seed`, and provider options; logs contain option names only, never their values. Test in CI once Muse is live: a full agent turn must generate **zero** OpenCode tool calls and **zero** OpenCode permission prompts for tools.

### 6.4 OpenCode context contract

Do not forward OpenCode's entire system prompt or tool catalog: it can describe tools that Muse cannot call and may conflict with Muse's own agent instructions. V1 forwards the new user request and an explicitly allowlisted custom-agent preamble: the `session.context` hook isolates the custom prompt before OpenCode's `# Your Model` boundary and labels it `OpenCode agent instructions`. Stock built-in prompts and Code Mode/skills catalogs are not copied; Muse runs in the same workspace and is expected to load project rules itself where supported. Other OpenCode host-only system context that cannot be safely separated is not represented in v1 and must not be claimed as preserved. If an unknown custom agent layout cannot be separated from host boilerplate, fail before `turn/start` with a clear unsupported-agent-context error rather than silently dropping it. Do not claim OpenCode tool access.

## 7. Session management

**Registry.** `session-store` (opencode-claude pattern): OpenCode sessionID → `{ museSessionID, hostID, workspaceFingerprint, rev, transcriptFingerprints, compactionFingerprints, viewCursor, activeTurnId, pendingCommands }`. Fingerprint the ordered visible user/assistant transcript by role, part type, and normalized-content hash; exclude volatile system boilerplate, tool definitions, and request settings. `compactionFingerprints` holds only the pending exact-summary output hash; commit the new transcript baseline and clear it only after a later prompt observes that exact summary and its Muse turn completes. Keep hashes and message/turn boundary references only, never prompt text. OpenCode sessions are the user-facing keys; Muse sessions are durable in the user's Muse home. The working v1.4 implementation stores one versioned entry per SHA-256-hashed OpenCode session ID under the OpenCode/Muse plugin state directory: `$XDG_DATA_HOME/opencode-muse` (default `~/.local/share/opencode-muse`) or `%LOCALAPPDATA%\opencode-muse` on Windows. `sessions/` records are mode 0600 in mode-0700 directories, written by fsync + same-directory atomic rename; corrupt/unknown-version entries are quarantined and treated as a fresh session, never resumed. `locks/` uses atomic exclusive-create lock files keyed by workspace fingerprint; stale owners are reclaimed only after PID-death and owner-token rechecks under a short-lived recovery claim. A stale/corrupt recovery claim fails closed and requires operator cleanup after verifying its PID is gone. Persist only mapping/recovery metadata—not prompts, transcripts, compaction summaries, credentials, workspace paths, or raw CLI output. The lock is local-filesystem coordination, not a distributed lock for multi-machine shared storage.

**Host model (v1).** One `muse serve` child and one MSP connection per OpenCode session; that host owns that session's Muse session only. Spawn lazily on first Muse turn. Reap only when no turn, approval, user-input request, or replay is pending; also handle OpenCode interruption/failure events. This deliberately rejects a shared 1..N-session host pool in v1, so reaping one session cannot disrupt another. Set and test a bounded idle TTL and process-exit cleanup.

**Resume and event recovery.** Before relying on restart recovery, verify that `muse serve` creates durable sessions (inspect the returned session durability); an ephemeral session cannot satisfy this guarantee. On startup, load/reconcile registry entries; resume the Muse session only when the workspace fingerprint matches and the session is durable. `session/resume` reattaches the connection at its returned view head. To recover events after the older persisted cursor, explicitly call `view/subscribe` after that cursor; persist cursor advances atomically. On `view/gap`, use the schema-defined page/recovery path and reconcile the turn before continuing. Persist command IDs and request fingerprints, not prompt bodies. Retry only when the exact request payload can be deterministically reconstructed and the same `commandId` is reused. If acceptance/completion remains ambiguous, never automatically replay a potentially side-effecting turn: surface a recovery error and require user choice.

**Session naming & hygiene.** MSP has no `session/delete`, so abandoned/forked Muse sessions accumulate in the user's Muse home and may surface in `muse resume`. When the pinned runtime supports it, name plugin-created sessions via `session/rename` with a non-sensitive label (`opencode-muse <short session id>`), never the user's prompt or project path. On Muse 1.4.11/Linux the CLI grants the capability but the operation returns an internal “session naming is unavailable” error; continue without a custom label and report the limitation. Revisit if Muse grows a prune surface.

**Rewind / divergent history.** *Rewind* is the OpenCode/OpenChamber UI action that drops conversation history after a chosen point; fork keeps both branches. OpenCode truncates its transcript, while Muse still remembers the later turns. The bridge therefore keeps an ordered mapping from confirmed OpenCode agent-turn boundaries to Muse `turnId`s, plus sequence fingerprints and committed compaction boundaries.

```
user rewinds to message #3
        OpenCode transcript:  1 2 3 [4 5 dropped]      ← truncated
        muse session:         1 2 3 4 5 ...            ← still remembers everything
```

The bridge sends only new user input, so without intervention Muse would continue reasoning from discarded turns. Compare the incoming sequence against the last confirmed sequence: a prefix/tail divergence is a rewind even if message count is unchanged; an exact, previously committed compaction is not. Do not update the committed ledger until the compacted summary is observed in a later prompt (§6.1).
- **Policy:** when the rewind point maps to a completed Muse turn, call `session/fork` with an explicit `cutPoint.lastTurnId` for the last retained turn, then re-point the OpenCode session to the returned Muse session. Omitted `cutPoint` means all completed turns and is not a rewind. **This is not enabled on Muse 1.4.11/Linux:** the live `session/fork` call returned `-32603 internal: file birth time is unavailable`, including with an explicit cut point and a Git workspace whose relevant paths report birth times. Do not implement or advertise rewind/fork until Meta fixes the runtime or the probe passes on a supported target. Return a clear bridge-specific unsupported error rather than sending an uncut turn to the original Muse session.
- **Unmappable boundary:** v1 does not fabricate history by replaying old user text (which could trigger actions). If the retained OpenCode transcript cannot be mapped unambiguously to a completed Muse turn, stop with a clear message and ask the user to start a new Muse session.
- **OpenCode fork:** a new OpenCode session gets a separate Muse session. If the parent mapping and retained boundary are available, fork it at that mapped point; otherwise require a fresh session rather than sharing one Muse session or replaying an untrusted transcript as a new request.
- **Filesystem effects:** `session/fork` branches Muse conversation state only; it does not revert files Muse already changed. The plugin does not perform implicit file rollback. Verify and document OpenChamber's independent file-restore behavior; absent that, warn that rewind is conversation-only.

**Workspace concurrency:** v1 acquires a workspace-scoped lock before a Muse turn and releases it only after terminal completion/cancellation and pending approvals are settled. A second OpenCode session targeting the same workspace receives a clear busy error; it does not start a concurrent writer or wait invisibly. Handle stale locks on process death. The lock remains held after `turn/foregroundCompleted` until `turn/completed`, because Muse background work may continue.

## 8. Models and variants

From `model/list` (stable surface; the Muse 1.4.11 subscription probe returned three Meta models under profile `tbh`):

- `Model.Info` per Muse model: preserve `displayLabel`, context/output limits, release date, and known effort variants. OpenCode `Model.Info` has no `profileId`, `isActive`, or `isDefault` fields, so build a sidecar index keyed by the composite OpenCode model ID and retain those Muse values there; do not mis-map session activity into OpenCode `status`/`enabled`.
- Build a stable OpenCode model ID from profile + Muse model ID; set `modelID` to Muse's selectable `modelId` and `providerID` to `muse`. Resolve `providerId`, `profileId`, `defaultReasoningEffort`, `isActive`, and `isDefault` through the sidecar index. On initial Muse session start pass the selected model/provider/profile; on subsequent picker changes call `session/setModel`.
- Effort tiers (`minimal…max`, per-model subsets) → OpenCode **variants**. Pass the selected tier in `turn/start.reasoningEffort` for that turn; use `session/setReasoningEffort` only for an explicit persistent-default change. Hide/disable variants when the catalog says effort is unknown.
- **Fallback catalog (required, not optional).** OpenCode removes providers with **zero models** from `provider.list()`, hiding them in OpenChamber. Ship a clearly labeled, disabled `Muse setup required — run muse login, then refresh providers` placeholder. It is never runnable and is replaced only by live `model/list` rows. Live fallback visibility on OpenCode 2.1.2 remains unverified because the provider-list endpoint hangs even in an empty project.
- Catalog refresh: a short-lived, sessionless `muse serve --provider meta` host calls `model/list` during plugin setup, then closes; persistent turn hosts remain one per OpenCode session. Update the plugin's cached catalog first, then call `provider.reload()`; the fake integration test proves the ordering, but pinned OpenCode runtime reload behavior remains unverified. Retain the last good catalog if refresh fails.

## 9. Narration (muse tool/file activity → OpenCode transcript)

Muse runs its own tools (26-member `muse` namespace); OpenCode sees nothing unless we narrate.

- Bridge subscribes to muse `item/*` tool/file events and posts compact entries via `session.synthetic({sessionID, text, description, metadata})` — e.g. "muse: edited src/foo.ts (+12/−3)".
- Aggregate, don't spam: coalesce consecutive file-edit items per turn into one synthetic entry. V1 narration does not create OpenCode-native diffs or file-history entries. Verify whether OpenChamber independently detects and can restore Muse-written files; otherwise clearly disclose that its normal diff/undo/rewind affordances may not cover Muse's external file writes.
- Approval parking (§10) interleaves here: approval cards are permission requests, not narration.

## 10. Approvals bridge

Muse approves side-effectful actions on the wire (`approval/requested`, decisions via `approval/decide`; use the exact pinned-schema approval-mode spelling, expected `onRequest`).

`approval/requested` carries the actual `approvalId`, `currentRequirementId`, `availableChoices`, subject, tool/args, turn, and session. Retain this state while the Muse turn is parked. Surface a permission UI only after verifying it can present the offered choices and return a concrete user decision.

- Submit exactly an offered `choiceId`, its current `requirementId`, target `sessionId`, and a persisted UUIDv7 `commandId` via `approval/decide`. Handle `approval/updated` as a new stage/choice set and `approval/resolved` as terminal. Never reuse a stale requirement ID. `ctx.permission.create` is only a candidate UI channel: prove it can display the offered choice labels/scopes and return a specific selection; if it only supports generic allow/deny/ask, the approval bridge is not implementable through that UI and must fail closed or be deferred.
- Do not assume OpenCode's generic allow/deny/always vocabulary can represent Muse's dynamic choices. If the UI cannot faithfully express the available choices, fail closed with an explanation; do not invent choice IDs or substitute local policy.
- No plugin-side "always" cache or auto-allow matcher in v1. Persistent/always decisions are allowed only when Muse itself offers a matching choice and the UI clearly describes its scope.
- Default to the exact pinned-schema `onRequest` approval mode. No auto-approve setting in v1. Keep the host alive while approval is pending; closing the UI or timing out must explicitly deny/cancel/interrupt the corresponding Muse request, not silently reap the host.
- Approval UI must display a sanitized tool/subject/args summary. Do not place raw arguments or secrets in logs or persistent registry data.

**Structured user input is separate from permissions.** `userInput/requested` can contain multiple questions, selections, and free text; an allow/deny card cannot answer it. Phase 2 may implement this only if an OpenCode/OpenChamber UI surface can collect the full MSP answer schema. If no such UI is available, v1 does not claim support: interrupt the named prompt/turn with a clear explanation and never fabricate or infer user answers. Probe the exact `userInput/answer`/`cancel`/`interrupt` behavior and their required IDs before implementation.

## 11. Auth, state detection, and login UX

- **No config parsing.** The plugin never opens `~/.config/muse` (invariant §2): secrets and metadata share the file, and its schema is private/unstable. State comes only from a verified wire/CLI probe. Pin the exact logged-out sequence before implementing UX: host exit code 3 and the credentials error were observed, but whether that occurs at spawn, initialize, session/list, or the first auth-needing operation must be tested. Do not treat an empty `session/list` as proof of authentication.
  - Logged out → actionable "run `muse login`" state only after the probe confirms credentials are absent.
  - Logged in without subscription → map only the verified billing failure (`402 Billing verification failed`, `modelError`, non-retryable) to subscription/PAYG guidance. Do not label every `modelError` as a billing problem. `muse auth set --provider meta --api-key-stdin` and `META_API_KEY` priority are documented CLI paths; the plugin never reads or relays key values.
  - If identity display is ever needed, use `account/read` only behind negotiated experimental capability; it is not required for v1.
- **Sign-in integration method** (OpenCode integration domain, opencode-claude pattern): first prove the method appears in OpenChamber without source changes. Spawn `muse login` with the required TTY/stdio behavior, show device-code instructions to the user, and keep stdout/stderr ephemeral—never log raw output or surface unfiltered diagnostics that could contain secrets. Poll only a probe proven to distinguish login success from an empty local session list. Cancellation, timeout, and CLI-not-installed behavior must be explicit.
- Install detection: `muse` on PATH (+ `muse --version` fingerprint for the drift check, §14). Install instructions link to Meta's docs rather than auto-installing in MVP (official install channel still releases per-version archives — verify at build time).

## 12. OpenChamber consumption

- Provider/model visibility is expected from generic OpenCode plugin loading, but verify in the actual OpenChamber UI. Also verify that plugin integration/auth methods surface there; provider registration alone does not prove the sign-in UX is reachable. No OpenChamber source changes are in v1 scope; if the UI does not expose the needed method, v1 uses documented manual `muse login` instructions rather than promising an unavailable sign-in card.
- V1 does not promise OpenCode-native file diffs or undo for Muse writes; verify OpenChamber's independent filesystem detection/restore behavior and display the limitation if needed.
- **Phase 5 (optional, separate PRs in openchamber):** integrations-catalog entry (`packages/ui/src/lib/integrations-catalog/registry.ts`) and a quota panel adapter fed from muse `usage/read` (experimental surface — requires the experimental capability probe) or from narrated usage events. Not required for v1.

## 13. Phasing

0. **Foundations (done):** spike #1 and seam smoke test. Before bridge code, pin `muse schema` output/version and the OpenCode binary/runtime tested.
1. **Bridge MVP:** correlation-carrier probe first; model/effort routing; static catalog; session registry and command-ID idempotency; view subscribe/cursor replay; `doStream`/`doGenerate`; turn lifecycle/error mapping; local title/compaction; context allowlist; image mapping and video upload where confirmed by MSP; narrow audio/PDF/strict-JSON limitations only where no official bridge route exists; workspace lock; host/session lifecycle and best-effort naming. Gate: end-to-end authorized live Muse chat plus disconnect/restart recovery without duplicate turns or lost output. Rewind/fork remains excluded until the explicit-cut runtime probe passes.
2. **Approvals + narration:** exact offered-choice approval bridge and synthetic narration. Structured `userInput/*` only if UI feasibility and answer-shape probes pass; otherwise explicitly unsupported. Extend host lifetime handling for pending approvals/input.
3. **Auth UX:** verified login-state probe, safe sign-in relay, state guidance. Gate: integration method visible in OpenChamber or documented manual login fallback.
4. **Robustness:** mapped rewind/fork at explicit cut points only if the target-runtime gate passes; otherwise keep rewind unsupported. Also cancellation/steer semantics and usage display. File rollback remains out of scope unless a verified OpenChamber mechanism exists.
5. **OpenChamber polish:** catalog entry, quota panel (optional).

Confirmatory live probes (streaming, `doGenerate`, cancel, view replay/reconnect, resume, fork cut point, approval choice updates, and auth sequence) run only with the user's authorized Muse access through the official CLI (subscription-backed Contributor mode is preferred; configured PAYG is also valid). Do not change Contributor mode or inspect credential files. The echo provider is sufficient only for transport/idempotency/replay checks; it cannot replace inference, media, approval, or model-usage probes.

## 14. Risks and open questions

| Risk / question | Assessment | Mitigation |
| --- | --- | --- |
| `aisdk:` seam is invisible in public docs (reverse-engineered) | Real; package routing/order is version-sensitive | Pin OpenCode; run seam/correlation CI probes; local-proxy fallback is a deliberate architecture change, not assumed equivalent |
| Muse CLI/schema version drift | High until pinned against the supported binary; local declarations alone do not prove 1.4.11 behavior | Record `muse --version`, `muse schema` version/fingerprint, and SDK version; run contract probes against that exact binary |
| In-process correlation carrier | Core prerequisite, currently unverified | Hard Phase-1 gate; stop if session/directory/kind/model/variant do not arrive; use local proxy if needed |
| Stream loss / ambiguous turn after restart | Can lose output or duplicate file-changing work; exact request bodies are intentionally not persisted | Persist command IDs/request fingerprints/active turn/view cursor; replay via `view/subscribe`; same-ID retry only with exactly reconstructed payload; otherwise require user choice |
| Rewind-to-Muse turn mapping | OpenCode rewind boundaries may not map to completed Muse turns, and the tested Muse CLI cannot execute `session/fork` on Linux | Rewind stays unsupported until a runtime passes explicit `cutPoint.lastTurnId`; after that, fail clearly on ambiguous mappings and never replay old prompts as actions |
| Local compaction versus rewind | A failed/unpersisted summary can be mistaken for compaction | Commit ledger only after summary is observed in a later request; sequence fingerprints, not counts/marker alone |
| Muse `turn/foregroundCompleted` and background work | OpenCode's visible answer may be ready before Muse's terminal event and final usage | Finish the V3 stream at foreground completion, keep the session monitor/lock until terminal completion, and probe this exact split on the pinned CLI; report OpenCode usage as provisional |
| Local compaction size and fidelity | Deterministic digest is not semantic summarization; model tokenization/budget differs | Bound output using the request budget with a conservative margin; test repeated compaction and fail clearly if the minimum digest cannot fit |
| Model and effort routing | Missing `session/setModel` or wrong effort call would ignore OpenCode's selection | Route initial and changed selections; use `turn/start.reasoningEffort`; test each model/variant end to end |
| `doGenerate` use | Smoke test exercised streaming only | Probe OpenCode callers; implement shared generate/stream bridge or deliberately reject unsupported paths |
| Auth/login sequence and OpenChamber integration UI | `session/list` and auth-method visibility are unproven | Probe exact unauthenticated flow and confirm UI surfacing; provide manual `muse login` fallback |
| Approval UI cannot express Muse choice stages | Stale/incorrect decisions could authorize the wrong action | Use only current offered `choiceId` + `requirementId`; fail closed when UI cannot represent choices; no local persistent auto-allow |
| Structured Muse user input | Permission cards cannot represent multi-question answers | Defer unless UI collects the full schema; interrupt explicitly rather than fabricate answers |
| Workspace concurrency / external file edits | Agents may race; OpenCode may not track Muse writes for diff/undo | Workspace lock in v1; verify OpenChamber file detection/restore and disclose any gap |
| Model/API modality versus MSP modality | A model can support media/JSON in Meta Model API while `muse serve` exposes a narrower input surface | Map MSP image/video parts; probe audio/PDF and strict JSON; error only for unsupported bridge paths, not model capability |
| Session durability | MSP sessions may be durable or ephemeral depending on host configuration | Probe the `session/start` result on the pinned `muse serve`; only promise restart resume for durable sessions |
| Quota interpretation (~13 internal model calls observed once) | Call count is not a token/quota multiplier; token cost varies by call | Measure aggregate `turn/completed.usage`; do not infer 13× token cost |
| Experimental surfaces (`account/read`, `usage/read`) | Optional and may drift | Capability-gate; never make core chat depend on them |
| ToS re-verification before release | Legal/compliance gate remains open | Re-check the cited position before public release |

## 15. Decision log

| Date | Decision | Why |
| --- | --- | --- |
| 2026-10-20 | Shape B (muse-native agent) over Shape A (OpenCode-run tools) | No tool-disable knob in muse 1.4.11 (Q1); muse's system prompt is authoritative |
| 2026-10-20 | Language-model seam via `aisdk.hook("language")`, not provider config `npm` | `model.request` can't suppress OpenCode's own tools (they're forwarded to the model; Q11-turned-trivial) |
| 2026-10-20 | Plugin owns model implementation; needs no OpenCode-side tool suppression | Verified live: bridge ignoring 18 forwarded tools |
| 2026-10-21 | Title + compaction answered locally; stateless general `generate` is unsupported in v1 | Meta-requests do not benefit Muse's context; `session/sideChat` requires a source session and is not a stateless API |
| 2026-10-21 | Session-authoritative mapping; rewind forks at an explicit mapped Muse turn boundary | Omitted fork cut point copies all completed turns; unmappable boundaries fail clearly rather than replaying old prompts |
| 2026-10-21 | Never read `~/.config/muse`; state via wire surfaces + CLI help only | Compliance invariant §2 |
| 2026-10-21 | Use existing subscription-backed access for regular live probes; use PAYG only when the user has configured it through the official CLI | Never inspect or change auth state; do not alter Contributor mode |
| 2026-10-22 | Muse 1.4.11/Linux echo passes durable cursor replay/resume but explicit fork and rename operations return internal errors | `test/probes/msp-lifecycle.ts`; rewind/fork blocked pending a supported runtime, rename best-effort only |
| 2026-10-21 | Compaction ledger commits only after the generated summary is observed in a later prompt | Avoid classifying a cancelled/unpersisted summary as a real compaction |
| 2026-10-21 | Registry persists cursor, active turn, and idempotency state; one host per OpenCode session | Resume must not lose events or duplicate side-effecting turns |
| 2026-10-21 | Rewind uses explicit `cutPoint.lastTurnId`; no automatic transcript rehydration or file rollback | Avoid retaining discarded Muse context or re-running old prompts; filesystem effects are separate |
| 2026-10-21 | Approval decisions must use currently offered Muse choices; no plugin-side always cache | The Muse policy and current requirement stage remain authoritative |
| 2026-10-21 | Structured `userInput/*` is deferred unless a UI can collect its full answer schema | Permission UI cannot safely substitute for multi-question user input |
| 2026-10-21 | Capability-aware input handling: map MSP image/video; probe audio/PDF and strict JSON | Model/API features and the `muse serve` protocol are separate capability layers |
| 2026-10-21 | Model selection uses `session/setModel`; effort uses per-turn `turn/start.reasoningEffort` | The OpenCode picker must match Muse's actual route and selected variant |
| 2026-10-22 | Resolve Muse `profileId` from the selected catalog model, not a request hook field | OpenCode 2.1.2 probe exposed provider/model/variant but no direct profile property |
| 2026-10-22 | `session.generate` is unsupported in v1 unless a non-mutating Muse route is proven | OpenCode calls it with session context but promises not to mutate its history; a normal Muse turn would pollute the authoritative Muse session |
| 2026-10-24 | Warn, don't fail, on unknown served schema fingerprints; fail closed only on missing/malformed fingerprint or envelope version | SDK additive-optional evolution model; resolves #21 without lockstep SDK bumps |
| 2026-10-24 | Approval UX via verdict mapping, not choice display: onServerRequest → OpenCode permission.create → offered choice only (once→once approve, always→session approve, reject→reject; localPersistent never selected; exactly-one match required else fail closed; timeout/interrupt); sessions run approvalMode onRequest | Task 5's display-fidelity gate is superseded: the UI collects verdicts without ever showing Muse choice IDs; #22 approval slice |
| 2026-10-24 | Approval revision (implemented): AI SDK `tool-approval-request` boolean verdict → `selectApprovalChoiceId` (`src/msp/approvals.ts`): bare approve maps to the minimal once-scoped approve choice, session-scoped only as single fallback; deny prefers the once-scoped reject; localPersistent never selected; duplicate same-scope candidates or no match → null (fail closed with fresh-session guidance); OpenCode owns persistence so grants stay per-turn | Verdict never carries scope; per-turn grants keep Muse policy authoritative; plumbing via `MspHostOptions.onServerRequest` → `MspClient` → SDK `Connection.onServerRequest`; 13 mapping tests + 1 plumbing test green |
