import { describe, expect, test } from "bun:test";
import {
  ApprovalExchange,
  conversationalChoices,
  matchConversationalChoice,
  renderConversationalApprovalPrompt,
} from "../../src/msp/approvals.js";

const BLUE_RED_CYAN = [
  { choiceId: "allow-once", decision: "approve", label: "Blue", scope: "once" },
  { choiceId: "allow-session", decision: "approve", label: "Red", scope: "session" },
  { choiceId: "deny-once", decision: "reject", label: "Cyan", scope: "once" },
];

function choices() {
  return conversationalChoices(BLUE_RED_CYAN);
}

describe("Conversational approval matching", () => {
  test("conversational.matchesLetterNumberAndNameForms", () => {
    expect(matchConversationalChoice(choices(), "A")?.choiceId).toBe("allow-once");
    expect(matchConversationalChoice(choices(), "a")?.choiceId).toBe("allow-once");
    expect(matchConversationalChoice(choices(), "Blue")?.choiceId).toBe("allow-once");
    expect(matchConversationalChoice(choices(), "blue")?.choiceId).toBe("allow-once");
    expect(matchConversationalChoice(choices(), "A Blue")?.choiceId).toBe("allow-once");
    expect(matchConversationalChoice(choices(), "a-blue")?.choiceId).toBe("allow-once");
    expect(matchConversationalChoice(choices(), "1")?.choiceId).toBe("allow-once");
    expect(matchConversationalChoice(choices(), "  C  ")?.choiceId).toBe("deny-once");
  });

  test("conversational.rejectsMeaningBasedAndUnknownInput", () => {
    for (const input of ["yes", "ok", "go ahead", "D", "4", "Yellow", "Blueish", ""]) {
      expect(matchConversationalChoice(choices(), input)).toBeNull();
    }
  });

  test("conversational.rejectsAmbiguousTies", () => {
    const dupes = conversationalChoices([
      { choiceId: "edit-once", decision: "approve", label: "Edit file", scope: "once" },
      { choiceId: "edit-always", decision: "approve", label: "Edit file", scope: "session" },
    ]);
    expect(matchConversationalChoice(dupes, "edit file")).toBeNull();
    expect(matchConversationalChoice(dupes, "A")?.choiceId).toBe("edit-once");
  });

  test("conversational.prefersExactLabelsOverSubstrings", () => {
    const pair = conversationalChoices([
      { choiceId: "read", decision: "approve", label: "Read", scope: "once" },
      { choiceId: "reread", decision: "approve", label: "Reread", scope: "once" },
    ]);
    expect(matchConversationalChoice(pair, "read")?.choiceId).toBe("read");
    expect(matchConversationalChoice(pair, "reread")?.choiceId).toBe("reread");
  });
});

describe("Conversational approval prompt", () => {
  test("conversational.rendersVerbatimChoicesWithContract", () => {
    const text = renderConversationalApprovalPrompt({ toolName: "edit_file", choices: choices(), attempt: 0 });
    expect(text).toContain("opencode-muse");
    expect(text).toContain("edit_file");
    expect(text).toContain("A. Blue");
    expect(text).toContain("B. Red");
    expect(text).toContain("C. Cyan");
    expect(text).toContain("Reply with one option");
  });

  test("conversational.restatesOnReask", () => {
    const text = renderConversationalApprovalPrompt({ choices: choices(), attempt: 1, received: "bleu" });
    expect(text).toContain("bleu");
    expect(text).toContain("A. Blue");
  });
});

describe("Conversational approval exchange", () => {
  function pendingParams(approvalId = "appr_1") {
    return {
      approvalId,
      currentRequirementId: "req_1",
      availableChoices: BLUE_RED_CYAN,
      sessionId: "ses_muse_1",
      turnId: "turn_1",
      toolCallId: "call_1",
      toolName: "edit_file",
    };
  }

  test("conversational.tracksVerdictAttempts", () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    expect(exchange.noteVerdictAttempt("missing")).toBe(-1);
    void exchange.requestApproval(pendingParams());
    expect(exchange.noteVerdictAttempt("appr_1")).toBe(0);
    expect(exchange.noteVerdictAttempt("appr_1")).toBe(1);
  });

  test("conversational.settlesAnExplicitChoice", async () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    const pending = exchange.requestApproval(pendingParams());
    expect(exchange.settleChoice("appr_1", "allow-session")).toBe(true);
    const verdict = await pending;
    expect(verdict).toMatchObject({ choiceId: "allow-session" });
    expect(exchange.settleChoice("appr_1", "allow-session")).toBe(false);
  });

  test("conversational.describesPendingInOrder", () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    void exchange.requestApproval(pendingParams("appr_1"));
    void exchange.requestApproval({ ...pendingParams("appr_2"), toolName: "shell" });
    const described = exchange.describePending();
    expect(described.map((entry) => entry.approvalId)).toEqual(["appr_1", "appr_2"]);
    expect(described[0]?.choices.map((choice) => choice.label)).toEqual(["Blue", "Red", "Cyan"]);
    expect(described[0]?.toolName).toBe("edit_file");
    expect(described[1]?.toolName).toBe("shell");
  });
});
