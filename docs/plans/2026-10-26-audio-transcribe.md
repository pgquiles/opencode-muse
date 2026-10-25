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
- Transcription rides the flat subscription (voice mode is included
  in every plan per official docs); README states that. User
  attaching the file is consent to transcribe it.

## Probe results (2026-10-25, Muse 1.4.13, subscription session)

Contract is clean and machine-readable:

- Success: exit 0, transcript on stdout, stderr empty. wav, mp3, and
  ogg inputs all transcribe correctly (CLI decodes via local ffmpeg).
- Unreadable input (missing file, empty file, random bytes, text
  renamed to `.mp3`): exit 3, `error: ...` on stderr, stdout carries
  only a bare newline. Message shapes observed: `unreadable clip
  <FILE>: No such file or directory (os error 2)`, `the file is
  empty`, `ffmpeg exited 183: ... Invalid data found when processing
  input`.
- Audible but wordless input (silence, pure tone): exit 7,
  `error: no words heard: voice session closed before final
  transcript` on stderr.
- Latency ≈ 0.7x clip duration (2.8s clip → 2.1s; 8.5s clip →
  6.1s). Proposed spawn timeout: `max(60s, 3x clip duration)` from
  the decoded header — generous, still bounded.
- Transcript text is nondeterministic across runs (observed `The
  quick...` vs `The Quick...` on identical bytes). Never assert
  exact-match on transcript content in tests; match case-insensitively
  or on word sets.
- Billing: resolved per [official subscription
  docs](https://dev.meta.ai/help/subscriptions/what-is-a-muse-code-subscription)
  — every plan "Use voice mode", i.e. transcription is included in
  the flat subscription, consistent with our probes (no `muse usage`
  movement across 8 transcribe calls). README states inclusion, not
  metering uncertainty. PAYG-side behavior stays out of scope: this
  plugin is subscription-only (#29).

Remaining (non-gating): oversized-input ceiling unprobed — the spawn
timeout plus exit-3 mapping covers it behaviorally; size cap
(`maxMediaBytes` reuse) stays as the backstop.

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
