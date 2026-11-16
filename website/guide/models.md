# Models and effort

The catalog comes from a live `model/list` call during plugin setup — never a hardcoded list. Each row becomes an OpenCode model built from the Muse profile plus model ID (for example `muse/muse-profile-tbh-model-muse-spark-1.3`), carrying the display label, context/output limits, release date, and known effort tiers.

## Effort variants

Reasoning effort tiers (`minimal` … `max`, per-model subsets) appear as OpenCode model variants. The selected tier rides on that turn only (`turn/start.reasoningEffort`); the standing session default is untouched unless explicitly changed. If you pick nothing, the `default` variant resolves to the catalog row's default effort. Unknown variant names fail closed.

## Logged out? No models, no trap

If the CLI reports no usable catalog (logged out, no subscription), the provider stays visible but disabled with a *"Muse setup required"* placeholder. OpenCode hides providers with zero models, so without the placeholder the Muse entry would vanish silently — the placeholder keeps the fix obvious.

## Titles and summaries are local

Thread titles and compaction summaries never reach Muse: the bridge answers them deterministically from the request itself. A Muse turn costs real inference, and Muse already owns the authoritative conversation — spending a turn on bookkeeping OpenCode does for its own transcript would pollute Muse's history for nothing.
