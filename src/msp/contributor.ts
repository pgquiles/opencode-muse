import { spawnSync } from "node:child_process";
import { MuseInvalidConfigError } from "../errors.js";

/**
 * Contributor billing lane (#29). Contributor is a per-process `muse serve`
 * choice, fixed at spawn: only the `--contributor-mode` launch flag selects
 * it (muse-code-sdk#102), so the plugin resolves one lane and passes it to
 * every serve child it starts. The default matches the Muse TUI (`on`); the
 * opt-out is explicit and takes effect at the next host start.
 */
export type ContributorMode = "on" | "off";

/** Option key honored in the plugin context options, if core forwards them. */
export const CONTRIBUTOR_MODE_OPTION = "contributorMode";

/** Namespaced env override; the value is config, never a credential. */
export const CONTRIBUTOR_MODE_ENV = "OPENCODE_MUSE_CONTRIBUTOR_MODE";

/**
 * Resolve the lane: an explicit option wins, then the namespaced env var,
 * otherwise the documented default (`on`). Anything else fails closed —
 * silently billing the wrong lane is the trap this exists to prevent.
 */
export function resolveContributorMode(raw: unknown): ContributorMode {
  if (raw === undefined) return "on";
  if (raw === true) return "on";
  if (raw === false) return "off";
  if (typeof raw === "string") {
    const wanted = raw.trim().toLowerCase();
    if (wanted === "on") return "on";
    if (wanted === "off") return "off";
  }
  throw new MuseInvalidConfigError(
    `Invalid Contributor mode ${JSON.stringify(raw) ?? "?"}: set ${CONTRIBUTOR_MODE_OPTION} to true/false (or ${CONTRIBUTOR_MODE_ENV} to on/off), or leave it unset for the default (on).`,
  );
}

/** The per-process serve flag pair for the resolved lane. */
export function contributorServeArgs(mode: ContributorMode): [string, ContributorMode] {
  return ["--contributor-mode", mode];
}

/**
 * Env keys that must never reach a Muse child process. Muse prefers
 * `META_API_KEY` over the account login, which would silently move requests
 * to pay-as-you-go billing; a `MUSE_CONTRIBUTOR_MODE` value would fight the
 * plugin's per-process `--contributor-mode` lane.
 */
const STRIPPED_CHILD_ENV_KEYS = new Set(["META_API_KEY", "MUSE_CONTRIBUTOR_MODE"]);

/**
 * Child env for every Muse process the plugin spawns (serve hosts,
 * transcription, help probes). Deletes the billing-lane keys (matched
 * case-insensitively for Windows-style casing) and pins
 * `MUSE_NO_AUTO_UPDATE=1` so Muse never replaces its own binary under a
 * running host. Everything else (PATH, HOME, keychain/proxy plumbing)
 * passes through untouched: this deletes keys rather than allowlisting, so
 * login keeps working.
 *
 * Precedence note: if muse ever honors `MUSE_CONTRIBUTOR_MODE`, the
 * always-passed `--contributor-mode` flag wins by standard flag-over-env
 * precedence, which would block per-session lanes. That future must pass the
 * flag only for explicitly configured lanes and otherwise inherit per host.
 */
export function museChildEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (STRIPPED_CHILD_ENV_KEYS.has(key.toUpperCase())) continue;
    cleaned[key] = value;
  }
  cleaned.MUSE_NO_AUTO_UPDATE = "1";
  return cleaned;
}

/**
 * Base `muse serve` argv for every host the plugin starts, so the session
 * host (which bills turns) and the short-lived catalog host (model/list is
 * unbilled) never diverge on the requested lane.
 */
export function baseServeArgs(providerId: string, mode: ContributorMode): string[] {
  return ["serve", "--provider", providerId, ...contributorServeArgs(mode)];
}

export interface ServeHelpResult {
  stdout: string;
}

export type ServeHelpRunner = (museBin: string) => ServeHelpResult | Promise<ServeHelpResult>;

function defaultServeHelpRunner(museBin: string): ServeHelpResult {
  const result = spawnSync(museBin, ["serve", "--help"], { encoding: "utf8", timeout: 15_000, env: museChildEnv(process.env) });
  return { stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

/**
 * Fail closed unless the CLI advertises the flag. A future CLI without it
 * must error here, never degrade to silent Standard billing. Raw spawn
 * diagnostics are never attached to the error.
 */
export async function assertContributorFlagSupported(
  museBin: string,
  runHelp: ServeHelpRunner = defaultServeHelpRunner,
): Promise<void> {
  let stdout = "";
  try {
    stdout = (await runHelp(museBin)).stdout;
  } catch {
    throw new MuseInvalidConfigError(
      `Cannot confirm ${museBin} supports --contributor-mode ("serve --help" did not run); refusing to bill without proof of the requested lane.`,
    );
  }
  if (!stdout.includes("--contributor-mode")) {
    throw new MuseInvalidConfigError(
      `${museBin} does not advertise --contributor-mode; refusing to bill without proof of the requested lane.`,
    );
  }
}

/**
 * opencode-muse is subscription-only: official PAYG goes through OpenCode's
 * OpenAI-compatible provider. Presence-checked only; the key value is never
 * read, logged, or transmitted.
 */
export function paygBillingNotice(env: Record<string, string | undefined> | undefined = process.env): string | undefined {
  if (env?.META_API_KEY === undefined) return undefined;
  return "opencode-muse is subscription-only and META_API_KEY is set: for pay-as-you-go billing use OpenCode's official OpenAI-compatible provider (metamate) instead of this plugin.";
}
