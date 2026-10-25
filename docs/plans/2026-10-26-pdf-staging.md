# #33 PDF attachments via workspace staging — plan (2026-10-26)

## Problem

PDF attachments (`application/pdf` file parts) are rejected with an
`unsupported-media` bridge error because the pinned MSP
`TurnInputPartType` has no PDF part (#21, `docs/compatibility.md`).
In-plugin text extraction was considered and rejected: expensive
(renderer or parser dependency), per-page context blowup, and a
duplication of parsing the agent already performs.

## Direction

Stage the bytes: save the PDF under the session workspace and tell the
model where it is. The agent reads it with its own tools on demand.

## Probe result (2026-10-25, Muse 1.4.13, headless `muse exec`)

A hand-built one-page PDF (`Probe text alpha seven`) staged in a
scratch workspace was read back exactly by the agent, which
cross-checked with `pdftotext` and the raw content stream. Files under
the agent's workspace cwd are readable; paths outside its roots are
refused (established earlier). Staging must therefore land inside the
session workspace, never bare `/tmp`.

## Flow

1. At prompt-build time, `application/pdf` bytes pass the existing
   size cap first, then are written to
   `<workspace>/.opencode-muse-uploads/<uuid>.pdf` (mode `444` as an
   intent signal; same-user agents can override it, so it is a hint,
   not enforcement).
2. The turn carries a bridge-authored text part, e.g.
   `[Attached PDF saved to <path> (<bytes> bytes): read it with your
   tools if needed]` — declared provenance, never merged into
   user-typed prose.
3. The agent reads on demand, including across follow-up turns; the
   file persists for the session so multi-turn references keep
   working.

## Non-negotiables

- Generated names only (uuid + fixed `.pdf` suffix). Binary file
  parts carry no filename, and none is accepted from anywhere else —
  no user-controlled path ever reaches the filesystem.
- Size cap before writing; staged bytes are never logged.
- Staging directory is always inside the session workspace. Anything
  else risks landing outside the agent's readable roots.
- A PDF the agent cannot parse fails in agent prose, surfaced to the
  user like any other agent-side failure — accepted consequence of
  not parsing in-plugin.

## Unknowns (resolve before/with implementation)

- Retention rule (the open point): eager delete breaks multi-turn
  follow-ups; never-delete litters workspaces and lingers sensitive
  content. Candidates: purge the staging dir on session close with
  the rule documented, or keep-and-document. No guess — decide and
  write it down.
- Staging dir name and collision policy (uuid makes collisions
  near-impossible; decide whether to reuse one dir per session).
- Read-only workspaces: stage-then-fail-loudly with the path named,
  or fall back to unsupported-media? Probe the actual failure.
- Multiple PDFs in one turn: one labeled part each, order preserved.
- Confirm the agent's readable root always covers the plugin's
  session workspace (probe a nested workspace layout, not just cwd).

## Verification

- TDD with faked filesystem + prompt tests: uuid naming, size cap
  first, label format, multi-PDF order, cleanup rule, read-only
  workspace behavior.
- Live probes for every Unknown above on the pinned CLI; the
  readability probe is already banked.
- Full gates (build, tests, strict type-check) before commit.
- Retire note: if MSP ever gains a native PDF turn part, route
  attachments there and delete this staging path, not dual-maintained.
