import { describe, expect, test } from "bun:test";
import { MspCommandRejectedError } from "../../src/errors.js";
import { createMuseLanguageModel, type MuseLanguageRuntime } from "../../src/model/language-model.js";
import { fingerprintTranscript } from "../../src/session/fingerprint.js";
import type { RequestContext } from "../../src/types.js";

const modelId = "muse-profile-tbh-model-muse-wonder-1.0";
const selection = { providerId: "meta", profileId: "tbh", modelId: "muse-wonder-1.0" };

function headers(sessionID: string): Record<string, string> {
  return {
    "x-opencode-muse-session-id": sessionID,
    "x-opencode-muse-directory": "/tmp/opencode/muse-plugin-test",
    "x-opencode-muse-kind": "primary",
    "x-opencode-muse-model-id": modelId,
    "x-opencode-muse-provider-id": "muse",
  };
}

function prompt(...texts: Array<[string, string]>) {
  return texts.map(([role, text]) => ({
    role,
    content: [{ type: "text", text }],
  }));
}

async function collect(stream: ReadableStream<unknown>): Promise<Array<Record<string, unknown>>> {
  const parts: Array<Record<string, unknown>> = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value as Record<string, unknown>);
    }
  } finally {
    reader.releaseLock();
  }
  return parts;
}

describe("opencode backend turn flow", () => {
  test("toolBackend.emitsNativeToolCallForParkedLoopbackCall", async () => {
    const previous = prompt(["user", "first request"], ["assistant", "first answer"]);
    const stored = fingerprintTranscript(previous);
    const calls: string[] = [];
    let parkedTaken = 0;
    const session: Record<string, unknown> = {
      host: {
        mintCommandId: () => "018f4f17-9c2a-7c1a-a0fd-67a19db5d1f",
        async command(method: string, params: Record<string, unknown>) {
          calls.push(method);
          if (method === "turn/start") {
            return { commandId: params.commandId, disposition: "started", startedNewTurn: true, status: "accepted", turnId: "turn_live" };
          }
          return {};
        },
        async request() { return {}; },
        subscribe() {
          return {
            [Symbol.asyncIterator]() {
              let started = false;
              return {
                async next() {
                  if (!started) {
                    started = true;
                    return { done: false as const, value: { method: "turn/started", params: { sessionId: "ses_muse_old", turnId: "turn_live", viewCursor: "c1" } } };
                  }
                  return new Promise<never>(() => {});
                },
                async return() { return { done: true as const, value: undefined }; },
              };
            },
          };
        },
      },
      sessionId: "ses_muse_old",
      museSessionId: "ses_muse_old",
      toolBackend: "opencode",
      previousTranscriptFingerprints: stored,
      contextAllowlist: [],
      sessionNotices: [],
      compactionFingerprints: [],
      emittedApprovalPrompts: new Set<string>(),
      handoffTakeovers: 0,
      streamEpoch: 0,
      currentSelection: selection,
      async recordPendingCommand() {},
      async clearPendingCommand() {},
      async recordTurnAccepted() {},
      async updateCursor() {},
      async recordTurnCompleted() {},
      async commitTranscriptFingerprints() {},
      async release() {},
      takeParkedToolCall() {
        parkedTaken += 1;
        if (parkedTaken > 1) return undefined;
        return { callId: "mc_1", toolName: "opencode_write", args: { path: "x.txt" } };
      },
      syncLoopbackTools: () => {},
    };
    const runtime: MuseLanguageRuntime = {
      selectionIndex: new Map([[modelId, selection]]),
      async resolveSession() { return session as never; },
      previousTranscriptFingerprints: () => stored,
    };
    const model = createMuseLanguageModel(runtime, modelId);
    const parts = await collect((await model.doStream({
      prompt: [...previous, ...prompt(["user", "write it"])],
      headers: headers("ses_oc_1"),
    } as never)).stream as ReadableStream<unknown>);

    const toolCalls = parts.filter((part) => part.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      toolCallId: "mc_1",
      toolName: "opencode_write",
      input: JSON.stringify({ path: "x.txt" }),
    });
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } });
    expect(calls.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(session.handoffTakeovers).toBe(1);
  });

  test("toolBackend.watcherTakeWinsOverPeekedCall", async () => {
    const previous = prompt(["user", "first request"], ["assistant", "first answer"]);
    const stored = fingerprintTranscript(previous);
    const calls: string[] = [];
    let takes = 0;
    const session: Record<string, unknown> = {
      host: {
        mintCommandId: () => "018f4f17-9c2a-7c1a-a0fd-67a19db5d1f",
        async command(method: string, params: Record<string, unknown>) {
          calls.push(method);
          if (method === "turn/start") {
            return { commandId: params.commandId, disposition: "started", startedNewTurn: true, status: "accepted", turnId: "turn_live" };
          }
          return {};
        },
        async request() { return {}; },
        subscribe() {
          return {
            [Symbol.asyncIterator]() {
              let started = false;
              return {
                async next() {
                  if (!started) {
                    started = true;
                    return { done: false as const, value: { method: "turn/started", params: { sessionId: "ses_muse_old", turnId: "turn_live", viewCursor: "c1" } } };
                  }
                  return new Promise<never>(() => {});
                },
                async return() { return { done: true as const, value: undefined }; },
              };
            },
          };
        },
      },
      sessionId: "ses_muse_old",
      museSessionId: "ses_muse_old",
      toolBackend: "opencode",
      previousTranscriptFingerprints: stored,
      contextAllowlist: [],
      sessionNotices: [],
      compactionFingerprints: [],
      emittedApprovalPrompts: new Set<string>(),
      handoffTakeovers: 0,
      streamEpoch: 0,
      currentSelection: selection,
      async recordPendingCommand() {},
      async clearPendingCommand() {},
      async recordTurnAccepted() {},
      async updateCursor() {},
      async recordTurnCompleted() {},
      async commitTranscriptFingerprints() {},
      async release() {},
      // Sync check sees nothing; the watcher then peeks call A while the
      // destructive take drains call B. The take wins: emitting the peeked
      // call would duplicate it when B is taken next.
      takeParkedToolCall() {
        takes += 1;
        if (takes < 2) return undefined;
        return { callId: "mc_b", toolName: "opencode_write", args: { path: "b.txt" } };
      },
      watchParkedToolCall: () => ({
        wait: Promise.resolve({ callId: "mc_a", toolName: "opencode_write", args: { path: "a.txt" } }),
        cancel: () => {},
      }),
      syncLoopbackTools: () => {},
    };
    const runtime: MuseLanguageRuntime = {
      selectionIndex: new Map([[modelId, selection]]),
      async resolveSession() { return session as never; },
      previousTranscriptFingerprints: () => stored,
    };
    const model = createMuseLanguageModel(runtime, modelId);
    const parts = await collect((await model.doStream({
      prompt: [...previous, ...prompt(["user", "write it"])],
      headers: headers("ses_oc_1"),
    } as never)).stream as ReadableStream<unknown>);

    const toolCalls = parts.filter((part) => part.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ toolCallId: "mc_b" });
    expect(session.handoffTakeovers).toBe(1);
  });

  test("toolBackend.attachResolvesParkedAndDrainsWithoutNewTurn", async () => {
    const history = prompt(
      ["user", "first request"],
      ["assistant", "first answer"],
      ["user", "second request"],
      ["assistant", "second answer"],
    );
    const stored = fingerprintTranscript(history);
    const calls: Array<{ method: string; sessionId?: string }> = [];
    const resolved: Array<{ sessionID: string; toolCallId: string; text: string }> = [];
    let completed = false;
    const session: Record<string, unknown> = {
      host: {
        mintCommandId: () => "018f4f17-9c2a-7c1a-a0fd-67a19db5d1f",
        async command(method: string, params: Record<string, unknown>) {
          calls.push({ method, sessionId: params.sessionId as string | undefined });
          return {};
        },
        async request() { return {}; },
        subscribe() {
          return {
            [Symbol.asyncIterator]() {
              let index = 0;
              const events = [
                { method: "turn/started", params: { sessionId: "ses_muse_old", turnId: "turn_live", viewCursor: "c1" } },
                { method: "turn/completed", params: { sessionId: "ses_muse_old", turnId: "turn_live", terminal: "completed", viewCursor: "c2" } },
              ];
              return {
                async next() {
                  if (index >= events.length) return { done: true as const, value: undefined };
                  return { done: false as const, value: events[index++] };
                },
                async return() { return { done: true as const, value: undefined }; },
              };
            },
          };
        },
      },
      sessionId: "ses_muse_old",
      museSessionId: "ses_muse_old",
      toolBackend: "opencode",
      activeTurnId: "turn_live",
      previousTranscriptFingerprints: stored,
      contextAllowlist: [],
      sessionNotices: [],
      compactionFingerprints: [],
      emittedApprovalPrompts: new Set<string>(),
      handoffTakeovers: 0,
      streamEpoch: 0,
      currentSelection: selection,
      async recordPendingCommand() {},
      async clearPendingCommand() {},
      async recordTurnAccepted() {},
      async updateCursor() {},
      async recordTurnCompleted(_turnId: string, terminal: string) { completed = terminal === "completed"; },
      async commitTranscriptFingerprints() {},
      async release() {},
      hasParkedToolCall: (toolCallId: string) => toolCallId === "mc_1",
      resolveParkedToolCall: (toolCallId: string, resultText: string) => {
        resolved.push({ sessionID: "ses_oc_1", toolCallId, text: resultText });
        return "resolved";
      },
      takeParkedToolCall: () => undefined,
    };
    const runtime: MuseLanguageRuntime = {
      selectionIndex: new Map([[modelId, selection]]),
      async resolveSession() { return session as never; },
      previousTranscriptFingerprints: () => stored,
    };
    const model = createMuseLanguageModel(runtime, modelId);
    const parts = await collect((await model.doStream({
      prompt: [
        ...history,
        { role: "tool", content: [{ type: "tool-result", toolCallId: "mc_1", output: { type: "text", text: "written" } }] },
      ],
      headers: headers("ses_oc_1"),
    } as never)).stream as ReadableStream<unknown>);

    expect(resolved).toEqual([{ sessionID: "ses_oc_1", toolCallId: "mc_1", text: "written" }]);
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(completed).toBe(true);
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop", raw: "completed" } });
  });

  test("toolBackend.toolResultReinvocationAttachesInsteadOfSteering", async () => {
    const history = prompt(
      ["user", "first request"],
      ["assistant", "first answer"],
    );
    const stored = fingerprintTranscript(history);
    const calls: Array<{ method: string; sessionId?: string }> = [];
    let completed = false;
    const session: Record<string, unknown> = {
      host: {
        mintCommandId: () => "018f4f17-9c2a-7c1a-a0fd-67a19db5d1f",
        async command(method: string, params: Record<string, unknown>) {
          calls.push({ method, sessionId: params.sessionId as string | undefined });
          if (method === "turn/steer") {
            throw new MspCommandRejectedError("turn/steer", -32030, "commandRejected");
          }
          return {};
        },
        async request() { return {}; },
        subscribe() {
          return {
            [Symbol.asyncIterator]() {
              let index = 0;
              const events = [
                { method: "turn/started", params: { sessionId: "ses_muse_old", turnId: "turn_live", viewCursor: "c1" } },
                { method: "turn/completed", params: { sessionId: "ses_muse_old", turnId: "turn_live", terminal: "completed", viewCursor: "c2" } },
              ];
              return {
                async next() {
                  if (index >= events.length) return { done: true as const, value: undefined };
                  return { done: false as const, value: events[index++] };
                },
                async return() { return { done: true as const, value: undefined }; },
              };
            },
          };
        },
      },
      sessionId: "ses_muse_old",
      museSessionId: "ses_muse_old",
      toolBackend: "opencode",
      activeTurnId: "turn_live",
      // The manager arms a steer for every re-entry on a live turn; a
      // tool-result re-invocation must attach anyway, never steer.
      steerExpectedTurnId: "turn_live",
      previousTranscriptFingerprints: stored,
      contextAllowlist: [],
      sessionNotices: [],
      compactionFingerprints: [],
      emittedApprovalPrompts: new Set<string>(),
      handoffTakeovers: 1,
      streamEpoch: 0,
      currentSelection: selection,
      async recordPendingCommand() {},
      async clearPendingCommand() {},
      async recordTurnAccepted() {},
      async updateCursor() {},
      async recordTurnCompleted(_turnId: string, terminal: string) { completed = terminal === "completed"; },
      async commitTranscriptFingerprints() {},
      async release() {},
      resolveParkedToolCall: () => "resolved",
      takeParkedToolCall: () => undefined,
    };
    const runtime: MuseLanguageRuntime = {
      selectionIndex: new Map([[modelId, selection]]),
      async resolveSession() { return session as never; },
      previousTranscriptFingerprints: () => stored,
    };
    const model = createMuseLanguageModel(runtime, modelId);
    const parts = await collect((await model.doStream({
      prompt: [
        ...history,
        { role: "tool", content: [{ type: "tool-result", toolCallId: "mc_1", output: { type: "text", text: "written" } }] },
      ],
      headers: headers("ses_oc_1"),
    } as never)).stream as ReadableStream<unknown>);

    expect(calls.some((call) => call.method === "turn/steer")).toBe(false);
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(completed).toBe(true);
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop", raw: "completed" } });
  });

  test("toolBackend.alreadyResolvedToolResultSkipsAndDrains", async () => {
    const history = prompt(
      ["user", "first request"],
      ["assistant", "first answer"],
    );
    const stored = fingerprintTranscript(history);
    const calls: Array<{ method: string; sessionId?: string }> = [];
    let completed = false;
    const session: Record<string, unknown> = {
      host: {
        mintCommandId: () => "018f4f17-9c2a-7c1a-a0fd-67a19db5d1f",
        async command(method: string, params: Record<string, unknown>) {
          calls.push({ method, sessionId: params.sessionId as string | undefined });
          return {};
        },
        async request() { return {}; },
        subscribe() {
          return {
            [Symbol.asyncIterator]() {
              let index = 0;
              const events = [
                { method: "turn/started", params: { sessionId: "ses_muse_old", turnId: "turn_live", viewCursor: "c1" } },
                { method: "turn/completed", params: { sessionId: "ses_muse_old", turnId: "turn_live", terminal: "completed", viewCursor: "c2" } },
              ];
              return {
                async next() {
                  if (index >= events.length) return { done: true as const, value: undefined };
                  return { done: false as const, value: events[index++] };
                },
                async return() { return { done: true as const, value: undefined }; },
              };
            },
          };
        },
      },
      sessionId: "ses_muse_old",
      museSessionId: "ses_muse_old",
      toolBackend: "opencode",
      activeTurnId: "turn_live",
      previousTranscriptFingerprints: stored,
      contextAllowlist: [],
      sessionNotices: [],
      compactionFingerprints: [],
      emittedApprovalPrompts: new Set<string>(),
      handoffTakeovers: 0,
      streamEpoch: 0,
      currentSelection: selection,
      async recordPendingCommand() {},
      async clearPendingCommand() {},
      async recordTurnAccepted() {},
      async updateCursor() {},
      async recordTurnCompleted(_turnId: string, terminal: string) { completed = terminal === "completed"; },
      async commitTranscriptFingerprints() {},
      async release() {},
      hasParkedToolCall: () => false,
      // Late duplicate for a settled call (timed out or already resolved):
      // skipped, never thrown, and the live turn still drains.
      resolveParkedToolCall: () => "already-resolved",
      takeParkedToolCall: () => undefined,
    };
    const runtime: MuseLanguageRuntime = {
      selectionIndex: new Map([[modelId, selection]]),
      async resolveSession() { return session as never; },
      previousTranscriptFingerprints: () => stored,
    };
    const model = createMuseLanguageModel(runtime, modelId);
    const parts = await collect((await model.doStream({
      prompt: [
        ...history,
        { role: "tool", content: [{ type: "tool-result", toolCallId: "mc_1", output: { type: "text", text: "late" } }] },
      ],
      headers: headers("ses_oc_1"),
    } as never)).stream as ReadableStream<unknown>);

    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(completed).toBe(true);
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop", raw: "completed" } });
  });

  test("toolBackend.unmatchedToolResultFailsClosed", async () => {
    const history = prompt(["user", "first request"], ["assistant", "first answer"]);
    const stored = fingerprintTranscript(history);
    const calls: string[] = [];
    const session: Record<string, unknown> = {
      host: {
        mintCommandId: () => "018f4f17-9c2a-7c1a-a0fd-67a19db5d1f",
        async command(method: string) { calls.push(method); return {}; },
        async request() { return {}; },
        subscribe() { throw new Error("must not subscribe"); },
      },
      sessionId: "ses_muse_old",
      museSessionId: "ses_muse_old",
      toolBackend: "opencode",
      activeTurnId: "turn_live",
      previousTranscriptFingerprints: stored,
      contextAllowlist: [],
      sessionNotices: [],
      compactionFingerprints: [],
      emittedApprovalPrompts: new Set<string>(),
      currentSelection: selection,
      async release() {},
      hasParkedToolCall: () => false,
      takeParkedToolCall: () => undefined,
    };
    const runtime: MuseLanguageRuntime = {
      selectionIndex: new Map([[modelId, selection]]),
      async resolveSession() { return session as never; },
      previousTranscriptFingerprints: () => stored,
    };
    const model = createMuseLanguageModel(runtime, modelId);
    const error = await model.doStream({
      prompt: [
        ...history,
        { role: "tool", content: [{ type: "tool-result", toolCallId: "mc_unknown", output: "x" }] },
      ],
      headers: headers("ses_oc_1"),
    } as never).then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );

    expect(error?.name).toBe("MuseUnsupportedInputError");
    expect(error?.message).toMatch(/tool-result/);
    expect(calls).toEqual([]);
  });
});
