import { MuseInvalidConfigError } from "../errors.js";

/**
 * Approval mode for Muse-backend sessions. The bridge historically forced
 * `onRequest` on every `session/start`, which silently overrode the user's
 * own Muse permission profile (`permissions.default_profile`): a user who
 * selected `:unrestricted` in Muse still got a prompt for every network
 * destination and shell command through OpenCode.
 *
 * `"host-default"` opts out of the override: the bridge omits `approvalMode`
 * from `session/start` and the Muse host applies its configured default
 * profile, exactly as it does for the native TUI. The four closed MSP modes
 * can also be selected explicitly ("select, never create" — these are modes
 * the host defines, not plugin-authored policy). Unset keeps the vetted
 * `onRequest` default, so existing installs change nothing.
 *
 * Process-wide, resolved once at plugin load like the Contributor lane and
 * the tool backend: per-model options do not reach the plugin, so an env var
 * is the only settable channel today. Anything else fails setup fast instead
 * of silently running the wrong approval posture. The opencode tool backend
 * ignores this knob: its fence is OpenCode's native permission evaluation
 * (`allowAll` on the Muse side, #37).
 */
export type ApprovalModeSetting =
  | "onRequest"
  | "host-default"
  | "allowAll"
  | "promptUnmatched"
  | "denyUnmatched";

/** Option key honored in the plugin context options, if core forwards them. */
export const APPROVAL_MODE_OPTION = "approvalMode";

/** Namespaced env override; the value is config, never a credential. */
export const APPROVAL_MODE_ENV = "OPENCODE_MUSE_APPROVAL_MODE";

const INVALID_HINT =
  `set ${APPROVAL_MODE_OPTION} to "onRequest"/"host-default"/"allowAll"/"promptUnmatched"/"denyUnmatched" ` +
  `(or ${APPROVAL_MODE_ENV} to the same values), or leave it unset for the default ("onRequest"). ` +
  `"host-default" omits approvalMode so the Muse host's configured permission profile applies.`;

/** Resolve the setting: an explicit option wins, then the env var, else `"onRequest"`. */
export function resolveApprovalMode(raw: unknown): ApprovalModeSetting {
  if (raw === undefined) return "onRequest";
  if (typeof raw !== "string") {
    throw new MuseInvalidConfigError(`Invalid approval mode: ${INVALID_HINT}`);
  }
  const wanted = raw.trim().toLowerCase();
  switch (wanted) {
    case "onrequest": return "onRequest";
    case "host-default": return "host-default";
    case "allowall": return "allowAll";
    case "promptunmatched": return "promptUnmatched";
    case "denyunmatched": return "denyUnmatched";
    default:
      throw new MuseInvalidConfigError(`Invalid approval mode ${JSON.stringify(raw)}: ${INVALID_HINT}`);
  }
}

/**
 * Wire value for `session/start`. `undefined` means the member is omitted
 * entirely and the host's configured default applies; every other setting
 * selects the host-defined mode verbatim.
 */
export function approvalModeWireValue(
  setting: ApprovalModeSetting,
): "onRequest" | "allowAll" | "promptUnmatched" | "denyUnmatched" | undefined {
  return setting === "host-default" ? undefined : setting;
}
