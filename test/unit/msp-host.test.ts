import { describe, expect, test } from "bun:test";
import { Connection, EXPECTED_SCHEMA_FINGERPRINT, type MspHandshake } from "@muse-code/sdk";
import { MspHost } from "../../src/msp/host.js";
import { MspCommandTimeoutError, MspSchemaMismatchError, MspStartupTimeoutError, MspTransportError } from "../../src/errors.js";
import { FakeMspTransport } from "../helpers/fake-msp.ts";

function fakeHandshake(
  transport: FakeMspTransport,
  initialized: Record<string, unknown> = { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } },
  exited: Promise<unknown> = new Promise(() => {}),
) {
  let closeCount = 0;
  const connection = new Connection(transport);
  return {
    get closeCount() { return closeCount; },
    connection,
    handshake: {
      async initialize(params: Parameters<MspHandshake["initialize"]>[0]) {
        const result = await connection.request("initialize", { clientInfo: params.clientInfo, capabilities: params.capabilities });
        return {
          connection,
          initializeResult: Object.keys(result).length > 0 ? result : initialized,
          params,
          exited,
          async close() {
            closeCount += 1;
            await connection.close();
          },
        };
      },
      async close() {
        closeCount += 1;
      },
    },
  };
}

describe("MspHost", () => {
  test("mspHost.pinsMuse1412StableSchemaFingerprint", () => {
    expect(EXPECTED_SCHEMA_FINGERPRINT).toBe(
      "sha256:cfdb6d2525601b9bac76584ccb0610ab3a5539b5e4f51141f079b99b39fcb4e0",
    );
  });

  test("mspHost.initializesThePinnedSdkConnectionBeforeReturning", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ cwd: "/workspace", startupTimeoutMs: 250 }, {
      createHandshake: () => fake.handshake,
    });

    const clientInfo = transport.requests.find((request) => request.method === "initialize")?.params?.clientInfo as { name?: string; version?: string };
    expect(clientInfo).toEqual({ name: "opencode_muse", version: "0.1.0" });
    expect(clientInfo.name).toMatch(/^[a-z0-9_]+$/);
    expect(host.initializeResult).toEqual({ schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } });
    expect(host.fingerprintWarning).toBeUndefined();
    await host.close();
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.mintsCommandIdsFromItsOwnSdkConnection", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    const commandId = host.mintCommandId();

    expect(commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await host.close();
  });

  test("mspHostCanExplicitlyDeclineUnsupportedStructuredUserInputDialogs", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ capabilities: { userInputDialogs: false } }, {
      createHandshake: () => fake.handshake,
    });
    const initialize = transport.requests.find((request) => request.method === "initialize");

    expect(initialize?.params?.capabilities).toMatchObject({ userInputDialogs: false });
    await host.close();
  });

  test("mspHostFailsClosedOnAnApprovalServerRequestWhenNoChoiceUiIsRegistered", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    transport.deliver({
      jsonrpc: "2.0",
      id: 991,
      method: "approval/request",
      params: { sessionId: "ses-1", approvalId: "approval-secret-looking-id" },
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (transport.writtenFrames.some((frame) =>
        typeof frame === "object" && frame !== null && "id" in frame && frame.id === 991,
      )) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const response = transport.writtenFrames.find((frame) =>
      typeof frame === "object" && frame !== null && "id" in frame && frame.id === 991,
    ) as { error?: { code?: number; message?: string }; result?: unknown } | undefined;

    const summarizedFrames = transport.writtenFrames.map((frame) => {
      if (typeof frame !== "object" || frame === null) return { kind: typeof frame };
      const value = frame as { id?: unknown; error?: { code?: unknown }; result?: unknown };
      return { id: value.id, errorCode: value.error?.code, hasResult: "result" in value };
    });
    expect(summarizedFrames).toContainEqual({ id: 991, errorCode: -32601, hasResult: false });
    expect(response?.error?.code).toBe(-32601);
    expect(response?.result).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain("approval-secret-looking-id");
    await host.close();
  });

  test("mspHostFailsClosedOnStructuredUserInputWithoutFabricatingAnAnswer", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ capabilities: { userInputDialogs: false } }, {
      createHandshake: () => fake.handshake,
    });
    transport.deliver({
      jsonrpc: "2.0",
      id: 992,
      method: "userInput/request",
      params: {
        itemId: "item-1",
        questions: [{
          header: "Choice",
          id: "question-1",
          options: [{ label: "A" }, { label: "B" }],
          question: "Choose an option",
          selection: { mode: "single" },
        }],
        sessionId: "ses-1",
        toolCallId: "call-1",
        toolName: "request_user_input",
        turnId: "turn-1",
        userInputId: "input-1",
        viewCursor: "cursor-1",
      },
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (transport.writtenFrames.some((frame) =>
        typeof frame === "object" && frame !== null && "id" in frame && frame.id === 992,
      )) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const response = transport.writtenFrames.find((frame) =>
      typeof frame === "object" && frame !== null && "id" in frame && frame.id === 992,
    ) as { error?: { code?: number }; result?: unknown } | undefined;
    expect(response?.error?.code).toBe(-32601);
    expect(response?.result).toBeUndefined();
    expect(transport.requests.some((request) => request.method === "userInput/answer")).toBe(false);
    await host.close();
  });

  test("mspHost.startTimeoutClosesTheHalfStartedHandshake", async () => {
    let closeCount = 0;
    const hostPromise = MspHost.start({ startupTimeoutMs: 10 }, {
      createHandshake: () => ({
        initialize: () => new Promise(() => {}),
        async close() { closeCount += 1; },
      }),
    });

    await expect(hostPromise).rejects.toBeInstanceOf(MspStartupTimeoutError);
    expect(closeCount).toBe(1);
  });

  test("mspHost.commandTimeoutPoisonsAndClosesTheAmbiguousHost", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : new Promise(() => {}));
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ commandTimeoutMs: 10 }, { createHandshake: () => fake.handshake });

    await expect(host.command("turn/start", {
      commandId: "018f4f17-9c2a-7c1a-a0fd-67a19db5c004",
      sessionId: "ses_probe",
      input: [{ type: "text", text: "probe" }],
    })).rejects.toBeInstanceOf(MspCommandTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.isClosed).toBe(true);
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.forwardsStartResumeAndForkWithTheirExactCommandIds", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    const ids = [
      "018f4f17-9c2a-7c1a-a0fd-67a19db5c010",
      "018f4f17-9c2a-7c1a-a0fd-67a19db5c011",
      "018f4f17-9c2a-7c1a-a0fd-67a19db5c012",
    ];

    await host.command("session/start", { commandId: ids[0]!, workspaceRoot: "/workspace" });
    await host.command("session/resume", { commandId: ids[1]!, sessionId: "ses_probe" });
    await host.command("session/fork", { commandId: ids[2]!, sessionId: "ses_probe", cutPoint: { lastTurnId: "turn-1" } });

    expect(transport.requests.filter((request) => ["session/start", "session/resume", "session/fork"].includes(request.method))
      .map((request) => request.params?.commandId)).toEqual(ids);
    await host.close();
  });

  test("mspHost.closeIsIdempotent", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    await Promise.all([host.close(), host.close(), host.close()]);
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.exposesOnlySanitizedChildExitFields", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport, { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }, Promise.resolve({
      kind: "crash",
      exitCode: 3,
      exitSignal: null,
      stderrTail: ["credential-looking-value"],
    }));
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    const exit = await host.exited;

    expect(exit).toEqual({ kind: "crash", exitCode: 3, exitSignal: null });
    expect(JSON.stringify(exit)).not.toContain("credential-looking-value");
    expect(host.isClosed).toBe(true);
  });

  test("mspHost.startsWithAWarningOnChangedServedFingerprintAndKeepsTheRuntimeOpen", async () => {
    const servedFingerprint = "sha256:7fddaf646dbc317e5fcac0785e135eb04df14fbb0db1863089dfd6da21730e5b";
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: servedFingerprint } }
      : {});
    const fake = fakeHandshake(transport);

    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });

    expect(host.fingerprintWarning?.served).toBe(servedFingerprint);
    expect(host.fingerprintWarning?.pinned).toBe(EXPECTED_SCHEMA_FINGERPRINT);
    expect(fake.closeCount).toBe(0);
    await host.close();
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.rejectsAMissingOrMalformedServedFingerprintAndClosesTheRuntime", async () => {
    for (const schema of [{ fingerprint: "sha256:changed" }, {}]) {
      const transport = new FakeMspTransport((request) => request.method === "initialize"
        ? { schema }
        : {});
      const fake = fakeHandshake(transport);

      await expect(MspHost.start({}, { createHandshake: () => fake.handshake }))
        .rejects.toBeInstanceOf(MspSchemaMismatchError);
      expect(fake.closeCount).toBe(1);
    }
  });

  test("mspHost.rejectsAnUnsupportedEnvelopeVersionAndClosesTheRuntime", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT, version: 999 } }
      : {});
    const fake = fakeHandshake(transport);

    await expect(MspHost.start({}, { createHandshake: () => fake.handshake }))
      .rejects.toBeInstanceOf(MspSchemaMismatchError);
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.routesServerRequestsToARegisteredHandler", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    const host = await MspHost.start({
      onServerRequest: async (request) => {
        seen.push({ method: request.method, params: request.params ?? {} });
        return { status: "received" };
      },
    }, { createHandshake: () => fake.handshake });
    transport.deliver({
      jsonrpc: "2.0",
      id: 991,
      method: "approval/request",
      params: { sessionId: "ses-1", approvalId: "approval-1" },
    });
    for (let attempt = 0; attempt < 20 && !transport.writtenFrames.some((frame) =>
      typeof frame === "object" && frame !== null && "id" in frame && (frame as { id: unknown }).id === 991,
    ); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const response = transport.writtenFrames.find((frame) =>
      typeof frame === "object" && frame !== null && "id" in frame && (frame as { id: unknown }).id === 991,
    ) as { result?: unknown; error?: unknown } | undefined;

    expect(seen).toEqual([{ method: "approval/request", params: { sessionId: "ses-1", approvalId: "approval-1" } }]);
    expect(response?.error).toBeUndefined();
    expect(response?.result).toEqual({ status: "received" });
    await host.close();
  });

  test("mspHost.closeReportsFailureWithoutLeakingRuntimeText", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const connection = new Connection(transport);
    const host = await MspHost.start({}, {
      createHandshake: () => ({
        async initialize(params: Parameters<MspHandshake["initialize"]>[0]) {
          const initializeResult = await connection.request("initialize", {
            clientInfo: params.clientInfo,
            capabilities: params.capabilities,
          });
          return {
            connection,
            initializeResult,
            async close() { throw new Error("credential-looking-value"); },
          };
        },
        async close() {},
      }),
    });

    await expect(host.close()).rejects.toBeInstanceOf(MspTransportError);
    expect(host.isClosed).toBe(true);
  });

  test("mspHost.closesTheChildAfterAProtocolViolation", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    transport.deliverRaw("not-json");

    for (let attempt = 0; attempt < 20 && !host.isClosed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(host.isClosed).toBe(true);
    expect(fake.closeCount).toBe(1);
  });
});
