import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

/**
 * Per-session private Muse config for the opencode tool backend (#37).
 * Bridge-authored `settings.json` only (system prompt, toolset, foreign
 * context and compaction guards); the user's `auth.json` is symlinked in
 * when present so the login keeps working. Nothing under the user's real
 * Muse config dir is opened, parsed, copied, or logged — the symlink is a
 * pointer the plugin never reads through.
 */

const SESSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+_-]{0,511}$/;

/**
 * The user's real Muse config dir (never read or written by the plugin —
 * only used as the `auth.json` symlink source). Mirrors the state-dir
 * resolution, but for configuration roots.
 */
export function userMuseConfigDir(options: {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform | "win32";
} = {}): string {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA;
    const root = base && win32.isAbsolute(base) ? base : win32.join(homeDirectory, "AppData", "Local");
    return win32.join(root, "muse");
  }
  const dataHome = env.XDG_CONFIG_HOME;
  const root = dataHome && isAbsolute(dataHome) ? dataHome : join(homeDirectory, ".config");
  return join(root, "muse");
}

export interface BridgeSettingsInput {
  systemPrompt: string;
  toolset: string[];
}

/** Bridge-authored settings: our prompt and tools only, no user content. */
export function buildBridgeSettings(input: BridgeSettingsInput): Record<string, unknown> {
  return {
    schema_version: 1,
    run: {
      system_prompt: input.systemPrompt,
      toolset: [...input.toolset],
    },
    context: { foreign_personal_rules: false },
    context_compaction: { soft_threshold: 0.99, hard_threshold: 0.995 },
  };
}

/**
 * Write a private `XDG_CONFIG_HOME/<sessionKey>/muse` dir holding only
 * bridge-authored settings, with `auth.json` symlinked from the user's real
 * Muse config dir when it exists. Returns the XDG dir to export. Throws on
 * unsafe session keys; never reads file contents.
 */
export function writeHostConfig(
  stateDirectory: string,
  sessionKey: string,
  options: { authSourceDir: string; systemPrompt?: string; toolset?: string[] },
): string {
  if (!SESSION_KEY_PATTERN.test(sessionKey)) {
    throw new Error(`Refusing unsafe host config key: ${JSON.stringify(sessionKey)}`);
  }
  const xdg = join(stateDirectory, "hosts", sessionKey);
  const dir = join(xdg, "muse");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settings = buildBridgeSettings({
    systemPrompt: options.systemPrompt ?? defaultSystemPrompt,
    toolset: options.toolset ?? defaultToolset,
  });
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 1)}\n`, { mode: 0o600 });
  const authSource = join(options.authSourceDir, "auth.json");
  let authPresent = false;
  try {
    authPresent = existsSync(authSource) && lstatSync(authSource).isFile();
  } catch {
    authPresent = false;
  }
  if (authPresent) {
    const link = join(dir, "auth.json");
    try {
      if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(link, { force: true });
    } catch {
      // Leave a non-link occupant alone rather than replacing user data.
    }
    try {
      symlinkSync(authSource, link);
    } catch {
      // A racing writer owns the link; the login still resolves through it.
    }
  }
  return xdg;
}

/**
 * Remove host config dirs older than `olderThanMs` (crashed-process
 * leftovers). Fresh entries may belong to a live sibling process, so they
 * are never touched. Returns the removed session keys.
 */
export function sweepHostConfigs(
  stateDirectory: string,
  olderThanMs: number,
  now: number = Date.now(),
  keep: ReadonlySet<string> = new Set(),
): string[] {
  const hosts = join(stateDirectory, "hosts");
  let names: string[];
  try {
    names = readdirSync(hosts);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!SESSION_KEY_PATTERN.test(name)) continue;
    if (keep.has(name)) continue;
    const path = join(hosts, name);
    let age = 0;
    try {
      const stat = statSync(path);
      if (!stat.isDirectory()) continue;
      age = now - stat.mtimeMs;
    } catch {
      continue;
    }
    if (age < olderThanMs) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // A live sibling may hold the dir; leave it for the next sweep.
    }
  }
  return removed;
}

const defaultSystemPrompt = [
  "You are a tool-use engine driven by the host application.",
  "Use ONLY the tools provided by the host over its MCP bridge.",
  "Never use built-in tools, skills, or reminders.",
  "Wait for each tool call to return before continuing the turn.",
].join("\n");

/**
 * Default toolset: the whole loopback namespace. Per-turn tool names do not
 * exist yet when the config is written, so only a namespace glob admits the
 * bridge (probe precedent: server `probe` serves `mcp__probe__*`). An empty
 * allowlist gates every tool off — native and loopback alike.
 */
const defaultToolset: string[] = ["mcp__opencode-loopback__*"];
