# #32 audio attachments via `muse voice transcribe` — plan (2026-10-26)

## Problem

Audio attachments (`audio/*` file parts) are rejected with an
`unsupported-media` bridge error because the pinned MSP
`TurnInputPartType` has no audio part (#21, `docs/compatibility.md`).
Users who attach a voice memo or recording get a flat rejection.
Smuggling audio bytes through the video part was considered and rejected:
dishonest labeling plus unverified server behavior.

## CLI facts (verified on the pinned CLI)

- `muse voice transcribe <FILE>` prints the words spoken in the clip.
  Help cites `audio_message.m4a` and wav; no format flags, no output
  options, no documented size/duration limits.
- The command owns authentication (CLI login); the plugin never handles
  credentials. Billing presumably hits the subscription like any CLI
  use — unconfirmed, must be disclosed in README either way.

## Flow

1. At prompt-build time, each `audio/*` file part is written to a
   temp file (mkdtemp under `/tmp`, cleaned up after) and transcribed
   via one `muse voice transcribe` spawn with a bounded timeout.
   Multiple clips transcribe sequentially, each labeled separately.
2. The transcript enters the turn as declared text, never as
   user-typed prose, e.g. `[Transcription of attached <name>
   (<mediaType>, <bytes>): "<transcript>"]`.
3. Any transcription failure (nonzero exit, empty output on nonempty
   input, timeout, missing CLI) fails the turn with a narrow bridge
   error naming the clip and the cause. Attached content is never
   silently dropped.

## Non-negotiables

- Transcript integrity: the model always sees the text as a declared
  transcription with source media type; never unlabeled, never merged
  into the user's own words.
- No silent drops: a clip that cannot be transcribed fails loudly.
- No credential handling: the CLI owns auth end to end.
- Transcription cost is subscription-billed until proven otherwise;
  README must say so (user attaching the file is implicit consent,
  but the billing fact must be written down, not assumed).

## Unknowns (hard-gate probes before implementing)

- Exit codes and stderr shape on: missing file, corrupt/empty audio,
  silence-only clip, unsupported container, oversized input.
- Real format coverage beyond m4a/wav (mp3, ogg, webm-audio?) and any
  size/duration ceiling — probe, do not document guesses.
- Latency on a realistic clip (sets the spawn timeout and whether
  sequential-per-clip is acceptable).
- Billing/usage attribution: does a transcribe call appear in
  `muse usage`, and under which lane?
- Concurrent-spawn safety: one transcribe at a time per turn is the
  v1 proposal; parallelism only if probes show it is safe.

## Verification

- TDD with faked transcriber (stub the spawn boundary): labeled
  injection, multi-clip ordering, every failure mode above mapped to
  the narrow error, temp-file cleanup on success and failure, timeout
  kill.
- Full gates (build, tests, strict type-check) before commit.
- Live probe on the pinned CLI for every Unknown above; feature
  ships only after the probes pass. PAYG re-verification stays waived
  per standing agreement (transcribe is CLI-mediated, same lane).
- Retire note: if MSP ever gains a native audio turn part, route
  attachments there and delete this conversion, not dual-maintained.
  The PDF half (text extraction) stays separate future work.
