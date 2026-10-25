# Conversational approvals workaround (new issue; #22 stays open for native support)

## Problem

Every Muse permission prompt currently kills the turn: core drops
provider-emitted `tool-approval-request` parts and offers no verdict channel
(anomalyco/opencode#58839, feature request, no timeline). Fail-closed on all
approvals makes the plugin useless for real agentic work. Until core ships
native support, resolve approvals conversationally.

## Protocol facts (verified in pinned schema)

- `approval/request` carries `approvalId`, `currentRequirementId`, and
  `availableChoices: [{ choiceId, decision: approve|reject, label, scope,
  acceptsFeedback?, rulePreview? }]`. There is NO protocol-level "Other" or
  free-text verdict: a real `choiceId` must always be picked.
- `approval/decide` takes `approvalId`, `choiceId`, `requirementId`,
  `sessionId`, `commandId`, plus optional `feedback`.
- Multiple approvals may pend at once (`approval/listPending` exists).

## Flow

1. On `approval/request`, end the turn with assistant text (OpenCode side
   only — the bridge never forwards assistant text to Muse, so the Muse
   transcript is untouched) presenting the choices verbatim, numbered with
   letters, labeled as bridge text, ending with: "Reply with one option
   (letter, number, or name). Anything else is asked once more, then denied."
2. The session's next user message is a verdict attempt while an approval
   pends — never forwarded to the model as a new instruction.
3. Match (normalizer + uniqueness rule below). On match: `approval/decide`
   with the real `choiceId` under the current `requirementId`, then
   echo-back ("Recorded: denied file write"). Re-attach to the resumed turn
   via the parked-turn join machinery.
4. On no-match: re-ask ONCE (compact options + what was received). Second
   no-match: deny via the narrowest reject choice (reuse the boolean mapper
   with `approved=false`) and say so. No re-ask loops.
5. Multi-pending: FIFO queue — oldest first, each with its own re-ask-once;
   drop entries whose requirement advanced or that timed out, with a notice.
6. Stale rules: rewind trips the existing transcript-divergence recovery
   error before any verdict is consumed, and a restart drops in-memory
   pending (the server default-denies on timeout); either way a stale
   approval can never hijack a later message. Deny is always recoverable by
   re-prompting; a wrong approve is not.

## Matcher spec

- `norm(s)` = lowercase, keep `[a-z0-9]` only.
- Choice *i* (1-based) with letter L and label T matches iff `norm(input)`
  equals `norm(L)`, `norm(T)`, `norm(L+T)`, or `String(i)`.
- Accept iff exactly one choice matches; else ambiguous (re-ask, then deny).
- Never match by meaning: "yes"/"no"/"ok" match nothing unless they equal a
  presented form. Ambiguity never resolves to approve.

## Compliance reading (standing approval rules)

- Verbatim labels/IDs from `availableChoices`, decided under the current
  `requirementId`: no invented choice IDs, no fabricated answers.
- A numbered list represents the offered choices, so conversational UI
  satisfies "represent, don't guess"; everything unrepresentable denies.
- Documented bypass: verdicts skip OpenCode permission rules and `--auto`.
  Accepted cost until core support lands; retire this flow then.

## Verification

- TDD with fake MSP hosts: exact/fuzzy/ambiguous matching, re-ask-once
  then deny, FIFO queue with stale-drop, echo-back text, labeled synthetic
  prompt, narrowest-reject selection.
- Full gates (build, tests, strict type-check) before commit.
- Live TUI check by the user (approve + deny + gibberish paths), like #28.
- Retire note: convert to native `tool-approval-request` when core supports
  it (#22); this workaround is then deleted, not dual-maintained.

## Live findings (2026-10-25, Muse 1.4.13, subscription)

- The CLI build rarely emits protocol approvals for safely-testable actions:
  `echo`, `rm`, and file writes inside and outside the workspace all sailed
  through; one choiceless `approval/requested` event was observed, never an
  event with choices. The match → decide → join path is therefore
  fake-verified only; the fallback notice and prose pass-through are
  live-verified.
- Policy stack, discovered live: outside-workspace writes are hard-denied by
  the sandbox before any approval stage (no event fires), and model-driven
  asking surfaces as prose, not protocol events. So the event path this
  flow serves is nearly unreachable in this environment — and the flow is
  strictly better than the hang it replaces regardless.
