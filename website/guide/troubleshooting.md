# Troubleshooting

## No Muse models listed

Run `muse login`, restart OpenCode, and refresh providers. If the provider shows the *"Muse setup required"* placeholder, the CLI reported no usable catalog — that is the plugin telling you the truth instead of offering a model that would fail on use.

## "Duplicate plugin ID: opencode-muse"

The package entry and the local shim file are both loading. Use one or the other, never both.

## Approval prompts hang or never resolve

OpenCode core currently drops provider-emitted approval requests instead of showing them, so the bridge resolves approvals conversationally: answer the lettered list with one option. Anything unrecognized is asked once more, then denied on timeout. A pending approval always resolves before the turn continues — nothing waits silently forever.

## "opencode tool backend is not verified on the serving Muse CLI"

You opted into `OPENCODE_MUSE_TOOL_BACKEND=opencode` on a CLI without a passing backend probe (currently anything newer than 1.4.14, including 1.4.20). Either unset the variable for the default muse backend, or hold Muse CLI 1.4.14. See the tracking issue named in the message.

## "Muse turn failed (configError)"

On current versions the backend gate above fires first with a clearer message. If you see a bare `configError` on a verified CLI, report it with your Muse/OpenCode/plugin versions — it means a new incompatibility, not a misconfiguration.

## Startup fingerprint warning

`fingerprintWarning` lines at host start are informational: the serving CLI is newer than the SDK pin and additive drift was classified. Core chat does not depend on it. Only missing/malformed fingerprints fail closed.

## A turn was denied / failed closed

Fail-closed is the design, not a bug: unrepresentable choices, unknown variants, unmappable rewinds, and ambiguous verdicts all stop with an explanation rather than guessing. The message always says what to do instead — usually re-prompt, start a fresh session, or adjust one variable.

Still stuck? Open an issue with versions (`muse --version`, `opencode --version`, plugin version), the exact error text, and which backend and approval mode you run. Never paste credentials, prompts, or generated text.
