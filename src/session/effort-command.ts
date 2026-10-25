import { parseEffortVariant } from "../model/effort.js";

export interface EffortPinSessions {
  setEffortPin(openCodeSessionId: string, variant: string): void;
}

export interface EffortCommandInvocation {
  sessionID: string;
  prompt: unknown;
}

/**
 * The /effort command: pin a concrete reasoning tier for the rest of the
 * session. A bare invocation pins minimal; anything else must name one of
 * the six tiers. Explicit per-turn choices (Ctrl+T, #variant model suffix)
 * always win over the pin; without either, the catalog default applies.
 */
export function createEffortCommandHandler(sessions: EffortPinSessions) {
  return {
    name: "effort",
    description: "Pin the Muse reasoning effort for this session: minimal, low, medium, high, xhigh, or max (bare pins minimal).",
    async execute(input: EffortCommandInvocation): Promise<void> {
      const raw = typeof input.prompt === "string" ? input.prompt : "";
      const wanted = raw.trim() === "" ? "minimal" : raw;
      const variant = parseEffortVariant(wanted);
      if (variant === null) {
        throw new Error(
          `Unknown effort "${typeof input.prompt === "string" ? input.prompt.trim() : "?"}" — choose one of: minimal, low, medium, high, xhigh, max.`,
        );
      }
      sessions.setEffortPin(input.sessionID, variant);
    },
  };
}
