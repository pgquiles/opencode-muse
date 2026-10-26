import { describe, expect, test } from "bun:test";
import {
  describeRecoveryBlock,
  matchRecoveryDecision,
  renderRecoveryPrompt,
} from "../../src/session/recovery.js";
import type { SessionRegistryEntry } from "../../src/session/registry.js";

function entry(overrides: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry {
  return {
    openCodeSessionId: "ses_oc_1",
    museSessionId: "ses_muse_1",
    hostId: "host-1",
    workspaceFingerprint: "f".repeat(64),
    transcriptFingerprints: [],
    compactionFingerprints: [],
    pendingCommands: {},
    updatedAt: 1_000_000,
    ...overrides,
  };
}

describe("session recovery offer", () => {
  test("recovery.ignoresCleanEntries", () => {
    expect(describeRecoveryBlock(entry(), 2_000_000)).toBeNull();
  });

  test("recovery.describesAPoisonedEntry", () => {
    const block = describeRecoveryBlock(entry({
      activeTurnId: "turn-9",
      pendingCommands: {
        "cmd-1": { method: "turn/start", fingerprint: "a".repeat(64) },
      },
      updatedAt: 1_000_000,
    }), 1_060_000);

    expect(block).toMatchObject({ method: "turn/start", museSessionId: "ses_muse_1", hasActiveTurn: true });
    expect(block?.ageMs).toBe(60_000);
  });

  test("recovery.describesAnActiveTurnWithoutPendingCommands", () => {
    const block = describeRecoveryBlock(entry({ activeTurnId: "turn-9" }), 2_000_000);
    expect(block).toMatchObject({ method: "turn", hasActiveTurn: true });
  });

  test("recovery.rendersAnAbandonOrKeepChoice", () => {
    const text = renderRecoveryPrompt({ method: "turn/start", ageMs: 60_000, museSessionId: "ses_muse_1", hasActiveTurn: true });
    expect(text).toContain("A. Abandon the stuck turn and restart fresh");
    expect(text).toContain("B. Keep waiting");
    expect(text).toContain("turn/start");
    expect(text).toContain("Reply with one option");
  });

  test("recovery.matchesAbandonOnlyOnExactForms", () => {
    expect(matchRecoveryDecision("A")).toBe(true);
    expect(matchRecoveryDecision("a")).toBe(true);
    expect(matchRecoveryDecision("1")).toBe(true);
    expect(matchRecoveryDecision("Abandon the stuck turn and restart fresh")).toBe(true);
    expect(matchRecoveryDecision("B")).toBe(false);
    expect(matchRecoveryDecision("Keep waiting")).toBe(false);
    // Bare verbs are not exact forms — same fail-closed discipline as
    // approvals, and the prompt contract says anything else keeps waiting.
    expect(matchRecoveryDecision("abandon")).toBeNull();
    expect(matchRecoveryDecision("keep")).toBeNull();
    expect(matchRecoveryDecision("yes")).toBeNull();
    expect(matchRecoveryDecision("approved")).toBeNull();
    expect(matchRecoveryDecision("")).toBeNull();
  });
});
