# #31 conversational option-questions — plan (2026-10-26)

## Problem

The bridge declares `userInputDialogs: false` and answers method-not-found
to `userInput/request`. If the server parks awaiting an answer, that is the
pre-#30 approval hang again. #6 stays open for native support; this is the
workaround, retired the same way.

## Protocol facts (verified in pinned schema)

- Request (server→us): `userInput/request` with `{userInputId, sessionId,
  turnId, toolCallId, toolName?, questions[{id, header, question,
  options[{label, description?, preview?}], selection{mode, minSelections?,
  maxSelections?}}], autoResolutionMs?, ...}`. Every question REQUIRES
  options — the surface is choice-shaped throughout.
- Events: `userInput/requested`, `userInput/engaged`, `userInput/settled`.
- Answer (us→server): `userInput/answer` with `{answers[{questionId,
  selectedLabel?, selectedLabels?, freeText?, note?}], commandId,
  sessionId, userInputId}`.
- Fail-closed verbs (us→server): `userInput/cancel {commandId, sessionId,
  userInputId, reason?}` and `userInput/interrupt`. Cancel is the
  deny-analogue — protocol-native, no invention.
- The server may settle on its own (`autoResolutionMs`); a late answer must
  drop as stale via the settled event, never double-answer.

## Flow (mirrors #30)

1. On `userInput/requested`, end the OpenCode turn with the oldest open
   question rendered conversationally: header + question verbatim, options
   lettered (reuse the #30 renderer/matcher), descriptions as hints, reply
   contract, bridge label. One question per turn; further questions queue
   FIFO exactly like pending approvals.
2. The session's next message answers the oldest open question (never
   forwarded to the model while a question pends).
3. Single-select: the #30 exact-one-match rule unchanged (letter, number,
   label, letter+label; case/punctuation-insensitive).
   Multi-select: split the reply on commas/whitespace, map every token,
   require all tokens to match distinct options and
   min/maxSelections to hold. Any failure is ambiguity.
4. Miss: re-ask once quoting the received text. Second miss: `userInput/cancel`
   with a reason + echo. Ambiguity never fabricates an answer.
5. Stale rules (same as #30): rewind trips transcript-divergence recovery
   before any verdict is consumed; restart drops in-memory pending; a server
   `settled` event retires the local entry so late answers are dropped.

## Non-negotiables

- Answer only with option labels the server offered (`selectedLabel(s)`);
  never invent labels, never infer `freeText` from unmatched input.
- `userInputDialogs` flips to true only for the schemas v1 fully collects
  (option selections); everything else cancels with a reason.
- The settled-event path must make double-answers impossible by
  construction (check-then-act under the pending entry, cleared on settle).

## Unknowns (resolve from schema + live before/while implementing)

- Actual `selection.mode` values (single/multiple/custom?) — multi-select
  ships only if the values confirm the semantics; otherwise single-only v1
  and multi cancels with a reason.
- Whether the server sends a `userInput/request` server message, just the
  event, or both (the #30 race: handle both, prefer event params, fall back
  to the exchange lookup).
- Typical `autoResolutionMs` and what cancel does to the turn (interrupts?
  continues answerless?) — observe, do not assume.
- Whether `note`/`freeText` ride alongside selections in ways v1 must
  preserve (read-only: echo them back in the recorded line, never author).

## Verification

- TDD with fake MSP hosts: single/multi parsing incl. min/max edges,
  re-ask-once-then-cancel, FIFO queue with stale-drop, echo-back, cancel on
  unpresentable (empty labels, unknown modes), no double-answer after
  server settle.
- Full gates (build, tests, strict type-check) before commit.
- Live TUI check deferred like #30's: this CLI build rarely emits protocol
  prompts for safely-testable actions, and forcing one must not escalate
  destructiveness. Park as implemented-but-awaiting-live-questions if needed.
- Retire note: convert to native structured input when core supports it
  (#6); this workaround is then deleted, not dual-maintained.
