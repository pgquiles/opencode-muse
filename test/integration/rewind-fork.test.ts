import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMuseLanguageModel, type MuseLanguageRuntime, type MuseTurnSession } from "../../src/model/language-model.js";
import { addRequestContextHeaders } from "../../src/model/context.js";
import { openCodeModelId } from "../../src/catalog.js";
import { fingerprintTranscript } from "../../src/session/fingerprint.js";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { MuseModelSelection, RequestContext } from "../../src/types.js";

const roots: string[] = [];
const modelId = openCodeModelId("tbh", "muse-wonder-1.0");
const selection: MuseModelSelection = {
  providerId: "meta",
  profileId: "tbh",
  modelId: "muse-wonder-1.0",
  isActive: true,
  isDefault: true,
  defaultReasoningEffort: "high",
  variantsKnown: true,
  variants: ["high"],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-muse-rewind-"));
  roots.push(root);
  return root;
}

function prompt(messages: Array<Record<string, unknown>>): LanguageModelV3Prompt {
  return messages as unknown as LanguageModelV3Prompt;
}

describe("rewind/fork remains fail-closed on the pinned runtime", () => {
  test("rewindFork.transcriptDivergenceFailsBeforeSendingAnUncutTurnOrFork", async () => {
    const root = makeRoot();
    const marker = join(root, "workspace-marker.txt");
    writeFileSync(marker, "workspace state must not be rolled back");
    const previous = prompt([
      { role: "user", content: [{ type: "text", text: "original request" }] },
      { role: "assistant", content: [{ type: "text", text: "original answer" }] },
    ]);
    const current = prompt([
      { role: "user", content: [{ type: "text", text: "edited earlier request" }] },
      { role: "assistant", content: [{ type: "text", text: "original answer" }] },
      { role: "user", content: [{ type: "text", text: "new request" }] },
    ]);
    const headers: Record<string, string> = {};
    addRequestContextHeaders(headers, {
      sessionID: "ses_rewind_case",
      kind: "primary",
      model: { id: modelId, providerID: "muse", variant: "high" },
      headers,
    }, root);
    const calls: string[] = [];
    const runtime: MuseLanguageRuntime = {
      selectionIndex: new Map([[modelId, selection]]),
      async resolveSession(_context: RequestContext): Promise<MuseTurnSession> {
        return {
          host: {
            mintCommandId: () => "018f4f17-9c2a-7c1a-a0fd-67a19db5d1f1",
            async command(method: string) { calls.push(method); return {}; },
            async request() { return {}; },
            subscribe() { return { async *[Symbol.asyncIterator]() {} }; },
          },
          sessionId: "ses_muse_authoritative",
          previousTranscriptFingerprints: fingerprintTranscript(previous),
          contextAllowlist: [],
          currentSelection: { providerId: "meta", profileId: "tbh", modelId: "muse-wonder-1.0" },
          async release() {},
        } as unknown as MuseTurnSession;
      },
    };
    const model = createMuseLanguageModel(runtime, modelId);
    const error = await model.doGenerate({ prompt: current, headers } as never)
      .then(() => undefined, (reason: unknown) => reason as Error);

    expect(error?.name).toBe("MuseTranscriptDivergedError");
    expect(error?.message).toMatch(/fresh Muse session/i);
    expect(calls).toEqual([]);
    expect(readFileSync(marker, "utf8")).toBe("workspace state must not be rolled back");
  });
});

describe("mapped rewind forks at the retained boundary", () => {
  const previous = prompt([
    { role: "user", content: [{ type: "text", text: "first request" }] },
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    { role: "user", content: [{ type: "text", text: "second request" }] },
    { role: "assistant", content: [{ type: "text", text: "second answer" }] },
  ]);
  const stored = fingerprintTranscript(previous);
  const rewound = prompt([
    { role: "user", content: [{ type: "text", text: "first request" }] },
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    { role: "user", content: [{ type: "text", text: "edited follow-up" }] },
  ]);

  function headers(): Record<string, string> {
    const result: Record<string, string> = {};
    addRequestContextHeaders(result, {
      sessionID: "ses_rewind_fork",
      kind: "primary",
      model: { id: modelId, providerID: "muse", variant: "high" },
      headers: result,
    }, "/tmp/opencode/fake-rewind-fork");
    return result;
  }

  function forkHarness(options: {
    forkResult: { forked: true } | { forked: false };
    onFork?: (retainedLength: number) => void;
  }) {
    const calls: Array<{ method: string; sessionId?: string }> = [];
    let liveSessionId = "ses_muse_old";
    const session = {
      host: {
        mintCommandId: () => "018f4f17-9c2a-7c1a-a0fd-67a19db5d1f",
        async command(method: string, params: Record<string, unknown>) {
          calls.push({ method, sessionId: params.sessionId as string | undefined });
          if (method === "turn/start") {
            return { commandId: params.commandId, disposition: "started", startedNewTurn: true, status: "accepted", turnId: "turn_new" };
          }
          return {};
        },
        async request() { return {}; },
        subscribe() {
          const sid = liveSessionId;
          const tid = "turn_new";
          return {
            async *[Symbol.asyncIterator]() {
              yield { method: "turn/started", params: { sessionId: sid, turnId: tid, viewCursor: "c1" } };
              yield { method: "turn/completed", params: { sessionId: sid, turnId: tid, terminal: "completed", viewCursor: "c2" } };
            },
          };
        },
      },
      sessionId: liveSessionId,
      museSessionId: liveSessionId,
      previousTranscriptFingerprints: stored,
      contextAllowlist: [],
      sessionNotices: [],
      compactionFingerprints: [],
      emittedApprovalPrompts: new Set<string>(),
      joinParkedTurnId: undefined,
      steerExpectedTurnId: undefined,
      handoffTakeovers: 0,
      streamEpoch: 0,
      activeTurnId: undefined,
      currentSelection: { providerId: "meta", profileId: "tbh", modelId: "muse-wonder-1.0" },
      async recordPendingCommand() {},
      async clearPendingCommand() {},
      async recordTurnAccepted() {},
      async updateCursor() {},
      async recordTurnCompleted() {},
      async commitTranscriptFingerprints() {},
      async release() {},
    };
    const runtime: MuseLanguageRuntime = {
      selectionIndex: new Map([[modelId, selection]]),
      async resolveSession(_context: RequestContext): Promise<MuseTurnSession> {
        return session as unknown as MuseTurnSession;
      },
      previousTranscriptFingerprints: () => stored,
      async forkSessionAtBoundary(_sessionID: string, retainedLength: number) {
        options.onFork?.(retainedLength);
        if (options.forkResult.forked) {
          liveSessionId = "ses_muse_fork";
          session.sessionId = liveSessionId;
          session.museSessionId = liveSessionId;
          session.previousTranscriptFingerprints = stored.slice(0, retainedLength);
        }
        return options.forkResult;
      },
    };
    return { calls, session, runtime };
  }

  test("rewindFork.forksAtRetainedTurnAndContinuesOnTheFork", async () => {
    const root = makeRoot();
    const marker = join(root, "workspace-marker.txt");
    writeFileSync(marker, "workspace state must not be rolled back");
    const seen: number[] = [];
    const { calls, runtime } = forkHarness({ forkResult: { forked: true }, onFork: (length) => { seen.push(length); } });
    const model = createMuseLanguageModel(runtime, modelId);
    await model.doGenerate({ prompt: rewound, headers: headers() } as never);

    expect(seen).toEqual([2]);
    expect(calls.some((call) => call.method === "turn/start" && call.sessionId === "ses_muse_fork")).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("workspace state must not be rolled back");
  });

  test("rewindFork.unmappableBoundaryFailsWithoutForkOrTurn", async () => {
    const root = makeRoot();
    const marker = join(root, "workspace-marker.txt");
    writeFileSync(marker, "workspace state must not be rolled back");
    const { calls, runtime } = forkHarness({ forkResult: { forked: false } });
    const model = createMuseLanguageModel(runtime, modelId);
    const error = await model.doGenerate({ prompt: rewound, headers: headers() } as never)
      .then(() => undefined, (reason: unknown) => reason as Error);

    expect(error?.name).toBe("MuseTranscriptDivergedError");
    expect(error?.message).toMatch(/fresh Muse session/i);
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("workspace state must not be rolled back");
  });
});
