import { describe, expect, test } from "bun:test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { createMuseLanguageModel, type MuseLanguageRuntime, type MuseTurnSession } from "../../src/model/language-model.js";
import { addRequestContextHeaders } from "../../src/model/context.js";
import { openCodeModelId } from "../../src/catalog.js";
import type { MuseModelSelection, RequestContext } from "../../src/types.js";
import type { MspNotification } from "../../src/msp/client.js";
import { MspCommandRejectedError, MspCommandTimeoutError } from "../../src/errors.js";
import { fingerprintCompactionOutput } from "../../src/session/fingerprint.js";

const modelID = openCodeModelId("tbh", "muse-wonder-1.0");
const selection: MuseModelSelection = {
  providerId: "meta",
  profileId: "tbh",
  modelId: "muse-wonder-1.0",
  isActive: false,
  isDefault: true,
  defaultReasoningEffort: "high",
  variantsKnown: true,
  variants: ["low", "high"],
};
const selectionIndex = new Map([[modelID, selection]]);

function event(method: string, params: Record<string, unknown>): MspNotification {
  return { jsonrpc: "2.0", method, params };
}

function callOptions(overrides: Record<string, unknown> = {}): LanguageModelV3CallOptions {
  const headers: Record<string, string> = {};
  addRequestContextHeaders(headers, {
    sessionID: "ses_model_test",
    kind: "primary",
    model: { id: modelID, providerID: "muse", variant: "high" },
    headers,
  }, "/workspace/model-test");
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "Return the probe answer." }] }],
    headers,
    tools: [{ type: "function", name: "shell", inputSchema: { type: "object", properties: {} } }],
    toolChoice: { type: "auto" },
    ...overrides,
  } as unknown as LanguageModelV3CallOptions;
}

function fakeRuntime(options: {
  events?: MspNotification[];
  disposition?: string;
  videoChunkBytes?: number;
  onTurnStart?: () => void;
  backgroundWaitAfterForeground?: Promise<void>;
  failTurnStart?: boolean;
  timeoutTurnStart?: boolean;
  blockSubscription?: boolean;
  failRecordTurnAccepted?: boolean;
  failClearPendingCommand?: boolean;
  viewPage?: Record<string, unknown>;
  viewPages?: Record<string, unknown>[];
  currentSelection?: Pick<MuseModelSelection, "providerId" | "modelId" | "profileId">;
  previousTranscriptFingerprints?: string[];
  compactionFingerprints?: string[];
  contextError?: string;
  joinParkedTurnId?: string;
  onDisarm?: () => void;
  streamEpoch?: number;
  handoffLeaseToJoiner?: boolean;
  emittedApprovalPrompts?: Set<string>;
  onCancelParked?: () => void;
  settleMatched?: string[];
  hasParkedApprovals?: boolean;
  effortPin?: string;
  gateEventsAfter?: { count: number; release: Promise<void> };
} = {}) {
  const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const order: string[] = [];
  const commandLifecycle: string[] = [];
  const pendingCommandMethods = new Map<string, string>();
  const cursorUpdates: string[] = [];
  let released = 0;
  let subscriptionReturns = 0;
  let markReleased!: () => void;
  const releasedPromise = new Promise<void>((resolve) => { markReleased = resolve; });
  let idCounter = 0;
  let pageIndex = 0;
  const host = {
    mintCommandId: () => `018f4f17-9c2a-7c1a-a0fd-67a19db5c0${String(idCounter++).padStart(2, "0")}`,
    async command(method: string, params: Record<string, unknown>) {
      commands.push({ method, params });
      order.push(method);
      if (method === "turn/start") {
        options.onTurnStart?.();
        if (options.timeoutTurnStart) throw new MspCommandTimeoutError(method, 10);
        if (options.failTurnStart) throw new MspCommandRejectedError(method, -32030, "commandRejected", false);
        return { turnId: "turn-1", disposition: options.disposition ?? "started" };
      }
      if (method === "media/upload") return { uploadId: params.uploadId };
      return { status: "accepted" };
    },
    async request(method: string, params?: Record<string, unknown>) {
      requests.push({ method, params });
      if (options.viewPages) return options.viewPages[pageIndex++] ?? { events: [], nextCursor: null };
      return options.viewPage ?? {};
    },
    subscribe(sessionId: string, after?: string, signal?: AbortSignal) {
      order.push(after === undefined ? "subscribe-live" : "subscribe-replay");
      if (options.blockSubscription) {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<MspNotification>>((resolve) => {
                signal?.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
              }),
              async return() {
                subscriptionReturns += 1;
                return { done: true, value: undefined } as IteratorResult<MspNotification>;
              },
            };
          },
        };
      }
      return {
        async *[Symbol.asyncIterator]() {
          try {
            let index = 0;
            let gated = false;
            for (const notification of options.events ?? []) {
              if (!gated && options.gateEventsAfter && index >= options.gateEventsAfter.count) {
                gated = true;
                await options.gateEventsAfter.release;
              }
              yield notification;
              index += 1;
              if (notification.method === "turn/foregroundCompleted" && options.backgroundWaitAfterForeground) {
                await options.backgroundWaitAfterForeground;
              }
            }
          } finally {
            subscriptionReturns += 1;
          }
        },
      };
    },
  };
  const session = {
    host,
    sessionId: "ses_model_test",
    currentSelection: options.currentSelection ?? {
      providerId: "meta",
      modelId: "muse-wonder-1.0",
      profileId: "tbh",
    },
    previousTranscriptFingerprints: options.previousTranscriptFingerprints ?? [],
    compactionFingerprints: options.compactionFingerprints ?? [],
    contextAllowlist: [],
    contextError: options.contextError,
    joinParkedTurnId: options.joinParkedTurnId,
    streamEpoch: options.streamEpoch,
    handoffLeaseToJoiner: options.handoffLeaseToJoiner,
    emittedApprovalPrompts: options.emittedApprovalPrompts,
    ...(options.onCancelParked ? { cancelParkedApprovals: async () => { options.onCancelParked?.(); } } : {}),
    async recordPendingCommand(command: { commandId: string; method: string }) {
      pendingCommandMethods.set(command.commandId, command.method);
      commandLifecycle.push(`pending:${command.method}`);
    },
    async clearPendingCommand(commandId: string) {
      const method = pendingCommandMethods.get(commandId);
      if (method) commandLifecycle.push(`clear:${method}`);
      pendingCommandMethods.delete(commandId);
      if (options.failClearPendingCommand) throw new Error("registry cleanup failed");
    },
    async recordTurnCompleted() {
      commandLifecycle.push("terminal");
      for (const method of pendingCommandMethods.values()) commandLifecycle.push(`clear:${method}`);
      pendingCommandMethods.clear();
    },
    async updateCursor(cursor: string) { cursorUpdates.push(cursor); },
    ...(options.failRecordTurnAccepted ? {
      async recordTurnAccepted() { throw new Error("registry write failed"); },
    } : {}),
    ...(options.failClearPendingCommand ? {
      async clearPendingCommand() { throw new Error("registry cleanup failed"); },
    } : {}),
    async release() { released += 1; markReleased(); },
  };
  const settledResponses: Array<{ sessionID: string; responses: Array<{ approvalId: string; approved: boolean }> }> = [];
  const runtime: MuseLanguageRuntime = {
    selectionIndex,
    videoChunkBytes: options.videoChunkBytes,
    async resolveSession() { return session as unknown as MuseTurnSession; },
    ...(options.settleMatched !== undefined ? {
      async settleApprovalResponses(sessionID: string, responses: Array<{ approvalId: string; approved: boolean }>) {
        settledResponses.push({ sessionID, responses });
        return options.settleMatched ?? [];
      },
    } : {}),
    ...(options.hasParkedApprovals !== undefined ? {
      hasParkedApprovals() { return options.hasParkedApprovals ?? false; },
    } : {}),
    ...(options.onDisarm ? {
      disarmParkedJoin() { options.onDisarm?.(); },
    } : {}),
    ...(options.effortPin !== undefined ? {
      effortPinForSession() { return options.effortPin; },
    } : {}),
  };
  return {
    runtime,
    session,
    commands,
    requests,
    commandLifecycle,
    order,
    cursorUpdates,
    settledResponses,
    get released() { return released; },
    releasedPromise,
    get subscriptionReturns() { return subscriptionReturns; },
  };
}

const textEvents = (turnId = "turn-1") => [
  event("turn/started", { sessionId: "ses_model_test", turnId }),
  event("item/started", { sessionId: "ses_model_test", item: { itemId: "msg-1", turnId, kind: "agentMessage" } }),
  event("item/delta", { sessionId: "ses_model_test", itemId: "msg-1", field: "text", delta: "Probe " }),
  event("item/delta", { sessionId: "ses_model_test", itemId: "msg-1", field: "text", delta: "answer" }),
  event("item/completed", { sessionId: "ses_model_test", item: { itemId: "msg-1", turnId, kind: "agentMessage", status: "completed", text: "Probe answer" } }),
  event("turn/foregroundCompleted", { sessionId: "ses_model_test", turnId }),
  event("turn/completed", { sessionId: "ses_model_test", turnId, terminal: "completed", usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 0, cachedTokens: 0 } }),
];

describe("Muse LanguageModelV3 bridge", () => {
  test("languageModel.doStreamEmitsV3TextAndNoOpenCodeToolCalls", async () => {
    const fake = fakeRuntime({ events: textEvents() });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doStream(callOptions());
    const reader = result.stream.getReader();
    const parts: Array<Record<string, unknown>> = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value as unknown as Record<string, unknown>);
    }

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start", "text-start", "text-delta", "text-delta", "text-end", "finish",
    ]);
    expect(parts.filter((part) => String(part.type).startsWith("tool-"))).toEqual([]);
    expect(fake.commands.filter((command) => command.method === "turn/start")).toHaveLength(1);
    expect(fake.commands.find((command) => command.method === "turn/start")?.params).toMatchObject({
      sessionId: "ses_model_test",
      reasoningEffort: "high",
      input: [{ type: "text", text: "Return the probe answer." }],
    });
  });

  test("languageModel.doGenerateCollectsTheSameSingleMuseTurn", async () => {
    const fake = fakeRuntime({ events: textEvents() });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doGenerate(callOptions());

    expect(result.content).toEqual([{ type: "text", text: "Probe answer" }]);
    expect(fake.commands.filter((command) => command.method === "turn/start")).toHaveLength(1);
    await fake.releasedPromise;
    expect(fake.released).toBe(1);
  });

  test("languageModel.preflightContextAndUnsupportedOptionsFailBeforeSessionResolution", async () => {
    let resolutions = 0;
    const fake = fakeRuntime();
    const runtime = {
      ...fake.runtime,
      async resolveSession(context: RequestContext) { resolutions += 1; return fake.runtime.resolveSession(context); },
    };
    const model = createMuseLanguageModel(runtime, modelID);

    await expect(model.doGenerate({ ...callOptions(), responseFormat: { type: "json", schema: { type: "object" } } } as never))
      .rejects.toThrow(/responseFormat/);
    await expect(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "No context" }] }], headers: {} } as never))
      .rejects.toThrow(/generate/);
    expect(resolutions).toBe(0);
  });

  test("languageModel.answersUnhookedTitleAndCompactionLocallyWithoutResolvingMuse", async () => {
    let resolutions = 0;
    const fake = fakeRuntime();
    const runtime: MuseLanguageRuntime = {
      ...fake.runtime,
      async resolveSession(context: RequestContext) {
        resolutions += 1;
        return fake.runtime.resolveSession(context);
      },
    };
    const model = createMuseLanguageModel(runtime, modelID);
    const title = await model.doGenerate({
      headers: {},
      prompt: [
        { role: "system", content: "You are a title generator. Output only a short title." },
        { role: "user", content: [{ type: "text", text: "Fix the login timeout." }] },
      ],
    } as never);
    const compaction = await model.doGenerate({
      headers: {},
      maxOutputTokens: 300,
      prompt: [
        { role: "system", content: "You are tasked with summarizing conversations." },
        { role: "user", content: [{ type: "text", text: "Initial request." }] },
        { role: "assistant", content: [{ type: "text", text: "Completed response." }] },
      ],
    } as never);

    expect(title.content).toEqual([{ type: "text", text: "Fix the login timeout." }]);
    expect(compaction.content[0]).toMatchObject({ type: "text" });
    expect((compaction.content[0] as { text: string }).text).toContain("Initial request.");
    expect(resolutions).toBe(0);
    expect(fake.commands).toEqual([]);
  });

  test("languageModel.rejectsUnknownStatelessGenerateWithoutResolvingMuse", async () => {
    let resolutions = 0;
    const fake = fakeRuntime();
    const runtime: MuseLanguageRuntime = {
      ...fake.runtime,
      async resolveSession(context: RequestContext) {
        resolutions += 1;
        return fake.runtime.resolveSession(context);
      },
    };
    const model = createMuseLanguageModel(runtime, modelID);
    await expect(model.doGenerate({
      headers: {},
      prompt: [{ role: "user", content: [{ type: "text", text: "Answer without a session." }] }],
    } as never)).rejects.toThrow(/generate/);
    expect(resolutions).toBe(0);
    expect(fake.commands).toEqual([]);
  });

  test("languageModel.continuesWhenTheExactCompactionSummaryWasObserved", async () => {
    const summary = "Transcript digest: this exact summary is in the current prompt.";
    const fake = fakeRuntime({
      events: textEvents(),
      previousTranscriptFingerprints: ["a".repeat(64), "b".repeat(64)],
      compactionFingerprints: [fingerprintCompactionOutput(summary)],
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doGenerate(callOptions({
      prompt: [
        { role: "user", content: [{ type: "text", text: summary }] },
        { role: "user", content: [{ type: "text", text: "Continue with this request." }] },
      ],
    }));

    expect(result.content).toEqual([{ type: "text", text: "Probe answer" }]);
    expect(fake.commands.find((command) => command.method === "turn/start")?.params.input)
      .toEqual([{ type: "text", text: "Continue with this request." }]);
    await fake.releasedPromise;
  });

  test("languageModel.doesNotRebaseOnAnUnobservedCompactionCandidate", async () => {
    const fake = fakeRuntime({
      previousTranscriptFingerprints: ["a".repeat(64), "b".repeat(64)],
      compactionFingerprints: [fingerprintCompactionOutput("summary expected but not persisted")],
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);

    await expect(model.doGenerate(callOptions({
      prompt: [
        { role: "user", content: [{ type: "text", text: "different summary text" }] },
        { role: "user", content: [{ type: "text", text: "Continue." }] },
      ],
    }))).rejects.toThrow(/fresh Muse session/i);
    expect(fake.commands.some((command) => command.method === "turn/start")).toBe(false);
  });

  test("languageModel.explainsThatTranscriptDivergenceRequiresFreshSessionRecovery", async () => {
    const fake = fakeRuntime({ previousTranscriptFingerprints: ["a".repeat(64), "b".repeat(64)] });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const error = await model.doGenerate(callOptions({
      prompt: [
        { role: "user", content: [{ type: "text", text: "same count, edited earlier turn" }] },
        { role: "assistant", content: [{ type: "text", text: "old assistant" }] },
        { role: "user", content: [{ type: "text", text: "latest" }] },
      ],
    })).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error?.name).toBe("MuseTranscriptDivergedError");
    expect(error?.message).toMatch(/fresh Muse session/i);
    expect(fake.commands.some((command) => command.method === "turn/start")).toBe(false);
  });

  test("languageModel.failsClosedWhenCustomAgentInstructionsCannotBeRepresented", async () => {
    const fake = fakeRuntime({ contextError: "agent-instructions-unrepresentable" });
    const model = createMuseLanguageModel(fake.runtime, modelID);

    await expect(model.doGenerate(callOptions())).rejects.toThrow(/agent-instructions-unrepresentable/);
    expect(fake.commands.some((command) => command.method === "turn/start")).toBe(false);
    expect(fake.released).toBe(1);
  });

  test("languageModel.pagesAndDeduplicatesTheMissingViewRange", async () => {
    const pageEvent = event("item/completed", {
      sessionId: "ses_model_test",
      viewCursor: "cursor-4",
      item: { itemId: "msg-gap", turnId: "turn-1", kind: "agentMessage", status: "completed", text: "Recovered answer" },
    });
    const fake = fakeRuntime({
      events: [
        event("turn/started", { sessionId: "ses_model_test", turnId: "turn-1", viewCursor: "cursor-1" }),
        event("view/gap", { sessionId: "ses_model_test", after: "cursor-2", next: "cursor-5" }),
        event("item/completed", {
          sessionId: "ses_model_test",
          viewCursor: "cursor-4",
          item: { itemId: "msg-gap", turnId: "turn-1", kind: "agentMessage", status: "completed", text: "Recovered answer" },
        }),
        event("turn/completed", { sessionId: "ses_model_test", turnId: "turn-1", terminal: "completed", viewCursor: "cursor-5" }),
      ],
      viewPage: { events: [pageEvent, event("turn/completed", { sessionId: "ses_model_test", turnId: "turn-1", terminal: "completed", viewCursor: "cursor-5" })], nextCursor: "cursor-5" },
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doGenerate(callOptions());

    expect(result.content).toEqual([{ type: "text", text: "Recovered answer" }]);
    expect(fake.requests).toEqual([{
      method: "view/page",
      params: { sessionId: "ses_model_test", cursor: "cursor-2", direction: "forward", limit: 1000 },
    }]);
    expect(fake.cursorUpdates).toEqual(["cursor-1", "cursor-4", "cursor-5"]);
    expect(result.finishReason).toMatchObject({ raw: "completed", unified: "stop" });
  });

  test("languageModel.keepsDistinctNotificationsThatShareAViewCursor", async () => {
    const sharedCursor = "cursor-shared-terminal";
    const fake = fakeRuntime({
      events: [
        event("turn/started", { sessionId: "ses_model_test", turnId: "turn-1", viewCursor: "cursor-start" }),
        event("session/statusChanged", { sessionId: "ses_model_test", status: { type: "idle" }, viewCursor: sharedCursor }),
        event("turn/completed", {
          sessionId: "ses_model_test",
          turnId: "turn-1",
          terminal: "completed",
          viewCursor: sharedCursor,
        }),
      ],
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);

    const result = await model.doGenerate(callOptions());

    expect(result.finishReason).toMatchObject({ raw: "completed", unified: "stop" });
    await fake.releasedPromise;
    expect(fake.released).toBe(1);
  });

  test("languageModel.pagesDistinctNotificationsThatShareAViewCursor", async () => {
    const fake = fakeRuntime({
      events: [
        event("turn/started", { sessionId: "ses_model_test", turnId: "turn-1", viewCursor: "cursor-start" }),
        event("view/gap", { sessionId: "ses_model_test", after: "cursor-after", next: "cursor-next" }),
      ],
      viewPages: [
        {
          events: [
            event("session/statusChanged", { sessionId: "ses_model_test", status: { type: "idle" }, viewCursor: "cursor-shared" }),
            event("turn/completed", {
              sessionId: "ses_model_test",
              turnId: "turn-1",
              terminal: "completed",
              viewCursor: "cursor-shared",
            }),
          ],
          nextCursor: "cursor-page-next",
        },
      ],
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);

    const result = await model.doGenerate(callOptions());

    expect(result.finishReason).toMatchObject({ raw: "completed", unified: "stop" });
    await fake.releasedPromise;
    expect(fake.released).toBe(1);
  });

  test("languageModel.pagesEveryNotificationAtTheGapBoundaryCursor", async () => {
    const boundary = "cursor-boundary";
    const fake = fakeRuntime({
      events: [
        event("turn/started", { sessionId: "ses_model_test", turnId: "turn-1", viewCursor: "cursor-start" }),
        event("view/gap", { sessionId: "ses_model_test", after: "cursor-after", next: boundary }),
      ],
      viewPage: {
        events: [
          event("session/statusChanged", { sessionId: "ses_model_test", status: { type: "idle" }, viewCursor: boundary }),
          event("session/branchChanged", { sessionId: "ses_model_test", branch: null, viewCursor: "cursor-interleaved" }),
          event("turn/completed", {
            sessionId: "ses_model_test",
            turnId: "turn-1",
            terminal: "completed",
            viewCursor: boundary,
          }),
          event("session/branchChanged", { sessionId: "ses_model_test", branch: null, viewCursor: "cursor-after-boundary" }),
        ],
        nextCursor: "cursor-after-boundary",
      },
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);

    const result = await model.doGenerate(callOptions());

    expect(result.finishReason).toMatchObject({ raw: "completed", unified: "stop" });
    await fake.releasedPromise;
    expect(fake.released).toBe(1);
  });

  test("languageModel.pagesAcrossShortViewPagesUntilTheGapBoundary", async () => {
    const fake = fakeRuntime({
      events: [
        event("turn/started", { sessionId: "ses_model_test", turnId: "turn-1", viewCursor: "cursor-1" }),
        event("view/gap", { sessionId: "ses_model_test", after: "cursor-2", next: "cursor-5" }),
        event("turn/completed", { sessionId: "ses_model_test", turnId: "turn-1", terminal: "completed", viewCursor: "cursor-5" }),
      ],
      viewPages: [
        {
          events: [event("item/started", { sessionId: "ses_model_test", viewCursor: "cursor-3", item: { itemId: "msg-gap", turnId: "turn-1", kind: "agentMessage" } })],
          nextCursor: "cursor-3",
        },
        {
          events: [
            event("item/completed", { sessionId: "ses_model_test", viewCursor: "cursor-4", item: { itemId: "msg-gap", turnId: "turn-1", kind: "agentMessage", status: "completed", text: "Paged answer" } }),
            event("turn/completed", { sessionId: "ses_model_test", turnId: "turn-1", terminal: "completed", viewCursor: "cursor-5" }),
          ],
          nextCursor: "cursor-5",
        },
      ],
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doGenerate(callOptions());

    expect(result.content).toEqual([{ type: "text", text: "Paged answer" }]);
    expect(fake.requests.map((request) => request.params?.cursor)).toEqual(["cursor-2", "cursor-3"]);
  });

  test("languageModel.continuesAfterOnlyAnObservedCompactionCandidate", async () => {
    const summary = "Transcript digest: preserve this exact summary.";
    const fake = fakeRuntime({
      events: textEvents(),
      previousTranscriptFingerprints: ["a".repeat(64), "b".repeat(64)],
      compactionFingerprints: [fingerprintCompactionOutput(summary)],
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doGenerate(callOptions({
      prompt: [
        { role: "user", content: [{ type: "text", text: summary }] },
        { role: "user", content: [{ type: "text", text: "Continue with this request." }] },
      ],
    }));

    expect(result.content).toEqual([{ type: "text", text: "Probe answer" }]);
    expect(fake.commands.find((command) => command.method === "turn/start")?.params.input)
      .toEqual([{ type: "text", text: "Continue with this request." }]);
    await fake.releasedPromise;
  });

  test("languageModel.doesNotTreatAnUnobservedCompactionCandidateAsARebase", async () => {
    const fake = fakeRuntime({
      previousTranscriptFingerprints: ["a".repeat(64), "b".repeat(64)],
      compactionFingerprints: [fingerprintCompactionOutput("expected summary")],
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);

    await expect(model.doGenerate(callOptions({
      prompt: [
        { role: "user", content: [{ type: "text", text: "different summary" }] },
        { role: "user", content: [{ type: "text", text: "Continue." }] },
      ],
    }))).rejects.toThrow(/fresh Muse session/i);
    expect(fake.commands.some((command) => command.method === "turn/start")).toBe(false);
  });

  test("languageModel.turnStartRejectionClosesThePrestartedViewSubscription", async () => {
    const fake = fakeRuntime({ failTurnStart: true, blockSubscription: true });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const error = await model.doGenerate(callOptions()).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error?.name).toBe("MspCommandRejectedError");
    expect(fake.subscriptionReturns).toBe(1);
    expect(fake.released).toBe(1);
  });

  test("languageModel.keepsWorkspaceLeaseOnAmbiguousTurnStartTimeout", async () => {
    const fake = fakeRuntime({ timeoutTurnStart: true, blockSubscription: true });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const error = await model.doGenerate(callOptions()).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error?.name).toBe("MspCommandTimeoutError");
    expect(fake.subscriptionReturns).toBe(1);
    expect(fake.released).toBe(0);
  });

  test("languageModel.dischargesAnAcceptedTurnIfRecordingItsAckFails", async () => {
    const fake = fakeRuntime({ events: textEvents(), failRecordTurnAccepted: true });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const error = await model.doGenerate(callOptions()).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error?.message).toBe("registry write failed");
    expect(fake.commands.some((command) => command.method === "turn/interrupt")).toBe(true);
    await fake.releasedPromise;
    expect(fake.released).toBe(1);
  });

  test("languageModel.continuesAnAckedTurnWhenClearingItsPendingFingerprintFails", async () => {
    const fake = fakeRuntime({ events: textEvents(), failClearPendingCommand: true });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doGenerate(callOptions());

    expect(result.content).toEqual([{ type: "text", text: "Probe answer" }]);
    expect(fake.commands.filter((command) => command.method === "turn/start")).toHaveLength(1);
    await fake.releasedPromise;
  });

  test("languageModel.keepsTurnStartIdPendingUntilAReconciledTerminal", async () => {
    const fake = fakeRuntime({ events: textEvents() });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    await model.doGenerate(callOptions());
    await fake.releasedPromise;

    expect(fake.commandLifecycle.indexOf("terminal")).toBeLessThan(fake.commandLifecycle.lastIndexOf("clear:turn/start"));
  });

  test("languageModel.doesNotTurnSessionGenerateIntoALiveMuseTurn", async () => {
    const fake = fakeRuntime();
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const options = callOptions({
      headers: {
        ...((callOptions() as { headers: Record<string, string> }).headers),
        "x-opencode-muse-kind": "generate",
      },
    });

    await expect(model.doGenerate(options)).rejects.toThrow(/generate/);
    expect(fake.commands.some((command) => command.method === "turn/start")).toBe(false);
  });

  test("languageModel.changesModelProfileBeforeTurnButDoesNotChangeStandingEffort", async () => {
    const fake = fakeRuntime({
      events: textEvents(),
      currentSelection: { providerId: "meta", modelId: "other-model", profileId: null },
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    await model.doGenerate(callOptions());

    expect(fake.order.indexOf("session/setModel")).toBeLessThan(fake.order.indexOf("turn/start"));
    expect(fake.commands.find((command) => command.method === "session/setModel")?.params.model)
      .toEqual({ providerId: "meta", profileId: "tbh", modelId: "muse-wonder-1.0" });
    expect(fake.commands.some((command) => command.method === "session/setReasoningEffort")).toBe(false);
  });

  test("languageModel.uploadsVideoChunksWithUniqueIdsAndUsesTheSharedReceipt", async () => {
    const fake = fakeRuntime({ events: textEvents(), videoChunkBytes: 3 });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    await model.doGenerate({
      ...callOptions(),
      prompt: [{
        role: "user",
        content: [
          { type: "text", text: "Analyze the clip." },
          { type: "file", mediaType: "video/mp4", data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7]) },
        ],
      }],
    } as never);
    const uploads = fake.commands.filter((command) => command.method === "media/upload");
    const turn = fake.commands.find((command) => command.method === "turn/start")!;
    const input = turn.params.input as Array<Record<string, unknown>>;

    expect(uploads.map((upload) => upload.params.chunkIndex)).toEqual([0, 1, 2]);
    expect(uploads.map((upload) => upload.params.chunkCount)).toEqual([3, 3, 3]);
    expect(new Set(uploads.map((upload) => upload.params.commandId)).size).toBe(3);
    expect(new Set(uploads.map((upload) => upload.params.uploadId).values()).size).toBe(1);
    expect(input.find((part) => part.type === "video")?.uploadId).toBe(uploads[0]?.params.uploadId);
  });

  test("languageModel.reasonsFromCompletedItemsWhenMuseDoesNotSendDeltas", async () => {
    const fake = fakeRuntime({ events: [
      event("item/started", { sessionId: "ses_model_test", item: { itemId: "msg-1", turnId: "turn-1", kind: "agentMessage" } }),
      event("item/completed", { sessionId: "ses_model_test", item: { itemId: "msg-1", turnId: "turn-1", kind: "agentMessage", status: "completed", text: "whole answer" } }),
      event("turn/completed", { sessionId: "ses_model_test", turnId: "turn-1", terminal: "completed" }),
    ] });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doGenerate(callOptions());
    expect(result.content).toEqual([{ type: "text", text: "whole answer" }]);
  });

  test("languageModel.returnsAnEmptySuccessfulResponseWhenNoAssistantTextWasProduced", async () => {
    const fake = fakeRuntime({ events: [
      event("turn/started", { sessionId: "ses_model_test", turnId: "turn-1" }),
      event("turn/completed", { sessionId: "ses_model_test", turnId: "turn-1", terminal: "completed" }),
    ] });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doGenerate(callOptions());

    expect(result.content).toEqual([]);
    expect(result.finishReason).toMatchObject({ unified: "stop", raw: "completed" });
    expect(result.usage).toMatchObject({ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined });
  });

  test("languageModel.mapsMuseTerminalFailureToSafeTypedError", async () => {
    const fake = fakeRuntime({ events: [
      event("turn/completed", {
        sessionId: "ses_model_test",
        turnId: "turn-1",
        terminal: "failed",
        error: { kind: "providerUnavailable", message: "credential-looking-private-detail", retryable: true },
      }),
    ] });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const error = await model.doGenerate(callOptions()).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error?.name).toBe("MuseTurnFailedError");
    expect(error?.message).toContain("providerUnavailable");
    expect(error?.message).not.toContain("credential-looking-private-detail");
  });

  test("languageModel.emitsAnErrorPartForAnAsyncMuseTurnFailure", async () => {
    const fake = fakeRuntime({ events: [
      event("turn/completed", {
        sessionId: "ses_model_test",
        turnId: "turn-1",
        terminal: "failed",
        error: { kind: "providerUnavailable", message: "private provider detail", retryable: true },
      }),
    ] });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const { stream } = await model.doStream(callOptions());
    const reader = stream.getReader();
    const parts: Array<Record<string, unknown>> = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value as unknown as Record<string, unknown>);
    }

    expect(parts.map((part) => part.type)).toEqual(["stream-start", "error", "finish"]);
    expect(JSON.stringify(parts)).not.toContain("private provider detail");
    expect(parts.at(-1)?.finishReason).toMatchObject({ unified: "error", raw: "failed" });
  });

  test("languageModel.finishesAtForegroundAndKeepsTheWorkspaceLeaseUntilBackgroundTerminal", async () => {
    let finishBackground!: () => void;
    const backgroundWait = new Promise<void>((resolve) => { finishBackground = resolve; });
    const fake = fakeRuntime({ events: textEvents(), backgroundWaitAfterForeground: backgroundWait });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const { stream } = await model.doStream(callOptions());
    const reader = stream.getReader();
    const parts: Array<Record<string, unknown>> = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value as unknown as Record<string, unknown>);
    }

    expect(parts.at(-1)?.finishReason).toMatchObject({ raw: "foregroundCompleted", unified: "stop" });
    expect(fake.released).toBe(0);
    finishBackground();
    await fake.releasedPromise;
    expect(fake.released).toBe(1);
  });

  test("languageModel.doGenerateReturnsForegroundAnswerWhileTheMonitorKeepsTheLease", async () => {
    let finishBackground!: () => void;
    const backgroundWait = new Promise<void>((resolve) => { finishBackground = resolve; });
    const fake = fakeRuntime({ events: textEvents(), backgroundWaitAfterForeground: backgroundWait });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await Promise.race([
      model.doGenerate(callOptions()),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("doGenerate waited for background completion")), 30)),
    ]);

    expect(result.content).toEqual([{ type: "text", text: "Probe answer" }]);
    expect(result.finishReason).toMatchObject({ raw: "foregroundCompleted", unified: "stop" });
    expect(fake.released).toBe(0);
    finishBackground();
    await fake.releasedPromise;
    expect(fake.released).toBe(1);
  });

  test("languageModel.abortUnqueuesQueuedTurnAndDoesNotInterruptIt", async () => {
    const fake = fakeRuntime({
      disposition: "queued",
      onTurnStart: () => controller.abort(),
      events: [event("turn/unqueued", { sessionId: "ses_model_test", turnId: "turn-1" })],
    });
    const controller = new AbortController();
    const model = createMuseLanguageModel(fake.runtime, modelID);

    const error = await model.doGenerate(callOptions({ abortSignal: controller.signal }))
      .then(() => undefined, (reason: unknown) => reason as Error);
    expect(error?.name).toBe("MuseTurnUnqueuedError");
    expect(fake.commands.some((command) => command.method === "turn/unqueue")).toBe(true);
    expect(fake.commands.some((command) => command.method === "turn/interrupt")).toBe(false);
  });

  test("languageModel.abortInterruptsRunningTurn", async () => {
    const fake = fakeRuntime({
      disposition: "started",
      onTurnStart: () => controller.abort(),
      events: [event("turn/completed", { sessionId: "ses_model_test", turnId: "turn-1", terminal: "cancelled" })],
    });
    const controller = new AbortController();
    const model = createMuseLanguageModel(fake.runtime, modelID);

    await model.doGenerate(callOptions({ abortSignal: controller.signal }));
    expect(fake.commands.some((command) => command.method === "turn/interrupt")).toBe(true);
    expect(fake.commands.some((command) => command.method === "turn/unqueue")).toBe(false);
  });

  const approvalResponsePrompt = () => [{
    role: "user",
    content: [
      { type: "tool-approval-response", approvalId: "approval-1", approved: true },
      { type: "text", text: "go on" },
    ],
  }];

  test("languageModel.doStreamJoinsParkedTurnOnApprovalResponse", async () => {
    const fake = fakeRuntime({
      events: [
        event("item/started", { sessionId: "ses_model_test", item: { itemId: "msg-1", turnId: "turn-parked", kind: "agentMessage" } }),
        event("item/delta", { sessionId: "ses_model_test", itemId: "msg-1", field: "text", delta: "resumed" }),
        event("item/completed", { sessionId: "ses_model_test", item: { itemId: "msg-1", turnId: "turn-parked", kind: "agentMessage", status: "completed", text: "resumed" } }),
        event("turn/completed", { sessionId: "ses_model_test", turnId: "turn-parked", terminal: "completed" }),
      ],
      settleMatched: ["approval-1"],
      joinParkedTurnId: "turn-parked",
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doStream(callOptions({ prompt: approvalResponsePrompt() }));
    const reader = result.stream.getReader();
    const parts: Array<Record<string, unknown>> = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value as unknown as Record<string, unknown>);
    }

    expect(fake.settledResponses).toEqual([{
      sessionID: "ses_model_test",
      responses: [{ approvalId: "approval-1", approved: true }],
    }]);
    expect(fake.commands.some((command) => command.method === "turn/start")).toBe(false);
    expect(parts.map((part) => part.type)).toEqual(["stream-start", "text-start", "text-delta", "text-end", "finish"]);
    await fake.releasedPromise;
    expect(fake.released).toBe(1);
  });

  test("languageModel.doStreamThrowsWhenApprovalResponsesCannotBeSettled", async () => {
    const fake = fakeRuntime({ hasParkedApprovals: true });
    const model = createMuseLanguageModel(fake.runtime, modelID);

    await expect(model.doStream(callOptions({ prompt: approvalResponsePrompt() })))
      .rejects.toThrow(/approval-response/);
    expect(fake.commands.some((command) => command.method === "turn/start")).toBe(false);
  });

  test("languageModel.doGenerateRefusesApprovalResponsesWhileAnApprovalIsParked", async () => {
    const fake = fakeRuntime({ events: textEvents(), hasParkedApprovals: true });
    const model = createMuseLanguageModel(fake.runtime, modelID);

    await expect(model.doGenerate(callOptions({ prompt: approvalResponsePrompt() })))
      .rejects.toThrow(/approval-response/);
    expect(fake.settledResponses).toEqual([]);
    expect(fake.commands.some((command) => command.method === "turn/start")).toBe(false);
  });

  test("languageModel.doGenerateSettlesStaleResponsesAndStartsAFreshTurn", async () => {
    const fake = fakeRuntime({ events: textEvents(), settleMatched: [], hasParkedApprovals: false });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doGenerate(callOptions({ prompt: approvalResponsePrompt() }));

    expect(fake.settledResponses).toEqual([{
      sessionID: "ses_model_test",
      responses: [{ approvalId: "approval-1", approved: true }],
    }]);
    expect(fake.commands.some((command) => command.method === "turn/start")).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Probe answer" }]);
  });

  test("languageModel.supersededStreamClosesWithoutReleasingTheLease", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const fake = fakeRuntime({
      events: [
        event("turn/started", { sessionId: "ses_model_test", turnId: "turn-1" }),
        event("approval/requested", {
          sessionId: "ses_model_test",
          turnId: "turn-1",
          approvalId: "approval-1",
          currentRequirementId: "req-1",
          toolCallId: "call-1",
        }),
        event("item/started", { sessionId: "ses_model_test", item: { itemId: "msg-1", turnId: "turn-1", kind: "agentMessage" } }),
        event("turn/completed", { sessionId: "ses_model_test", turnId: "turn-1", terminal: "completed" }),
      ],
      streamEpoch: 7,
      gateEventsAfter: { count: 2, release: gate },
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doStream(callOptions());
    const reader = result.stream.getReader();
    const parts: Array<Record<string, unknown>> = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value as unknown as Record<string, unknown>);
      if (parts.some((part) => part.type === "tool-approval-request")) break;
    }

    expect(parts.map((part) => part.type)).toEqual(["stream-start", "tool-approval-request"]);
    fake.session.streamEpoch = 8;
    fake.session.handoffLeaseToJoiner = true;
    releaseGate();
    while (!(await reader.read()).done) {
      // Drain until the superseded stream closes.
    }

    expect(fake.released).toBe(0);
    expect(fake.commands.some((command) => command.method === "turn/interrupt")).toBe(false);
  });

  test("languageModel.cancelAfterHandoffDoesNotInterruptTheJoinedTurn", async () => {
    const fake = fakeRuntime({ blockSubscription: true });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doStream(callOptions());
    for (let attempt = 0; attempt < 50 && !fake.commands.some((command) => command.method === "turn/start"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // The manager hands the lease to the joining call mid-turn.
    fake.session.handoffLeaseToJoiner = true;
    await result.stream.getReader().cancel();

    expect(fake.commands.some((command) => command.method === "turn/interrupt")).toBe(false);
    expect(fake.released).toBe(0);
  });

  test("languageModel.divergenceDuringJoinDisarmsWithoutStartingATurn", async () => {
    let disarmed = 0;
    const fake = fakeRuntime({
      previousTranscriptFingerprints: ["a".repeat(64)],
      settleMatched: ["approval-1"],
      joinParkedTurnId: "turn-parked",
      onDisarm: () => { disarmed += 1; },
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const error = await model.doStream(callOptions({
      prompt: [
        { role: "user", content: [{ type: "text", text: "edited earlier turn" }] },
        { role: "assistant", content: [{ type: "text", text: "old assistant" }] },
        {
          role: "user",
          content: [
            { type: "tool-approval-response", approvalId: "approval-1", approved: true },
            { type: "text", text: "latest" },
          ],
        },
      ],
    })).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error?.name).toBe("MuseTranscriptDivergedError");
    expect(disarmed).toBe(1);
    expect(fake.commands.some((command) => command.method === "turn/start")).toBe(false);
  });

  function headersForVariant(variant?: string) {
    const headers: Record<string, string> = {};
    addRequestContextHeaders(headers, {
      sessionID: "ses_model_test",
      kind: "primary",
      model: variant === undefined
        ? { id: modelID, providerID: "muse" }
        : { id: modelID, providerID: "muse", variant },
      headers,
    }, "/workspace/model-test");
    return headers;
  }

  test("languageModel.pinFillsTheUntouchedEffortSlot", async () => {
    const fake = fakeRuntime({ events: textEvents(), effortPin: "low" });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    await model.doGenerate(callOptions({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], headers: headersForVariant() }));

    const start = fake.commands.find((command) => command.method === "turn/start");
    expect(start?.params).toMatchObject({ reasoningEffort: "low" });
  });

  test("languageModel.pinFillsTheDefaultVariantSlot", async () => {
    const fake = fakeRuntime({ events: textEvents(), effortPin: "low" });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    await model.doGenerate(callOptions({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], headers: headersForVariant("default") }));

    const start = fake.commands.find((command) => command.method === "turn/start");
    expect(start?.params).toMatchObject({ reasoningEffort: "low" });
  });

  test("languageModel.explicitVariantBeatsThePin", async () => {
    const fake = fakeRuntime({ events: textEvents(), effortPin: "low" });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    await model.doGenerate(callOptions({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], headers: headersForVariant("high") }));

    const start = fake.commands.find((command) => command.method === "turn/start");
    expect(start?.params).toMatchObject({ reasoningEffort: "high" });
  });

  test("languageModel.ignoresPinsOutsideTheRowVariants", async () => {
    const fake = fakeRuntime({ events: textEvents(), effortPin: "max" });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    await model.doGenerate(callOptions({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], headers: headersForVariant() }));

    const start = fake.commands.find((command) => command.method === "turn/start");
    expect(start?.params).not.toHaveProperty("reasoningEffort");
  });

  test("languageModel.cancelWhileParkedDeniesThePendingApproval", async () => {
    let denied = 0;
    const fake = fakeRuntime({
      blockSubscription: true,
      onCancelParked: () => { denied += 1; },
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doStream(callOptions());
    await result.stream.getReader().cancel();

    expect(denied).toBe(1);
    expect(fake.commands.some((command) => command.method === "turn/interrupt")).toBe(true);
  });
});
