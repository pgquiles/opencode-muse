# Getting started

## Requirements

- OpenCode V2 (2.1.4 is the verified target; newer versions are in use — see [Compatibility](/guide/compatibility))
- The Muse Code CLI installed and signed in:
  ```sh
  muse login
  ```
- A Muse subscription, or a configured pay-as-you-go key (see below)

## Install

Add the published package to your project-level `opencode.jsonc` (or `opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-muse@1.1.0"]
}
```

Restart OpenCode (or OpenChamber) if it was already running, then pick a Muse model from the model picker. If your OpenCode version ignores the package entry, use the local-shim fallback instead — never both, or OpenCode reports a duplicate plugin ID:

```sh
npm install opencode-muse
mkdir -p .opencode/plugins
cat > .opencode/plugins/opencode-muse.js <<'EOF'
export { default } from "opencode-muse";
EOF
```

## First prompt

Ask anything ordinary. Title generation and session summaries are answered locally at zero model cost; your first real question runs a Muse turn. If the model list is empty, the provider shows a disabled *"Muse setup required — run muse login, then refresh providers"* placeholder instead of a model that would fail on use.

## Billing: subscription or PAYG

- **Subscription (default).** Sign in with `muse login` and leave it alone. The plugin never inspects or changes your Contributor mode.
- **Pay-as-you-go.** Set `META_API_KEY` for the OpenCode process (the official `muse auth set --provider meta --api-key-stdin` path also works). Note the precedence: Muse prefers the key over the account login, so an exported key silently bills PAYG instead of the subscription. To keep children on the subscription lane, every Muse child the plugin spawns gets a sanitized environment (`META_API_KEY` and `MUSE_CONTRIBUTOR_MODE` stripped, `MUSE_NO_AUTO_UPDATE=1` set).

## OpenChamber

Provider and model rows appear through generic OpenCode plugin loading — no OpenChamber source changes are needed. Its provider UI does not expose plugin sign-in methods, so authentication stays a manual `muse login` step.
