import { MUSE_CONTEXT_HEADERS } from "./context.js";

/** The concrete reasoning tiers every pinned MSP row offers today. */
export const EFFORT_VARIANTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type EffortVariant = (typeof EFFORT_VARIANTS)[number];

/** Parse a user-supplied tier; anything else (including "default") is rejected. */
export function parseEffortVariant(value: unknown): EffortVariant | null {
  if (typeof value !== "string") return null;
  const wanted = value.trim().toLowerCase();
  return (EFFORT_VARIANTS as readonly string[]).includes(wanted) ? (wanted as EffortVariant) : null;
}

/**
 * The caller's explicitly chosen variant, if any. A missing header or the
 * synthetic "default" both mean the user did not choose: the catalog default
 * (or a pinned effort) applies instead.
 */
export function explicitVariant(headers: Record<string, string | undefined> | undefined): string | undefined {
  const raw = headers?.[MUSE_CONTEXT_HEADERS.variant];
  if (!raw || raw === "default") return undefined;
  return raw;
}
