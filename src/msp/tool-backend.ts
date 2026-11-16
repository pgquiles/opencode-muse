import { MuseInvalidConfigError } from "../errors.js";

/**
 * Tool backend (#37). `"muse"` keeps the vetted Shape B path: Muse-native
 * tools, Muse system prompt, `approvalMode: "onRequest"`. `"opencode"` opts
 * into host-executed tools behind an explicit user choice: the bridge swaps
 * the Muse prompt/toolset for a loopback MCP bridge and OpenCode's native
 * permission evaluation becomes the only fence (`approvalMode: "allowAll"`).
 *
 * Process-wide, resolved once at plugin load like the Contributor lane:
 * per-model options do not reach the plugin (`request.model` carries only
 * id/provider/variant; plugin options arrive empty — probed on 2.1.4), so
 * an env var is the only settable channel today. Anything else fails
 * setup fast instead of silently running the wrong backend.
 */
export type ToolBackend = "muse" | "opencode";

/** Option key honored in the plugin context options, if core forwards them. */
export const TOOL_BACKEND_OPTION = "toolBackend";

/** Namespaced env override; the value is config, never a credential. */
export const TOOL_BACKEND_ENV = "OPENCODE_MUSE_TOOL_BACKEND";

/**
 * Served schema fingerprints with a passing opencode-backend live-turn probe
 * (#58). Muse CLI 1.4.20 rejects session MCP servers in `run.toolset`, so
 * every tool turn fails there; without the pin, MCP tools never load while
 * native tools stay visible under `allowAll`. Record each newly verified
 * fingerprint in `docs/compatibility.md` and extend this set; never add an
 * unprobed one.
 */
export const OPENCODE_BACKEND_VERIFIED_FINGERPRINTS: ReadonlySet<string> = new Set([
  // Muse CLI 1.4.14-R7309.1: the backend live-turn gate passed here.
  "sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6",
]);

/**
 * Fail opencode-backend setup fast on an unverified serving CLI, before any
 * session starts. The default muse backend is unaffected.
 */
export function checkOpencodeBackendCliSupport(servedFingerprint: unknown): void {
  if (
    typeof servedFingerprint === "string" &&
    servedFingerprint !== "" &&
    OPENCODE_BACKEND_VERIFIED_FINGERPRINTS.has(servedFingerprint)
  ) {
    return;
  }
  const served = typeof servedFingerprint === "string" && servedFingerprint !== "" ? servedFingerprint : "missing";
  throw new MuseInvalidConfigError(
    `The opencode tool backend (${TOOL_BACKEND_ENV}=opencode) is not verified on the serving Muse CLI (schema fingerprint "${served}"): only fingerprints with a passing backend live-turn probe are admitted — Muse CLI 1.4.20 rejects session MCP servers in run.toolset, so every tool turn fails (configError: unknown tool), and without the pin MCP tools never load while native tools stay visible under approvalMode allowAll. Unset the variable for the default muse backend, or hold Muse CLI 1.4.14 (verified fingerprint sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6, see docs/compatibility.md). See https://github.com/pgquiles/opencode-muse/issues/58.`,
  );
}

/** Resolve the backend: an explicit option wins, then the env var, else `"muse"`. */
export function resolveToolBackend(raw: unknown): ToolBackend {
  if (raw === undefined) return "muse";
  if (typeof raw !== "string") {
    throw new MuseInvalidConfigError(
      `Invalid tool backend: set ${TOOL_BACKEND_OPTION} to "muse"/"opencode" (or ${TOOL_BACKEND_ENV} to muse/opencode), or leave it unset for the default ("muse").`,
    );
  }
  const wanted = raw.trim().toLowerCase();
  if (wanted === "muse") return "muse";
  if (wanted === "opencode") return "opencode";
  throw new MuseInvalidConfigError(
    `Invalid tool backend ${JSON.stringify(raw) ?? "?"}: set ${TOOL_BACKEND_OPTION} to "muse"/"opencode" (or ${TOOL_BACKEND_ENV} to muse/opencode), or leave it unset for the default ("muse").`,
  );
}
