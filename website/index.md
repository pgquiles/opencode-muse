---
layout: home

hero:
  name: opencode-muse
  text: Muse subscription models, inside OpenCode
  tagline: An OpenCode plugin that drives your Muse Code subscription through the official Muse CLI. Your login never leaves the CLI.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Compatibility record
      link: /guide/compatibility

features:
  - title: Subscription stays in the CLI
    details: The plugin talks to muse serve over its session protocol. It never reads your credential files, never relays keys, and never changes your billing mode.
  - title: Muse runs the agent loop
    details: By default, Muse's own tools and system prompt do the work. OpenCode renders the result; it does not re-run tools or second-guess the model.
  - title: Pinned and probed
    details: Every supported Muse CLI and OpenCode version is recorded with live probe evidence — catalog, text turns, rewind, approvals — not just declared.

---

## Install

Add the published package to your project-level `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-muse@1.1.0"]
}
```

Then sign in once through the official CLI, restart OpenCode, and pick a Muse model:

```sh
muse login
```

See [Getting started](/guide/getting-started) for the fallback shim, PayGo billing, and OpenChamber notes. The snippet above always names the latest release — check [Releases](https://github.com/pgquiles/opencode-muse/releases) if yours differs. The package is also on [npm](https://www.npmjs.com/package/opencode-muse).
