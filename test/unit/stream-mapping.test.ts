import { describe, expect, test } from "bun:test";
import { MuseStreamMapper } from "../../src/model/stream.js";
import type { MspNotification } from "../../src/msp/client.js";

const event = (method: string, params: Record<string, unknown>): MspNotification => ({ jsonrpc: "2.0", method, params });

describe("Muse → LanguageModelV3 stream mapping", () => {
  test("stream.emitsTextStartDeltaEndAndFinishFromItemLifecycle", () => {
    const mapper = new MuseStreamMapper("turn-1");
    const parts = [
      ...mapper.accept(event("item/started", { sessionId: "ses-1", item: { itemId: "item-1", turnId: "turn-1", kind: "agentMessage" } })),
      ...mapper.accept(event("item/delta", { sessionId: "ses-1", itemId: "item-1", field: "text", delta: "Hello " })),
      ...mapper.accept(event("item/delta", { sessionId: "ses-1", itemId: "item-1", field: "text", delta: "world" })),
      ...mapper.accept(event("item/completed", { sessionId: "ses-1", item: { itemId: "item-1", turnId: "turn-1", kind: "agentMessage", status: "completed", text: "Hello world" } })),
      ...mapper.accept(event("turn/completed", { sessionId: "ses-1", turnId: "turn-1", terminal: "completed" })),
    ];

    expect(parts.map((part) => part.type)).toEqual(["text-start", "text-delta", "text-delta", "text-end", "finish"]);
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["Hello ", "world"]);
    expect(mapper.generatedText).toBe("Hello world");
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop", raw: "completed" } });
  });

  test("stream.completedAgentMessageProvidesTextWhenNoDeltaWasObserved", () => {
    const mapper = new MuseStreamMapper("turn-1");
    const parts = [
      ...mapper.accept(event("item/started", { sessionId: "ses-1", item: { itemId: "item-1", turnId: "turn-1", kind: "agentMessage" } })),
      ...mapper.accept(event("item/completed", { sessionId: "ses-1", item: { itemId: "item-1", turnId: "turn-1", kind: "agentMessage", status: "completed", text: "whole answer" } })),
    ];
    expect(parts.map((part) => part.type)).toEqual(["text-start", "text-delta", "text-end"]);
    expect(mapper.generatedText).toBe("whole answer");
  });

  test("stream.appendsAnAuthoritativeCompletionSuffixMissingFromObservedDeltas", () => {
    const mapper = new MuseStreamMapper("turn-1");
    const parts = [
      ...mapper.accept(event("item/started", { sessionId: "ses-1", item: { itemId: "item-1", turnId: "turn-1", kind: "agentMessage" } })),
      ...mapper.accept(event("item/delta", { sessionId: "ses-1", itemId: "item-1", field: "text", delta: "partial" })),
      ...mapper.accept(event("item/completed", { sessionId: "ses-1", item: { itemId: "item-1", turnId: "turn-1", kind: "agentMessage", status: "completed", text: "partial answer" } })),
    ];
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["partial", " answer"]);
    expect(mapper.generatedText).toBe("partial answer");
  });

  test("stream.failsClosedWhenAuthoritativeCompletionContradictsStreamedText", () => {
    const mapper = new MuseStreamMapper("turn-1");
    mapper.accept(event("item/started", { sessionId: "ses-1", item: { itemId: "item-1", turnId: "turn-1", kind: "agentMessage" } }));
    mapper.accept(event("item/delta", { sessionId: "ses-1", itemId: "item-1", field: "text", delta: "streamed" }));

    const parts = mapper.accept(event("item/completed", {
      sessionId: "ses-1",
      item: { itemId: "item-1", turnId: "turn-1", kind: "agentMessage", status: "completed", text: "different" },
    }));
    expect(parts.map((part) => part.type)).toEqual(["error"]);
    expect(JSON.stringify(parts)).not.toContain("different");
    expect(mapper.accept(event("turn/completed", {
      sessionId: "ses-1", turnId: "turn-1", terminal: "completed",
    })).at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "error" } });
  });

  test("stream.ignoresMuseToolItemsAndNeverEmitsOpenCodeToolCalls", () => {
    const mapper = new MuseStreamMapper("turn-1");
    const parts = [
      ...mapper.accept(event("item/started", { sessionId: "ses-1", item: { itemId: "tool-1", turnId: "turn-1", kind: "toolCall", tool: "shell" } })),
      ...mapper.accept(event("item/completed", { sessionId: "ses-1", item: { itemId: "tool-1", turnId: "turn-1", kind: "toolCall", status: "completed", tool: "shell" } })),
    ];
    expect(parts).toEqual([]);
  });

  test("stream.mapsOnlySummarizedReasoningAndNeverExposesRawReasoning", () => {
    const mapper = new MuseStreamMapper("turn-1");
    const parts = [
      ...mapper.accept(event("item/started", { sessionId: "ses-1", item: { itemId: "reason-1", turnId: "turn-1", kind: "reasoning" } })),
      ...mapper.accept(event("item/delta", { sessionId: "ses-1", itemId: "reason-1", field: "summary.0", delta: "safe summary" })),
      ...mapper.accept(event("item/completed", { sessionId: "ses-1", item: { itemId: "reason-1", turnId: "turn-1", kind: "reasoning", status: "completed", text: "raw-private-reasoning", summary: ["safe summary"] } })),
    ];
    expect(parts.map((part) => part.type)).toEqual(["reasoning-start", "reasoning-delta", "reasoning-end"]);
    expect(JSON.stringify(parts)).not.toContain("raw-private-reasoning");
  });

  test("stream.usesPerCompletionUsageAndNeverSumsCumulativeSnapshots", () => {
    const mapper = new MuseStreamMapper("turn-1");
    mapper.accept(event("session/tokenUsage", {
      sessionId: "ses-1", turnId: "turn-1", viewCursor: "cursor-1", promptTokens: 10, totalTokens: 15,
      usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 1, cachedTokens: 0 },
      cumulative: { inputTokens: 10_000, outputTokens: 100, reasoningTokens: 50 },
    }));
    mapper.accept(event("session/tokenUsage", {
      sessionId: "ses-1", turnId: "turn-1", viewCursor: "cursor-1", promptTokens: 10, totalTokens: 15,
      usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 1, cachedTokens: 0 },
      cumulative: { inputTokens: 10_000, outputTokens: 100, reasoningTokens: 50 },
    }));
    mapper.accept(event("session/tokenUsage", {
      sessionId: "ses-1", turnId: "turn-1", viewCursor: "cursor-2", promptTokens: 3, totalTokens: 5,
      usage: { inputTokens: 4, outputTokens: 2, reasoningTokens: 0, cachedTokens: 0 },
      cumulative: { inputTokens: 10_003, outputTokens: 102, reasoningTokens: 50 },
    }));
    mapper.accept(event("turn/completed", { sessionId: "ses-1", turnId: "turn-1", terminal: "completed" }));

    expect(mapper.usage).toEqual({ inputTokens: 13, outputTokens: 7, totalTokens: 20, reasoningTokens: 1 });
  });

  test("stream.deduplicatesUsageByNotificationRatherThanCursorAlone", () => {
    const mapper = new MuseStreamMapper("turn-1");
    mapper.accept(event("session/tokenUsage", {
      sessionId: "ses-1", turnId: "turn-1", viewCursor: "cursor-1", promptTokens: 10, totalTokens: 12,
      usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 0, cachedTokens: 0 },
    }));
    const second = event("session/tokenUsage", {
      sessionId: "ses-1", turnId: "turn-1", viewCursor: "cursor-1", promptTokens: 20, totalTokens: 25,
      usage: { inputTokens: 20, outputTokens: 5, reasoningTokens: 1, cachedTokens: 0 },
    });
    mapper.accept(second);
    mapper.accept(event("session/tokenUsage", {
      usage: { reasoningTokens: 1, outputTokens: 5, inputTokens: 20, cachedTokens: 0 },
      totalTokens: 25,
      promptTokens: 20,
      viewCursor: "cursor-1",
      turnId: "turn-1",
      sessionId: "ses-1",
    }));

    expect(mapper.usage).toEqual({ inputTokens: 30, outputTokens: 7, totalTokens: 37, reasoningTokens: 1 });
  });

  test("stream.terminalPerTurnUsageOverridesCallSnapshotsWhenPresent", () => {
    const mapper = new MuseStreamMapper("turn-1");
    mapper.accept(event("session/tokenUsage", {
      sessionId: "ses-1", turnId: "turn-1", viewCursor: "cursor-1", promptTokens: 10, totalTokens: 15,
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 1, cachedTokens: 0 },
    }));
    mapper.accept(event("turn/completed", {
      sessionId: "ses-1", turnId: "turn-1", terminal: "completed",
      usage: { inputTokens: 8, outputTokens: 2, reasoningTokens: 0, cachedTokens: 0 },
    }));
    expect(mapper.usage).toEqual({ inputTokens: 8, outputTokens: 2, totalTokens: 10, reasoningTokens: 0 });
  });

  test("stream.doesNotFabricateUsageWhenMuseReportsNone", () => {
    const mapper = new MuseStreamMapper("turn-1");
    mapper.accept(event("turn/completed", { sessionId: "ses-1", turnId: "turn-1", terminal: "completed" }));
    expect(mapper.usage).toBeUndefined();
  });

  test("stream.finishesForegroundAnswerButAcceptsBackgroundTerminalForMonitoring", () => {
    const mapper = new MuseStreamMapper("turn-1");
    const foreground = mapper.accept(event("turn/foregroundCompleted", {
      sessionId: "ses-1", turnId: "turn-1", viewCursor: "cursor-1",
    }));
    expect(foreground).toMatchObject([{ type: "finish", finishReason: { unified: "stop", raw: "foregroundCompleted" } }]);
    expect(mapper.finishWasSentToOpenCode).toBe(true);

    const terminal = mapper.accept(event("turn/completed", {
      sessionId: "ses-1", turnId: "turn-1", terminal: "completed",
    }));
    expect(terminal).toEqual([]);
    expect(mapper.terminal).toBe("completed");
  });

  test("stream.mapsFailuresAndUnknownTerminalValuesWithoutLeakingMessages", () => {
    const failed = new MuseStreamMapper("turn-1");
    const failedParts = failed.accept(event("turn/completed", {
      sessionId: "ses-1", turnId: "turn-1", terminal: "failed",
      error: { kind: "modelError", message: "private provider details", retryable: true },
    }));
    expect(failedParts.map((part) => part.type)).toEqual(["error", "finish"]);
    expect(JSON.stringify(failedParts)).not.toContain("private provider details");

    const future = new MuseStreamMapper("turn-2");
    const futureParts = future.accept(event("turn/completed", { sessionId: "ses-1", turnId: "turn-2", terminal: "futureTerminal" }));
    expect(futureParts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "other", raw: "futureTerminal" } });
  });

  test("stream.sanitizesAnUntrustedFailureKindBeforeExposingIt", () => {
    const mapper = new MuseStreamMapper("turn-1");
    const parts = mapper.accept(event("turn/completed", {
      sessionId: "ses-1",
      turnId: "turn-1",
      terminal: "failed",
      error: { kind: "credential-looking-private-detail", message: "private", retryable: false },
    }));
    expect(JSON.stringify(parts)).not.toContain("credential-looking-private-detail");
    expect(JSON.stringify(parts)).not.toContain("private");
    expect(parts[0]?.error).toMatchObject({ turnErrorKind: "unknown" });
  });

  test("stream.endsTheTurnWithAConversationalPromptForAnApprovalRequestedNotification", () => {
    const mapper = new MuseStreamMapper("turn-1", new Set(), (approvalId) => approvalId === "approval-1"
      ? {
        choices: [
          { choiceId: "allow-once", label: "Allow once", scope: "once" },
          { choiceId: "deny-once", label: "Deny", scope: "once" },
        ],
        toolName: "shell",
      }
      : undefined);
    const parts = mapper.accept(event("approval/requested", {
      sessionId: "ses-1",
      turnId: "turn-1",
      approvalId: "approval-1",
      currentRequirementId: "req-1",
      toolCallId: "call-1",
      toolName: "shell",
    }));
    expect(parts.map((part) => (part as { type: string }).type)).toEqual([
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const delta = (parts[1] as { delta: string }).delta;
    expect(delta).toContain("opencode-muse bridge message");
    expect(delta).toContain("shell");
    expect(delta).toContain("A. Allow once (once)");
    expect(delta).toContain("B. Deny (once)");
    expect(delta).toContain("Reply with one option");
    expect((parts[3] as { finishReason: { unified: string } }).finishReason).toMatchObject({ unified: "stop" });
  });

  test("stream.linksWireRequirementObjectsToParkedChoices", () => {
    // The notification carries currentRequirementId as the wire object; the
    // mapper must resolve it to the same canonical stage key the exchange
    // parked, or every real approval renders the choiceless notice.
    const seen: Array<{ approvalId: string; requirementId: string }> = [];
    const mapper = new MuseStreamMapper("turn-1", new Set(), (approvalId, requirementId) => {
      seen.push({ approvalId, requirementId });
      return requirementId === "approval-1:0"
        ? {
          choices: [{ choiceId: "allow-once", label: "Allow once", scope: "once" }],
          toolName: "network",
        }
        : undefined;
    });
    const parts = mapper.accept(event("approval/requested", {
      sessionId: "ses-1",
      approvalId: "approval-1",
      currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
      toolCallId: "call-1",
      toolName: "network",
    }));
    expect(seen).toEqual([{ approvalId: "approval-1", requirementId: "approval-1:0" }]);
    const delta = (parts[1] as { delta: string }).delta;
    expect(delta).toContain("A. Allow once (once)");
    expect(delta).not.toContain("no presentable options");
  });

  test("stream.fallsBackToTheNotificationToolNameWithoutACatalogLookup", () => {
    const mapper = new MuseStreamMapper("turn-1");
    const parts = mapper.accept(event("approval/requested", {
      sessionId: "ses-1",
      approvalId: "approval-1",
      toolCallId: "call-1",
      toolName: "shell",
    }));
    const delta = (parts[1] as { delta: string }).delta;
    expect(delta).toContain("shell");
    expect(delta).toContain("denies on timeout");
  });

  test("stream.explainsWhenNoChoicesArePresentable", () => {
    const mapper = new MuseStreamMapper("turn-1", new Set(), () => ({ choices: [] }));
    const parts = mapper.accept(event("approval/requested", {
      sessionId: "ses-1",
      approvalId: "approval-1",
      toolCallId: "call-1",
    }));
    expect(parts.map((part) => (part as { type: string }).type)).toEqual([
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect((parts[1] as { delta: string }).delta).toContain("no presentable options");
  });

  test("stream.ignoresMalformedApprovalRequestsWithoutEmitting", () => {
    const mapper = new MuseStreamMapper("turn-1");
    expect(mapper.accept(event("approval/requested", { sessionId: "ses-1" }))).toEqual([]);
    expect(mapper.accept(event("approval/requested", {
      sessionId: "ses-1",
      approvalId: "approval-1",
    }))).toEqual([]);
  });

  test("stream.endsTheTurnWithAConversationalQuestionForAUserInputRequest", () => {
    const mapper = new MuseStreamMapper("turn-1");
    const parts = mapper.accept(event("userInput/requested", {
      sessionId: "ses-1",
      userInputId: "ui-1",
      toolName: "shell",
      questions: [{
        id: "q-color",
        header: "Pick a color",
        question: "Which color?",
        options: [{ label: "Blue" }, { label: "Red" }],
      }],
    }));
    expect(parts.map((part) => (part as { type: string }).type)).toEqual([
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const delta = (parts[1] as { delta: string }).delta;
    expect(delta).toContain("opencode-muse bridge message");
    expect(delta).toContain("Pick a color");
    expect(delta).toContain("A. Blue");
    expect(delta).toContain("Reply with one option");
    expect((parts[3] as { finishReason: { unified: string } }).finishReason).toMatchObject({ unified: "stop" });
  });

  test("stream.prefersTheExchangeLookupOverStaleEventQuestions", () => {
    const mapper = new MuseStreamMapper("turn-1", new Set(), undefined, () => ({
      question: { id: "q-live", header: "Live", question: "Live question?", options: [{ label: "Yes" }] },
    }));
    const parts = mapper.accept(event("userInput/requested", {
      sessionId: "ses-1",
      userInputId: "ui-1",
      questions: [],
    }));
    const delta = (parts[1] as { delta: string }).delta;
    expect(delta).toContain("Live question?");
  });

  test("stream.ignoresMalformedUserInputRequestsWithoutEmitting", () => {
    const mapper = new MuseStreamMapper("turn-1");
    expect(mapper.accept(event("userInput/requested", {
      sessionId: "ses-1",
      toolCallId: "call-1",
    }))).toEqual([]);
    expect(mapper.accept(event("userInput/requested", {
      sessionId: "ses-1",
      userInputId: "ui-1",
      questions: [{ id: "q-bad", header: "Bad", question: "Bad?", options: [] }],
    })).map((part) => (part as { type: string }).type)).toEqual([
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  test("stream.emitsEachApprovalStageOnceAcrossMapperInstances", () => {
    const emitted = new Set<string>();
    const first = new MuseStreamMapper("turn-1", emitted);
    expect(first.accept(event("approval/requested", {
      sessionId: "ses-1",
      approvalId: "approval-1",
      currentRequirementId: "req-1",
      toolCallId: "call-1",
    }))).toHaveLength(4);
    expect(first.accept(event("approval/requested", {
      sessionId: "ses-1",
      approvalId: "approval-1",
      currentRequirementId: "req-1",
      toolCallId: "call-1",
    }))).toEqual([]);
    const second = new MuseStreamMapper("turn-1", emitted);
    expect(second.accept(event("approval/requested", {
      sessionId: "ses-1",
      approvalId: "approval-1",
      currentRequirementId: "req-1",
      toolCallId: "call-1",
    }))).toEqual([]);
    expect(second.accept(event("approval/requested", {
      sessionId: "ses-1",
      approvalId: "approval-1",
      currentRequirementId: "req-2",
      toolCallId: "call-1",
    }))).toHaveLength(4);
  });
});
