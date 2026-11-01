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
