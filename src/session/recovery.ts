import { matchConversationalChoice } from "../msp/approvals.js";
import type { SessionRegistryEntry } from "./registry.js";

/** Facts about a poisoned registry entry, safe to show (no prompts, no paths). */
export interface RecoveryBlock {
  method: string;
  ageMs: number;
  museSessionId: string;
  hasActiveTurn: boolean;
}

/**
 * Describe the stuck turn behind a poisoned entry, or null when the entry
 * is clean. Prefers the oldest pending command; an active turn without a
 * recorded command still blocks and is reported generically.
 */
export function describeRecoveryBlock(
  entry: SessionRegistryEntry,
  now: number = Date.now(),
): RecoveryBlock | null {
  const pending = Object.values(entry.pendingCommands);
  if (pending.length === 0 && entry.activeTurnId === undefined) return null;
  return {
    method: pending[0]?.method ?? "turn",
    ageMs: Math.max(0, now - entry.updatedAt),
    museSessionId: entry.museSessionId,
    hasActiveTurn: entry.activeTurnId !== undefined,
  };
}

const RECOVERY_CHOICES = [
  { label: "Abandon the stuck turn and restart fresh" },
  { label: "Keep waiting" },
];

function formatAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/**
 * The abandon-or-keep prompt. Abandoning deletes the stuck entry and the
 * Muse linkage and ends with "re-prompt" — it never resumes or replays the
 * unknown turn, and it cannot stop a still-running orphan elsewhere.
 */
export function renderRecoveryPrompt(block: RecoveryBlock): string {
  const lines = RECOVERY_CHOICES.map((choice, index) =>
    `${"ABCD"[index] ?? "?"}. ${choice.label}`);
  return `**Recovery needed** (opencode-muse bridge message, not the model): the previous turn (${block.method}, stuck for ${formatAge(block.ageMs)}) has an unknown outcome — it may or may not have run.\n${lines.join("\n")}\nReply A to abandon it and restart fresh (Muse-side history is dropped; re-prompt afterwards), or B to keep waiting. Reply with one option (letter, number, or name). Anything else keeps waiting.`;
}

/**
 * Match a reply to the recovery choice. True abandons, false keeps waiting,
 * null matches nothing (also keep). Ambiguity never abandons: only an
 * exact letter, number, or name for A clears the stuck turn.
 */
export function matchRecoveryDecision(text: string): boolean | null {
  const matched = matchConversationalChoice(RECOVERY_CHOICES, text);
  if (matched === null) return null;
  return matched === RECOVERY_CHOICES[0];
}
