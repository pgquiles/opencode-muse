import { describe, expect, test } from "bun:test";
import { Connection, EXPECTED_SCHEMA_FINGERPRINT, type MspHandshake } from "@muse-code/sdk";
import { MspHost } from "../../src/msp/host.js";
import { createMuseLanguageModel } from "../../src/model/language-model.js";
import { addRequestContextHeaders } from "../../src/model/context.js";
import { openCodeModelId } from "../../src/catalog.js";
import { FakeMspTransport } from "../helpers/fake-msp.ts";
import type { MuseModelSelection } from "../../src/types.js";

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

function makeContext() {
  const headers: Record<string, string> = {};
  addRequestContextHeaders(headers, {
    sessionID: "ses_fake_bridge",
    kind: "primary",
    model: { id: modelId, providerID: "muse", variant: "high" },
    headers,
  }, "/tmp/opencode/fake-bridge");
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "Bridge test input." }] }],
    headers,
    tools: [{ type: "function", name: "shell", inputSchema: { type: "object", properties: {} } }],
    toolChoice: { type: "auto" },
  } as never;
}

describe("fake MSP ↔ LanguageModelV3 bridge integration", () => {
  test("turnBridge.initializesStartsOneTurnAndProjectsOnlyText", async () => {
    const sessionId = "ses_fake_bridge";
    const turnId = "turn_fake_bridge";
    const transport = new FakeMspTransport((request) => {
      if (request.method === "initialize") return { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } };
      if (request.method === "session/start") {
        return { session: { sessionId }, viewCursor: "cursor-start" };
      }
      if (request.method === "turn/start") {
        for (const notification of [
          { method: "turn/started", params: { sessionId, turnId, viewCursor: "cursor-1" } },
          { method: "item/started", params: { sessionId, item: { itemId: "item-1", turnId, kind: "agentMessage" } } },
          { method: "item/delta", params: { sessionId, itemId: "item-1", field: "text", delta: "Muse " } },
          { method: "item/delta", params: { sessionId, itemId: "item-1", field: "text", delta: "answer" } },
          { method: "item/completed", params: { sessionId, item: { itemId: "item-1", turnId, kind: "agentMessage", status: "completed", text: "Muse answer" } } },
          { method: "session/tokenUsage", params: { sessionId, turnId, viewCursor: "cursor-2", promptTokens: 8, totalTokens: 10, usage: { inputTokens: 8, outputTokens: 2, reasoningTokens: 0, cachedTokens: 0 } } },
          { method: "turn/foregroundCompleted", params: { sessionId, turnId, viewCursor: "cursor-3" } },
          { method: "turn/completed", params: { sessionId, turnId, terminal: "completed", usage: { inputTokens: 8, outputTokens: 2, reasoningTokens: 0, cachedTokens: 0 }, viewCursor: "cursor-4" } },
        ]) transport.notify(notification.method, notification.params);
        return { commandId: request.params?.commandId, disposition: "started", startedNewTurn: true, status: "accepted", turnId };
      }
      return { commandId: request.params?.commandId, status: "accepted" };
    });
    const connection = new Connection(transport);
    const fakeHandshake = {
      async initialize(params: Parameters<MspHandshake["initialize"]>[0]) {
        const initializeResult = await connection.request("initialize", { clientInfo: params.clientInfo });
        return {
          connection,
          initializeResult,
          async close() { await connection.close(); },
        };
      },
      async close() { await connection.close(); },
    };
    const host = await MspHost.start({ cwd: "/tmp/opencode/fake-bridge" }, { createHandshake: () => fakeHandshake });
    let released = false;
    let markReleased!: () => void;
    const releasedPromise = new Promise<void>((resolve) => { markReleased = resolve; });
    const runtime = {
      selectionIndex: new Map([[modelId, selection]]),
      async resolveSession() {
        const start = await host.command("session/start", {
          commandId: host.mintCommandId(),
          workspaceRoot: "/tmp/opencode/fake-bridge",
          providerId: "meta",
          modelId: "muse-wonder-1.0",
        });
        return {
          host,
          sessionId: (start.session as { sessionId: string }).sessionId,
          previousTranscriptFingerprints: [],
          contextAllowlist: [],
          replayAfterCursor: undefined,
          currentSelection: { providerId: "meta", modelId: "muse-wonder-1.0", profileId: "tbh" },
          async release() { released = true; markReleased(); },
        };
      },
    };
    const model = createMuseLanguageModel(runtime, modelId);
    const result = await model.doGenerate(makeContext());

    expect(result.content).toEqual([{ type: "text", text: "Muse answer" }]);
    expect(result.finishReason).toMatchObject({ unified: "stop" });
    expect(result.usage).toMatchObject({
      inputTokens: { total: 8, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 2, text: undefined, reasoning: 0 },
    });
    expect(transport.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(transport.requests.some((request) => request.method === "view/subscribe")).toBe(false);
    expect(transport.requests.some((request) => request.method === "approval/decide")).toBe(false);
    await releasedPromise;
    expect(released).toBe(true);
    await host.close();
  });
});
