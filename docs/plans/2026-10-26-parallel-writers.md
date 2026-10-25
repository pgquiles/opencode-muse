# #34 post-v1 parallel writers via per-session worktrees — plan (2026-10-26)

## Problem

The bridge allows one active writer per workspace: a second concurrent
turn on the same workspace fails with the workspace-busy error
(README Current limitations / Simultaneous work). Multi-session and
multi-pane use on one checkout serializes.

## Protocol facts (probed on Muse 1.4.13 schema export)

- `session/start` takes an experimental `worktree` param:
  `{mode: "create", baseRef?}` (omitted base means HEAD) or
  `{mode: "existing", path}`. Absent means today's behavior.
- `worktree/list` (experimental) reports every checkout of the
  repository — path, branch, main-checkout flag, and **live session
  ids** — explicitly so apps can warn on sharing.
- `session/start` already carries stable `workspaceRoot(s)`; the first
  root is the CWD.
- Peer coordination surface is experimental: `peer/list` rows carry
  `canReceive` (false for launch-excluded rows, definition unprobed)
  plus liveness; `admission/request` prompts with server-minted
  choices and `admission/decide` resolves them terminally —
  structurally identical to approvals/userInput, so bridge
  auto-decision for known peers follows the established pattern.
- No MSP verb **originates** a peer message. Sending is CLI-side
  (`session-message send`) or agent-initiated; bridge origination and
  sender attribution are unprobed.
- `muse serve` has no experimental flag; our hosts do not pass
  `--no-session-log`, so sessions are retained and in principle
  eligible for peering (docs exclude only memory-only sessions).
- Delivery semantics (official docs): steer-the-active-turn (default)
  and queue-for-next-turn reach the agent; notify-only stays out of
  model context.

## Flow (post-v1 sketch)

1. Each OpenCode session starts its Muse session with
   `worktree: {mode: "create"}` (or `{mode: "existing", path}` when
   the user points at one) instead of sharing the checkout.
2. `worktree/list` backs a sharing warning: two live sessions on one
   checkout reproduce today's busy behavior as a warning, not an
   error, where the protocol shows sharing is safe.
3. Peer claims (`peer/list` + admission auto-decide for known peers)
   coordinate who owns what; steer/queue messages carry claim and
   handoff notices between agents.
4. Read-only participants stay on the shared checkout — isolation is
   opt-in per writer, never a silent fallback (same rule Meta
   applies).
5. Merge policy (decided): the human merges through normal source
   control. The bridge never auto-merges; worktrees stay dirty until
   the user integrates.

## Non-negotiables

- Experimental surface is capability-probed per CLI build and
  strictly opt-in: if `worktree`/`peer`/`admission` are unadvertised,
  fall back to today's single-writer lock, never to a half-wired
  parallel mode.
- No silent isolation: a session must know it is on a worktree, and
  which one; the label rides the session the way lane and variant do.
- No auto-merge, no unattended conflict resolution. Dirty worktrees
  are the visible, expected end state.
- Non-git workspaces stay serialized — same constraint Meta imposes.
- Token multiplication is inherent (one full session per writer);
  README must state it, not hide it.

## Unknowns (resolve before/with implementation)

- Claim origination (RESOLVED 2026-10-25: bridge-mediated is the
  only path). No MSP send verb exists; `peer/list` grants but shows
  serve sessions zero peers; inbound CLI send fails
  `external_agent_ingress_closed` with nothing observed bridge-side.
  Claims ride our own lease protocol, not the peer plane.
- Admission auto-decision is moot: no admission request can reach a
  serve session, so there is nothing to decide.
- Experimental availability mechanics: how a build advertises the
  `worktree` surface (enablement: `capabilities.experimentalApi`
  plus trusted workspace — `workspaceNotTrusted` on untrusted paths),
  and how the fingerprint check treats it.
- Crash orphans: worktree cleanup on session close vs explicit user
  cleanup (same shape as the #33 retention decision; decide and
  write it down).
- Interplay with #20 (no filesystem rollback on rewind) and #23
  (event-gap recovery) inside worktree-scoped sessions.
- Remaining live probe: `session/start` with
  `worktree: {mode: "create"}` in a scratch repo.

## Verification

- Fake-host unit tests for the fallback matrix (unadvertised
  surface → single-writer lock; advertised → worktree start params,
  sharing warnings, admission auto-decide for known peers only).
- Live probes for every Unknown above on the pinned CLI before
  implementation; several are already banked in #34 comments.
- Full gates (build, tests, strict type-check) before commit.
- Post-v1 by definition: no v1 milestone may depend on this; the
  single-writer lock stays the supported path until this ships.
- Consumer verified 2026-10-25 (opencode 2.1.4): concurrent
  same-workspace sessions complete — core does not serialize; the
  gate is our lock, which #34 replaces with worktrees.
