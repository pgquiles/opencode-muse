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

  test("mspHost.acksUnroutableApprovalRequestsWithoutDeciding", async () => {
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
    expect(summarizedFrames).toContainEqual({ id: 991, errorCode: undefined, hasResult: true });
    expect(response?.error).toBeUndefined();
    expect(response?.result).toEqual({});
    expect(transport.requests.some((request) => request.method === "approval/decide")).toBe(false);
    expect(JSON.stringify(transport.writtenFrames)).not.toContain("approval-secret-looking-id");
    await host.close();
  });

  test("mspHostParksStructuredUserInputWithoutFabricatingAnAnswer", async () => {
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
    // A parked request acks nothing until a verdict settles it: poll the
    // exchange instead of the wire.
    for (let attempt = 0; attempt < 50 && host.userInput.pendingUserInputIds().length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    // The request no longer fails with method-not-found: it parks for a real
    // conversational verdict instead of inventing an answer.
    expect(host.userInput.pendingUserInputIds()).toEqual(["input-1"]);
    expect(transport.requests.some((request) =>
      request.method === "userInput/answer" || request.method === "userInput/cancel",
    )).toBe(false);
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
        return {};
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
    expect(response?.result).toEqual({});
    await host.close();
  });

  test("mspHost.acksApprovalRequestsAndDecidesOnSettle", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const parked: Array<{ museTurnId: string; approvalId: string }> = [];
    const host = await MspHost.start({
      approvalTimeoutMs: 50,
      onApprovalParked: (info) => { parked.push(info); },
    }, { createHandshake: () => fake.handshake });
    transport.deliver({
      jsonrpc: "2.0",
      id: 993,
      method: "approval/request",
      params: {
        sessionId: "ses-1",
        turnId: "turn-1",
        approvalId: "approval-9",
        currentRequirementId: "req-1",
        toolCallId: "call-9",
        toolName: "shell",
        availableChoices: [
          { choiceId: "allow-once", decision: "approve", label: "Allow once", scope: "once" },
          { choiceId: "deny", decision: "reject", label: "Deny", scope: "once" },
        ],
      },
    });
    for (let attempt = 0; attempt < 50 && parked.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(parked).toEqual([{ museTurnId: "turn-1", approvalId: "approval-9" }]);
    expect(host.approvals.pendingApprovalIds()).toEqual(["approval-9"]);

    expect(host.approvals.settle("approval-9", true)).toBe(true);
    for (let attempt = 0; attempt < 50 && !transport.requests.some((request) =>
      request.method === "approval/decide",
    ); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const decide = transport.requests.find((request) => request.method === "approval/decide");
    expect(decide?.params).toMatchObject({
      sessionId: "ses-1",
      approvalId: "approval-9",
      choiceId: "allow-once",
      requirementId: "req-1",
    });
    expect(typeof (decide?.params as { commandId?: unknown }).commandId).toBe("string");
    const response = transport.writtenFrames.find((frame) =>
      typeof frame === "object" && frame !== null && "id" in frame && (frame as { id: unknown }).id === 993,
    ) as { result?: unknown; error?: unknown } | undefined;
    expect(response?.error).toBeUndefined();
    expect(response?.result).toEqual({});
    await host.close();
  });

  test("mspHost.decidesTheExactConversationalChoice", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ approvalTimeoutMs: 50 }, { createHandshake: () => fake.handshake });
    transport.deliver({
      jsonrpc: "2.0",
      id: 996,
      method: "approval/request",
      params: {
        sessionId: "ses-1",
        turnId: "turn-1",
        approvalId: "approval-12",
        currentRequirementId: "req-1",
        toolCallId: "call-12",
        availableChoices: [
          { choiceId: "allow-once", decision: "approve", label: "Allow once", scope: "once" },
          { choiceId: "deny", decision: "reject", label: "Deny", scope: "once" },
        ],
      },
    });
    for (let attempt = 0; attempt < 50 && host.approvals.pendingApprovalIds().length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(host.approvals.settleChoice("approval-12", "allow-once")).toBe(true);
    for (let attempt = 0; attempt < 50 && !transport.requests.some((request) =>
      request.method === "approval/decide"
    ); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const decide = transport.requests.find((request) => request.method === "approval/decide");
    expect(decide?.params).toMatchObject({ approvalId: "approval-12", choiceId: "allow-once", requirementId: "req-1" });
    await host.close();
  });

  test("mspHost.interruptsOnAnInventedConversationalChoice", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ approvalTimeoutMs: 50 }, { createHandshake: () => fake.handshake });
    transport.deliver({
      jsonrpc: "2.0",
      id: 997,
      method: "approval/request",
      params: {
        sessionId: "ses-1",
        turnId: "turn-1",
        approvalId: "approval-13",
        currentRequirementId: "req-1",
        toolCallId: "call-13",
        availableChoices: [
          { choiceId: "allow-once", decision: "approve", label: "Allow once", scope: "once" },
        ],
      },
    });
    for (let attempt = 0; attempt < 50 && host.approvals.pendingApprovalIds().length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(host.approvals.settleChoice("approval-13", "invented")).toBe(true);
    for (let attempt = 0; attempt < 50 && !transport.requests.some((request) =>
      request.method === "turn/interrupt"
    ); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(transport.requests.some((request) => request.method === "approval/decide")).toBe(false);
    await host.close();
  });

  test("mspHost.answersAConversationalUserInputChoice", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ approvalTimeoutMs: 50 }, { createHandshake: () => fake.handshake });
    transport.deliver({
      jsonrpc: "2.0",
      id: 998,
      method: "userInput/request",
      params: {
        sessionId: "ses-1",
        turnId: "turn-1",
        toolCallId: "call-14",
        toolName: "shell",
        itemId: "item-1",
        viewCursor: "head-1",
        userInputId: "ui-1",
        questions: [{
          id: "q-color",
          header: "Pick a color",
          question: "Which color?",
          options: [{ label: "Blue" }, { label: "Red" }],
        }],
      },
    });
    for (let attempt = 0; attempt < 50 && host.userInput.pendingUserInputIds().length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(host.userInput.settleAnswer("ui-1", [{ questionId: "q-color", selectedLabel: "Blue" }])).toBe(true);
    for (let attempt = 0; attempt < 50 && !transport.requests.some((request) =>
      request.method === "userInput/answer"
    ); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const answer = transport.requests.find((request) => request.method === "userInput/answer");
    expect(answer?.params).toMatchObject({
      sessionId: "ses-1",
      userInputId: "ui-1",
      answers: [{ questionId: "q-color", selectedLabel: "Blue" }],
    });
    expect(typeof (answer?.params as { commandId?: unknown }).commandId).toBe("string");
    expect(transport.requests.some((request) => request.method === "userInput/cancel")).toBe(false);
    await host.close();
  });

  test("mspHost.cancelsUserInputWithAnInventedLabel", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ approvalTimeoutMs: 50 }, { createHandshake: () => fake.handshake });
    transport.deliver({
      jsonrpc: "2.0",
      id: 999,
      method: "userInput/request",
      params: {
        sessionId: "ses-1",
        turnId: "turn-1",
        toolCallId: "call-15",
        itemId: "item-1",
        viewCursor: "head-1",
        userInputId: "ui-2",
        questions: [{
          id: "q-color",
          header: "Pick a color",
          question: "Which color?",
          options: [{ label: "Blue" }],
        }],
      },
    });
    for (let attempt = 0; attempt < 50 && host.userInput.pendingUserInputIds().length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(host.userInput.settleAnswer("ui-2", [{ questionId: "q-color", selectedLabel: "Invented" }])).toBe(true);
    for (let attempt = 0; attempt < 50 && !transport.requests.some((request) =>
      request.method === "userInput/cancel"
    ); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(transport.requests.some((request) => request.method === "userInput/answer")).toBe(false);
    await host.close();
  });

  test("mspHost.deniesApprovalOnVerdictTimeout", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ approvalTimeoutMs: 5 }, { createHandshake: () => fake.handshake });
    transport.deliver({
      jsonrpc: "2.0",
      id: 994,
      method: "approval/request",
      params: {
        sessionId: "ses-1",
        turnId: "turn-1",
        approvalId: "approval-10",
        currentRequirementId: "req-1",
        toolCallId: "call-10",
        availableChoices: [
          { choiceId: "allow-once", decision: "approve", label: "Allow once", scope: "once" },
          { choiceId: "deny", decision: "reject", label: "Deny", scope: "once" },
        ],
      },
    });
    for (let attempt = 0; attempt < 50 && !transport.requests.some((request) =>
      request.method === "approval/decide",
    ); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const decide = transport.requests.find((request) => request.method === "approval/decide");
    expect(decide?.params).toMatchObject({ approvalId: "approval-10", choiceId: "deny" });
    expect(transport.requests.some((request) => request.method === "turn/interrupt")).toBe(false);
    await host.close();
  });

  test("mspHost.interruptsTurnWhenNoChoiceCanResolveTheApproval", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ approvalTimeoutMs: 5 }, { createHandshake: () => fake.handshake });
    transport.deliver({
      jsonrpc: "2.0",
      id: 995,
      method: "approval/request",
      params: {
        sessionId: "ses-1",
        turnId: "turn-1",
        approvalId: "approval-11",
        currentRequirementId: "req-1",
        toolCallId: "call-11",
        availableChoices: [],
      },
    });
    for (let attempt = 0; attempt < 50 && !transport.requests.some((request) =>
      request.method === "turn/interrupt",
    ); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const interrupt = transport.requests.find((request) => request.method === "turn/interrupt");
    expect(interrupt?.params).toMatchObject({ sessionId: "ses-1", turnId: "turn-1" });
    expect(transport.requests.some((request) => request.method === "approval/decide")).toBe(false);
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
