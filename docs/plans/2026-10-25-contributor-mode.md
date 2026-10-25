# #29 Contributor mode — plan (2026-10-25)

## Background

Per [muse-code-sdk#102](https://github.com/meta-models/muse-code-sdk/issues/102)
(still open), only the `muse serve --contributor-mode` launch flag selects the
Contributor billing lane: `settings.json`, env vars, and `-contributor` model
ids are all billed Standard silently. The bridge spawns `serve` with no such
flag, so every turn bills Standard, always — while contributor rows rotate in
and out of the live catalog, inviting selection under false billing premises.

Verified 2026-10-25 on Muse 1.4.13: `muse serve --help` lists
`--contributor-mode <on|off>`, "per-process contributor mode override (this
host only; never persisted)". The TUI passes it explicitly; bare `serve`
bills Standard. Matching the TUI is the goal, not exceeding it.

Decision (user-approved direction): one `serve` host per OpenCode session, as
today. Default `--contributor-mode on`; explicit opt-out respawns the host
with the flag off. Two concurrent hosts (one per lane) are rejected: they
would double the workspace-lock and lifecycle surface (#25) and split session
state across lanes.

## Hard gates (stop and revise if any fails)

1. **Config channel (resolved 2026-10-25).** Probed on OpenCode 2.1.4 with a
   scratch plugin dumping `ctx`: object-form entries load but `options`
   arrives as `{}`; directory-form entries did not load at all. The
   SDK-typed `ctx.options` channel is therefore unconfirmed, so the opt-out
   reads `ctx.options?.contributorMode` first but treats the namespaced env
   var (`OPENCODE_MUSE_CONTRIBUTOR_MODE`) as the reliable channel. If a
   future OpenCode forwards plugin options, the code already honors them.
2. **Flag capability check.** Parse the flag's presence from `muse serve --help`
   (or the exported schema) at spawn. A future CLI without the flag fails
   closed with a clear error; it must never degrade to silent Standard billing.
3. **Billing approval.** Every billing-affecting default stays explicit: README
   prominence plus a setup log line stating the lane requested. No silent
   default change, per standing rules.

## Slice 1 — neutralize the trap (safe, no billing effect)

True under every configuration until slice 2 lands: all turns bill Standard.

- README + setup log state plainly that every row bills Standard via this
  plugin until Contributor opt-in ships.
- No model-id sniffing (`-contributor` substring matching will rot as rows
  rotate, and the issue forbids inferring the lane from ids). A global
  statement, not per-row labels.
- Fully testable with fakes (log assertion, README lint if one exists).

## Slice 2 — default-on Contributor with explicit opt-out

- **Spawn:** both spawn sites (`fetchMuseCatalog` in `src/provider.ts` and the
  session host in `src/session/manager.ts`) take the lane from one resolved
  setting: explicit config wins; otherwise default `on`.
- **PAYG is out of scope (decided 2026-10-25):** opencode-muse is
  subscription-only. Official PAYG goes through OpenCode's OpenAI-compatible
  provider (`metamate`), not this plugin. If `META_API_KEY` is present the
  plugin logs a loud setup warning pointing at the official PAYG path and
  proceeds unchanged — presence-checked only, the value is never read. No
  Contributor×PAYG matrix is supported or probed.

- **Effective at next host start (decided 2026-10-25):** the lane resolves
  once per setup and rides every serve spawn after that. Changing it
  requires a plugin reload (OpenCode restart); there is no mid-session
  toggle surface, so no drain/respawn machinery is needed. Document this;
  never switch lanes under a live turn by other means.
- **No-entitlement failure:** if the account lacks Contributor access, flagged
  turns must surface a clear error. Silent fallback to Standard billing is the
  same trap in reverse and is forbidden.
- **Wording trap:** any UI/log may only claim the *requested* lane (from our
  spawn args), never a server-confirmed lane — Meta exposes no lane signal
  (#102 dependency). Only `muse usage` percentages count as billing evidence.

## Verification

- TDD with fake MSP hosts: spawn-args assertions for default/explicit
  on/off, capability-missing failure, toggle-during-active-turn denial, and
  cursor-based reattach after respawn.
- Full gates before commit: package build, tests, strict type-check.
- Live billing verification is the user's job from another shell
  (`muse usage` before/after), since PAYG/flag toggling is off-limits in the
  dev session. Slice 2 ships only after that observed confirmation — same
  rule as #28's TUI check.

## Out of scope

- Per-session billing lanes (the SDK exposes none; #102 dependency).
- Toggling the user's account-side Contributor setting (forbidden; the plugin
  only passes the per-process flag, which is never persisted).
- Reading `META_API_KEY` values or `~/.config/muse` (standing invariant).
