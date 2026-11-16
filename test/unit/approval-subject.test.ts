import { describe, expect, test } from "bun:test";
import {
  ApprovalExchange,
  conversationalChoices,
  renderConversationalApprovalPrompt,
} from "../../src/msp/approvals.js";

const NETWORK_CHOICES = [
  { choiceId: "allow-once", decision: "approve", label: "Allow once", scope: "once" },
  { choiceId: "allow-session", decision: "approve", label: "Allow for this session", scope: "session" },
  {
    choiceId: "allow-persistent",
    decision: "approve",
    label: "Always allow this network destination",
    scope: "localPersistent",
    rulePreview: "allow network host=screenrant.com port=443 protocol=https",
  },
  { choiceId: "deny-once", decision: "reject", label: "Reject", scope: "once" },
];

function choices() {
  return conversationalChoices(NETWORK_CHOICES);
}

describe("Approval subject rendering", () => {
  test("subject.networkShowsProtocolHostAndPort", () => {
    const text = renderConversationalApprovalPrompt({
      toolName: "network",
      choices: choices(),
      attempt: 0,
      subject: { kind: "network", host: "screenrant.com", port: 443, protocol: "https" },
    });
    expect(text).toContain("screenrant.com");
    expect(text).toContain("443");
    expect(text).toContain("https");
    // The lettered contract is unchanged.
    expect(text).toContain("A. Allow once");
    expect(text).toContain("Reply with one option");
  });

  test("subject.networkWithoutPortOrProtocolStillNamesTheHost", () => {
    const text = renderConversationalApprovalPrompt({
      toolName: "network",
      choices: choices(),
      attempt: 0,
      subject: { kind: "network", host: "example.org" },
    });
    expect(text).toContain("example.org");
  });

  test("subject.shellShowsTheCommand", () => {
    const text = renderConversationalApprovalPrompt({
      toolName: "powershell",
      choices: choices(),
      attempt: 0,
      subject: { kind: "shell", command: "Get-Content report.log" },
    });
    expect(text).toContain("Get-Content report.log");
  });

  test("subject.fileAccessShowsAccessAndPath", () => {
    const text = renderConversationalApprovalPrompt({
      choices: choices(),
      attempt: 0,
      subject: { kind: "fileAccess", access: "write", path: "notes/today.md" },
    });
    expect(text).toContain("write");
    expect(text).toContain("notes/today.md");
  });

  test("subject.processShowsTheTarget", () => {
    const text = renderConversationalApprovalPrompt({
      choices: choices(),
      attempt: 0,
      subject: { kind: "process", target: "notepad.exe" },
    });
    expect(text).toContain("notepad.exe");
  });

  test("subject.unknownKindFallsBackToBoundedRawArgs", () => {
    const text = renderConversationalApprovalPrompt({
      choices: choices(),
      attempt: 0,
      subject: { kind: "telepathy" },
      rawArgs: '{"thought":"hello"}',
    });
    expect(text).toContain('{"thought":"hello"}');
  });

  test("subject.absentSubjectWithRawArgsStillShowsTheArgs", () => {
    const text = renderConversationalApprovalPrompt({
      toolName: "network",
      choices: choices(),
      attempt: 0,
      rawArgs: '{"url":"https://example.org/x"}',
    });
    expect(text).toContain("https://example.org/x");
  });

  test("subject.noSubjectNoArgsKeepsTheLegacyPromptShape", () => {
    const text = renderConversationalApprovalPrompt({ toolName: "edit_file", choices: choices(), attempt: 0 });
    expect(text).toContain("Muse wants to run `edit_file`.");
    expect(text).not.toContain("Target:");
  });

  test("subject.choiceRulePreviewIsShownVerbatim", () => {
    const text = renderConversationalApprovalPrompt({
      toolName: "network",
      choices: choices(),
      attempt: 0,
      subject: { kind: "network", host: "screenrant.com", port: 443, protocol: "https" },
    });
    expect(text).toContain("allow network host=screenrant.com port=443 protocol=https");
  });

  test("subject.reviewerReasonIsShown", () => {
    const text = renderConversationalApprovalPrompt({
      choices: choices(),
      attempt: 0,
      subject: { kind: "shell", command: "rm -rf build" },
      reviewerReason: "Destructive removal outside the workspace.",
    });
    expect(text).toContain("Destructive removal outside the workspace.");
  });

  test("subject.controlCharactersAreFoldedToOneLine", () => {
    const text = renderConversationalApprovalPrompt({
      choices: choices(),
      attempt: 0,
      subject: { kind: "shell", command: "echo a\nb\tc\rd\u0000e" },
    });
    const targetLine = text.split("\n").find((line) => line.startsWith("Target:"));
    expect(targetLine).toBeDefined();
    expect(targetLine).toContain("echo a b c d e");
    expect(targetLine).not.toContain("\u0000");
  });

  test("subject.formatScalarsAreFoldedToo", () => {
    const text = renderConversationalApprovalPrompt({
      choices: choices(),
      attempt: 0,
      subject: { kind: "shell", command: "echo a\u2028b\u2029c\u202ed\ufeffe" },
    });
    const targetLine = text.split("\n").find((line) => line.startsWith("Target:"));
    expect(targetLine).toBeDefined();
    expect(targetLine).toContain("echo a b c d e");
    expect(targetLine).not.toContain("\u2028");
    expect(targetLine).not.toContain("\u2029");
    expect(targetLine).not.toContain("\u202e");
    expect(targetLine).not.toContain("\ufeff");
  });

  test("subject.longValuesAreCapped", () => {
    const long = "x".repeat(2000);
    const text = renderConversationalApprovalPrompt({
      choices: choices(),
      attempt: 0,
      subject: { kind: "shell", command: long },
    });
    expect(text).not.toContain(long);
    expect(text).toContain("…");
    const targetLine = text.split("\n").find((line) => line.startsWith("Target:"));
    expect((targetLine ?? "").length).toBeLessThanOrEqual(340);
  });

  test("subject.reaskKeepsTheSubject", () => {
    const text = renderConversationalApprovalPrompt({
      choices: choices(),
      attempt: 1,
      received: "maybe",
      subject: { kind: "network", host: "example.org", port: 443, protocol: "https" },
    });
    expect(text).toContain("example.org");
    expect(text).toContain("maybe");
  });

  test("subject.malformedSubjectIsIgnoredNotFatal", () => {
    const text = renderConversationalApprovalPrompt({
      choices: choices(),
      attempt: 0,
      subject: { host: "no-kind.example" } as never,
      rawArgs: 42 as never,
    });
    expect(text).toContain("A. Allow once");
    expect(text).not.toContain("no-kind.example");
  });
});

describe("Approval exchange subject passthrough", () => {
  function wireParams(approvalId = "appr_net") {
    return {
      approvalId,
      currentRequirementId: { approvalId, sourceIndex: 0 },
      availableChoices: NETWORK_CHOICES,
      sessionId: "ses_muse_1",
      turnId: "turn_1",
      toolCallId: "call_1",
      toolName: "network",
      subject: { kind: "network", host: "screenrant.com", port: 443, protocol: "https" },
      rawArgs: '{"url":"https://screenrant.com/article"}',
      reviewerReason: "First connection to this host.",
    };
  }

  test("exchange.describePendingCarriesSubjectArgsAndReason", () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    void exchange.requestApproval(wireParams());
    const [pending] = exchange.describePending();
    expect(pending?.subject).toEqual({ kind: "network", host: "screenrant.com", port: 443, protocol: "https" });
    expect(pending?.rawArgs).toBe('{"url":"https://screenrant.com/article"}');
    expect(pending?.reviewerReason).toBe("First connection to this host.");
    expect(pending?.choices.find((choice) => choice.choiceId === "allow-persistent")?.rulePreview)
      .toBe("allow network host=screenrant.com port=443 protocol=https");
    exchange.settleChoice("appr_net", "allow-once");
  });

  test("exchange.malformedSubjectFieldsAreDropped", () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    void exchange.requestApproval({
      ...wireParams("appr_bad"),
      subject: { host: "missing-kind.example" },
      rawArgs: 7,
      reviewerReason: { text: "nope" },
    });
    const [pending] = exchange.describePending();
    expect(pending?.subject).toBeUndefined();
    expect(pending?.rawArgs).toBeUndefined();
    expect(pending?.reviewerReason).toBeUndefined();
    exchange.settleChoice("appr_bad", "allow-once");
  });

  test("exchange.verdictParamsKeepTheSubjectForTheDecidePath", async () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    const pending = exchange.requestApproval(wireParams("appr_v"));
    exchange.settleChoice("appr_v", "allow-persistent");
    const verdict = await pending;
    expect(verdict.params.subject).toEqual({ kind: "network", host: "screenrant.com", port: 443, protocol: "https" });
  });
});
