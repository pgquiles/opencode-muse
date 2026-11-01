import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../../src/session/registry.js";
import { WorkspaceLock } from "../../src/session/workspace-lock.js";
import { MuseSessionManager } from "../../src/session/manager.js";
import { MspCommandRejectedError, MspCommandTimeoutError, MuseInvalidConfigError, WorkspaceBusyError, MuseRecoveryChoiceRequiredError } from "../../src/errors.js";
import { ApprovalExchange } from "../../src/msp/approvals.js";
import { UserInputExchange } from "../../src/msp/user-input.js";
import type { ContributorMode } from "../../src/msp/contributor.js";
import type { RequestContext } from "../../src/types.js";

const roots: string[] = [];
const workspaceFingerprint = (directory: string) => createHash("sha256").update(directory).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-muse-manager-"));
  roots.push(path);
  return path;
}

function context(sessionID: string, directory: string): RequestContext {
  return {
    sessionID,
    directory,
    kind: "primary",
    modelID: "muse-profile-tbh-model-wonder",
    providerID: "muse",
    museSelection: {
      providerId: "meta",
      profileId: "tbh",
      modelId: "wonder",
      isActive: false,
      isDefault: true,
      defaultReasoningEffort: "high",
      variantsKnown: true,
      variants: ["high"],
    },
  };
}

function managerAt(
  root: string,
  failSetModel = false,
  resumeActiveTurn = false,
  registryOverride?: SessionRegistry,
  workspaceLockOverride?: WorkspaceLock,
  closeGate?: { started(): void; wait: Promise<void> },
  contributorMode?: ContributorMode,
  toolBackend?: "muse" | "opencode",
  rejectCommands?: Record<string, { code: number; kind: string }>,
) {
  let id = 0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const hostOptions: Array<Record<string, unknown>> = [];
  const hosts: Array<{ closeCount: number }> = [];
  const exchanges: ApprovalExchange[] = [];
  const userExchanges: UserInputExchange[] = [];
  const registry = registryOverride ?? new SessionRegistry({ stateDirectory: root });
  const manager = new MuseSessionManager({
    stateDirectory: root,
    registry,
    workspaceLock: workspaceLockOverride ?? new WorkspaceLock({ stateDirectory: root }),
    contributorMode,
    toolBackend,
    async createHost(options) {
      hostOptions.push(options as unknown as Record<string, unknown>);
      const record = { closeCount: 0 };
      hosts.push(record);
      const approvals = new ApprovalExchange({ timeoutMs: 50 });
      exchanges.push(approvals);
      const userInput = new UserInputExchange({ timeoutMs: 50 });
      userExchanges.push(userInput);
      return {
        initializeResult: { sessionDurability: "durable" },
        mintCommandId: () => `018f4f17-9c2a-7c1a-a0fd-67a19db5d1${String(id++).padStart(2, "0")}`,
        approvals,
        userInput,
        async command(method: string, params: Record<string, unknown>) {
          calls.push({ method, params });
          const rejection = rejectCommands?.[method];
          if (rejection) throw new MspCommandRejectedError(method, rejection.code, rejection.kind);
          if (failSetModel && method === "session/setModel") {
            throw new MspCommandTimeoutError(method, 10);
          }
          if (method === "session/start") {
            return { session: { sessionId: `ses_muse_${calls.length}`, activeTurnId: null }, viewCursor: "head-1" };
          }
          if (method === "session/resume") {
            return {
              session: { sessionId: params.sessionId, activeTurnId: resumeActiveTurn ? "turn_unknown" : null },
              viewCursor: "resumed-head",
            };
          }
          if (method === "session/setModel") return { commandId: params.commandId, status: "accepted" };
          if (method === "session/fork") {
            return {
              session: { sessionId: `ses_muse_fork_${calls.length}`, activeTurnId: null },
              viewCursor: "fork-head",
              history: {},
              pendingRequests: [],
            };
          }
          return {};
        },
        async request() { return {}; },
        subscribe() { return { async *[Symbol.asyncIterator]() {} }; },
        async close() {
          record.closeCount += 1;
          closeGate?.started();
          await closeGate?.wait;
        },
        options,
      } as never;
    },
  });
  return { manager, calls, hosts, hostOptions, exchanges, userExchanges };
}

describe("MuseSessionManager", () => {
  test("sessionManager.createsOneHostAndMuseSessionPerOpenCodeSession", async () => {
    const root = tempRoot();
    const { manager, calls, hostOptions } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.commitTranscriptFingerprints?.(["d".repeat(64)]);
    await first.release?.();
    const second = await manager.resolveSession(context("ses_oc_1", directory));

    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    expect(second.sessionId).toBe(first.sessionId);
    expect(calls[0]?.params).toMatchObject({
      providerId: "meta",
      modelId: "wonder",
      workspaceRoot: directory,
    });
    expect(hostOptions[0]?.capabilities).toEqual({ userInputDialogs: false, experimentalApi: true });
    expect(await new SessionRegistry({ stateDirectory: root }).get("ses_oc_1", workspaceFingerprint(directory))).toMatchObject({
      museSessionId: first.sessionId,
      providerId: "meta",
      profileId: "tbh",
      modelId: "wonder",
      transcriptFingerprints: ["d".repeat(64)],
    });
    expect(second.previousTranscriptFingerprints).toEqual(["d".repeat(64)]);
    await second.release?.();
    await manager.close();
  });

  test("sessionManager.briefsTheModelAgainstProsePermissionAsks", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));

    expect(first.sessionNotices?.join("\n")).toContain("do not ask the user for permission in prose");
    await manager.close();
  });

  test("sessionManager.spawnsServeWithTheRequestedBillingLane", async () => {
    for (const [mode, flag] of [[undefined, "on"], ["off", "off"]] as const) {
      const root = tempRoot();
      const { manager, hostOptions } = managerAt(root, false, false, undefined, undefined, undefined, mode);
      const directory = join(root, "project");
      mkdirSync(directory);
      const binding = await manager.resolveSession(context("ses_oc_1", directory));
      await binding.release?.();

      expect(hostOptions[0]?.args).toEqual(["serve", "--provider", "meta", "--contributor-mode", flag]);
      await manager.close();
    }
  });

  test("sessionManager.rejectsSecondOpenCodeWriterForSameWorkspace", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));

    await expect(manager.resolveSession(context("ses_oc_2", directory))).rejects.toBeInstanceOf(WorkspaceBusyError);
    await first.release?.();
    await manager.close();
  });

  test("sessionManager.requiresUserChoiceForAnUnreconciledPendingCommand", async () => {
    const root = tempRoot();
    const registry = new SessionRegistry({ stateDirectory: root });
    await registry.put({
      openCodeSessionId: "ses_oc_1",
      museSessionId: "ses_muse_existing",
      hostId: "host_old",
      workspaceFingerprint: workspaceFingerprint(join(root, "project")),
      providerId: "meta",
      profileId: "tbh",
      modelId: "wonder",
      transcriptFingerprints: [],
      compactionFingerprints: [],
      pendingCommands: {
        "018f4f17-9c2a-7c1a-a0fd-67a19db5d1f1": { method: "turn/start", fingerprint: "b".repeat(64) },
      },
    });
    const { manager, calls } = managerAt(root);

    await expect(manager.resolveSession(context("ses_oc_1", join(root, "project"))))
      .rejects.toBeInstanceOf(MuseRecoveryChoiceRequiredError);
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
    await manager.close();
  });

  test("sessionManager.resumesOnlyAStoredDurableSessionAtItsObservedCursor", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = managerAt(root);
    const binding = await first.manager.resolveSession(context("ses_oc_1", directory));
    await binding.release?.();
    await first.manager.close();

    const restarted = managerAt(root);
    const resumed = await restarted.manager.resolveSession(context("ses_oc_1", directory));

    const resumeCall = restarted.calls.find((call) => call.method === "session/resume");
    expect(resumeCall?.params).toMatchObject({ sessionId: binding.sessionId, cursor: "head-1" });
    expect(restarted.calls.some((call) => call.method === "session/start")).toBe(false);
    expect(resumed.sessionId).toBe(binding.sessionId);
    await resumed.release?.();
    await restarted.manager.close();
  });

  test("sessionManager.doesNotResumeWhenMuseReportsAnUnmappedActiveTurn", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = managerAt(root);
    const binding = await first.manager.resolveSession(context("ses_oc_1", directory));
    await binding.release?.();
    await first.manager.close();

    const restarted = managerAt(root, false, true);
    await expect(restarted.manager.resolveSession(context("ses_oc_1", directory)))
      .rejects.toBeInstanceOf(MuseRecoveryChoiceRequiredError);
    expect(restarted.calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(restarted.calls.some((call) => call.method === "session/start")).toBe(false);
    await restarted.manager.close();
  });

  test("sessionManager.appliesProfileAndModelChangesToTheExistingMuseSession", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager, calls } = managerAt(root);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.release?.();
    const changed = context("ses_oc_1", directory);
    changed.museSelection = {
      ...changed.museSelection,
      providerId: "meta",
      profileId: "other-profile",
      modelId: "spark",
    };
    const second = await manager.resolveSession(changed);

    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "session/setModel")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "session/setModel").at(-1)?.params.model).toEqual({
      providerId: "meta",
      profileId: "other-profile",
      modelId: "spark",
    });
    expect(second.sessionId).toBe(first.sessionId);
    await second.release?.();
    await manager.close();
  });

  test("sessionManager.neverRepeatsAModelSwitchAfterItsOutcomeBecomesUnknown", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager, calls } = managerAt(root, true);

    await expect(manager.resolveSession(context("ses_oc_1", directory))).rejects.toBeInstanceOf(MspCommandTimeoutError);
    await expect(manager.resolveSession(context("ses_oc_1", directory))).rejects.toBeInstanceOf(MuseRecoveryChoiceRequiredError);
    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "session/setModel")).toHaveLength(1);
    await manager.close();
  });

  test("sessionManager.persistsOnlyTheCompactionCandidateHash", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager } = managerAt(root);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));
    const candidate = "9".repeat(64);

    await expect(manager.recordCompactionCandidate("ses_oc_1", candidate)).rejects.toBeInstanceOf(WorkspaceBusyError);
    await binding.release?.();
    await manager.recordCompactionCandidate("ses_oc_1", candidate);
    const entry = await new SessionRegistry({ stateDirectory: root }).get("ses_oc_1", workspaceFingerprint(directory));
    expect(entry?.compactionFingerprints).toEqual([candidate]);
    expect(JSON.stringify(entry)).not.toContain("summary body");
    await binding.commitTranscriptFingerprints?.(["a".repeat(64)]);
    const committed = await new SessionRegistry({ stateDirectory: root }).get("ses_oc_1", workspaceFingerprint(directory));
    expect(committed?.compactionFingerprints).toEqual([]);
    expect(committed?.transcriptFingerprints).toEqual(["a".repeat(64)]);
    await manager.close();
  });

  test("sessionManagerKeepsAllowlistedAgentInstructionsInMemoryOnly", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager } = managerAt(root);
    manager.setContextForSession("ses_oc_1", {
      supported: true,
      fragments: [{ label: "OpenCode agent instructions", text: "Never print the private deployment token." }],
    });
    const binding = await manager.resolveSession(context("ses_oc_1", directory));

    expect(binding.contextAllowlist).toEqual([
      { label: "OpenCode agent instructions", text: "Never print the private deployment token." },
    ]);
    const saved = await new SessionRegistry({ stateDirectory: root }).get("ses_oc_1", workspaceFingerprint(directory));
    expect(JSON.stringify(saved)).not.toContain("private deployment token");
    await binding.release?.();
    await manager.close();
  });

  test("sessionManager.clearsAcknowledgedCommandFingerprintsAtTerminalAfterCleanupWriteFailure", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const registry = new SessionRegistry({ stateDirectory: root });
    const clear = registry.clearPendingCommand.bind(registry);
    let failNextClear = true;
    registry.clearPendingCommand = async (...args: Parameters<SessionRegistry["clearPendingCommand"]>) => {
      if (failNextClear) {
        failNextClear = false;
        throw new Error("temporary state write failure");
      }
      return clear(...args);
    };
    const { manager } = managerAt(root, false, false, registry);
    const ctx = context("ses_oc_1", directory);
    ctx.museSelection = { ...ctx.museSelection, profileId: null };
    const binding = await manager.resolveSession(ctx);
    const commandId = "018f4f17-9c2a-7c1a-a0fd-67a19db5d1f9";
    await binding.recordPendingCommand?.({ commandId, method: "turn/start", fingerprint: "c".repeat(64) });
    await expect(binding.clearPendingCommand?.(commandId)).rejects.toThrow("temporary state write failure");
    await binding.recordTurnAccepted?.(commandId, "turn_running");
    await binding.recordTurnCompleted?.("turn_running", "completed");

    const entry = await registry.get("ses_oc_1", workspaceFingerprint(directory));
    expect(entry?.pendingCommands).toEqual({});
    expect(entry?.activeTurnId).toBeUndefined();
    await binding.release?.();
    await manager.close();
  });

  test("sessionManager.keepsMonitoringWhenAPerEventCursorWriteFails", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const registry = new SessionRegistry({ stateDirectory: root });
    const { manager } = managerAt(root, false, false, registry);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));
    const update = registry.updateCursor.bind(registry);
    registry.updateCursor = async () => { throw new Error("disk temporarily unavailable"); };

    await expect(binding.updateCursor?.("cursor-unpersisted")).resolves.toBeUndefined();
    registry.updateCursor = update;
    expect((await registry.get("ses_oc_1", workspaceFingerprint(directory)))?.viewCursor).toBe("head-1");
    await binding.release?.();
    await manager.close();
  });

  test("sessionManager.keepsTheWorkspaceLockUntilHostShutdownCompletes", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const lock = new WorkspaceLock({ stateDirectory: root });
    let markHostClosing!: () => void;
    let finishHostClose!: () => void;
    const hostClosing = new Promise<void>((resolve) => { markHostClosing = resolve; });
    const hostCloseGate = new Promise<void>((resolve) => { finishHostClose = resolve; });
    const { manager } = managerAt(root, false, false, undefined, lock, {
      started: markHostClosing,
      wait: hostCloseGate,
    });
    const binding = await manager.resolveSession(context("ses_oc_1", directory));
    const closing = manager.close();
    await hostClosing;

    await expect(lock.acquire(workspaceFingerprint(directory), "ses_other"))
      .rejects.toBeInstanceOf(WorkspaceBusyError);
    finishHostClose();
    await closing;
    const lease = await lock.acquire(workspaceFingerprint(directory), "ses_other");
    await lease.release();
    await binding.release?.();
  });

  test("sessionManager.rejectsWorkspaceChangeForAnExistingOpenCodeSession", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directoryA = join(root, "project-a");
    const directoryB = join(root, "project-b");
    mkdirSync(directoryA);
    mkdirSync(directoryB);
    const first = await manager.resolveSession(context("ses_oc_1", directoryA));
    await first.release?.();

    await expect(manager.resolveSession(context("ses_oc_1", directoryB)))
      .rejects.toThrow(/different workspace/);
    await manager.close();
  });

  function parkApproval(exchange: ApprovalExchange, sessionId: string, turnId: string, approvalId = "approval-9") {
    return exchange.requestApproval({
      sessionId,
      turnId,
      approvalId,
      currentRequirementId: "req-1",
      availableChoices: [],
      toolCallId: "call-9",
    });
  }

  test("sessionManager.startsMuseSessionsWithOnRequestApprovalMode", async () => {
    const root = tempRoot();
    const { manager, calls } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));

    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    expect(calls.find((call) => call.method === "session/start")?.params).toMatchObject({
      approvalMode: "onRequest",
    });
    await binding.release?.();
    await manager.close();
  });

  test("sessionManager.settlesApprovalResponsesAndArmsJoinForTheActiveTurn", async () => {
    const root = tempRoot();
    const { manager, calls, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = exchanges[0] as ApprovalExchange;
    const parked = parkApproval(exchange, first.sessionId, "turn-1");
    expect(exchange.pendingApprovalIds()).toEqual(["approval-9"]);

    const matched = await manager.settleApprovalResponses("ses_oc_1", [{ approvalId: "approval-9", approved: true }]);
    await parked;

    expect(matched).toEqual(["approval-9"]);
    expect(manager.hasParkedApprovals("ses_oc_1")).toBe(false);
    expect(first.joinParkedTurnId).toBe("turn-1");

    // The lease is still held by the parked call, so a re-acquire would fail;
    // the join path must return the same binding without acquiring.
    const second = await manager.resolveSession(context("ses_oc_1", directory));
    expect(second).toBe(first);
    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    await manager.close();
  });

  test("sessionManager.marksFollowUpResolveForSteeringIntoTheLiveTurn", async () => {
    const root = tempRoot();
    const { manager, calls } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");

    const second = await manager.resolveSession(context("ses_oc_1", directory));
    expect(second).toBe(first);
    expect(second.steerExpectedTurnId).toBe("turn-1");
    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    await manager.close();
  });

  test("sessionManager.steersInsteadOfRejectingWhileApprovalIsParked", async () => {
    // #44 decision: new user text steers into the parked turn; only a
    // resolve with no live turn to target still fails closed.
    const root = tempRoot();
    const { manager, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    parkApproval(exchanges[0] as ApprovalExchange, first.sessionId, "turn-1");

    const second = await manager.resolveSession(context("ses_oc_1", directory));
    expect(second.steerExpectedTurnId).toBe("turn-1");
    await manager.close();
  });

  test("sessionManager.resolvesTheFollowUpTurnAfterAnUnmatchedVerdictWithoutReacquiring", async () => {
    const root = tempRoot();
    const { manager, calls, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = exchanges[0] as ApprovalExchange;
    exchange.requestApproval({
      sessionId: first.sessionId,
      turnId: "turn-1",
      approvalId: "approval-9",
      currentRequirementId: "req-1",
      toolCallId: "call-9",
      toolName: "shell",
      availableChoices: [
        { choiceId: "allow-once", decision: "approve", label: "Allow once", scope: "once" },
        { choiceId: "deny-once", decision: "reject", label: "Deny", scope: "once" },
      ],
    });

    // Gibberish matches nothing: the turn ends synthetically with a re-ask,
    // and the follow-up resolve must reattach without touching the lease
    // the parked turn still holds. doPrepare passes verdictConsumed because
    // the peek consumed (a re-ask outcome is still a consumption).
    const reask = await manager.consumeConversationalVerdict("ses_oc_1", "yes please");
    expect(reask).toMatchObject({ settledLast: false });
    expect(first.joinParkedTurnId).toBeUndefined();

    const second = await manager.resolveSession(context("ses_oc_1", directory), { verdictConsumed: true });
    expect(second).toBe(first);
    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    await manager.close();
  });

  test("sessionManager.flagsASecondMismatchDenyToRunTheMessage", async () => {
    const root = tempRoot();
    const { manager, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = exchanges[0] as ApprovalExchange;
    exchange.requestApproval({
      sessionId: first.sessionId,
      turnId: "turn-1",
      approvalId: "approval-9",
      currentRequirementId: { approvalId: "approval-9", sourceIndex: 0 },
      toolCallId: "call-9",
      toolName: "network",
      availableChoices: [
        { choiceId: "allow-once", decision: "approve", label: "Allow once", scope: "once" },
        { choiceId: "deny-once", decision: "reject", label: "Deny", scope: "once" },
      ],
    });

    const reask = await manager.consumeConversationalVerdict("ses_oc_1", "fadf");
    expect(reask).toMatchObject({ settledLast: false });
    expect(reask).not.toHaveProperty("runMessageAsTurn");
    const deny = await manager.consumeConversationalVerdict("ses_oc_1", "bvvdaf");
    expect(deny).toMatchObject({ settledLast: true, runMessageAsTurn: true });
    expect(deny?.text).toContain("That request is closed");
    await manager.close();
  });

  test("sessionManager.explicitRejectDoesNotRunTheMessage", async () => {
    const root = tempRoot();
    const { manager, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = exchanges[0] as ApprovalExchange;
    exchange.requestApproval({
      sessionId: first.sessionId,
      turnId: "turn-1",
      approvalId: "approval-9",
      currentRequirementId: { approvalId: "approval-9", sourceIndex: 0 },
      toolCallId: "call-9",
      toolName: "network",
      availableChoices: [
        { choiceId: "allow-once", decision: "approve", label: "Allow once", scope: "once" },
        { choiceId: "deny-once", decision: "reject", label: "Deny", scope: "once" },
      ],
    });

    const deny = await manager.consumeConversationalVerdict("ses_oc_1", "B");
    expect(deny).toMatchObject({ settledLast: true });
    expect(deny).not.toHaveProperty("runMessageAsTurn");
    await manager.close();
  });

  test("sessionManager.resolvesTheFollowUpTurnAfterAQueuedAnswerWithoutReacquiring", async () => {
    const root = tempRoot();
    const { manager, calls, userExchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = userExchanges[0] as UserInputExchange;
    void exchange.requestUserInput({
      sessionId: first.sessionId,
      turnId: "turn-1",
      toolCallId: "call-1",
      itemId: "item-1",
      viewCursor: "head-1",
      userInputId: "ui-1",
      questions: [
        { id: "q-color", header: "Pick a color", question: "Which color?", options: [{ label: "Blue" }, { label: "Red" }] },
        { id: "q-size", header: "Pick a size", question: "Which size?", options: [{ label: "Big" }, { label: "Small" }] },
      ],
    });

    const queued = await manager.consumeConversationalAnswer("ses_oc_1", "b");
    expect(queued).toMatchObject({ settledLast: false });
    expect(first.joinParkedTurnId).toBeUndefined();

    const second = await manager.resolveSession(context("ses_oc_1", directory), { verdictConsumed: true });
    expect(second).toBe(first);
    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    await manager.close();
  });

  test("sessionManager.settlesALabellessApprovalByLetterAndReattaches", async () => {
    const root = tempRoot();
    const { manager, calls, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = exchanges[0] as ApprovalExchange;
    exchange.requestApproval({
      sessionId: first.sessionId,
      turnId: "turn-1",
      approvalId: "approval-9",
      currentRequirementId: "req-1",
      toolCallId: "call-9",
      toolName: "network",
      availableChoices: [
        { choiceId: "net-allow", decision: "approve", scope: "once" },
        { choiceId: "net-deny", decision: "reject", scope: "once" },
      ],
    });

    // The user's network case: no usable labels, but "a" still settles the
    // derived "Approve (once)" choice instead of denying with no options.
    const outcome = await manager.consumeConversationalVerdict("ses_oc_1", "a");
    expect(outcome).toMatchObject({ settledLast: true });
    expect(outcome?.text).toContain("Approve");

    const second = await manager.resolveSession(context("ses_oc_1", directory));
    expect(second).toBe(first);
    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    expect(first.joinParkedTurnId).toBe("turn-1");
    await manager.close();
  });

  test("sessionManager.defersToALiveBindingInsteadOfOfferingRecovery", async () => {
    // A poisoned entry with a live binding is a slow-but-healthy turn (or
    // the verdict flow's parked turn), not a crash: recovery stays out.
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    await first.release?.();
    expect(await manager.consumeRecoveryDecision("ses_oc_1", "A", directory)).toBeNull();
    await manager.close();
  });

  test("sessionManager.letsAnInflightTurnStartThroughInsteadOfRecovering", async () => {
    // A pending turn/start with a live binding is a slow server acceptance,
    // not a crash: resolution proceeds (the server queues or dedupes) and no
    // recovery error fires, so impatient client retries converge silently.
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.release?.();

    // Plant the ambiguous case directly: turn/start sent, acceptance
    // unknown, no active turn — exactly the slow-server retry shape.
    // (A plain resolve leaves the entry clean, so no clearing is needed.)
    const registry = new SessionRegistry({ stateDirectory: root });
    await registry.recordPendingCommand("ses_oc_1", workspaceFingerprint(directory), {
      commandId: "0194f3c2-9a1e-7b3c-8d4e-5f6a7b8c9d0e",
      method: "turn/start",
      fingerprint: "a".repeat(64),
    });

    // Same process, live binding: no recovery error, same session resumed.
    const second = await manager.resolveSession(context("ses_oc_1", directory));
    expect(second.sessionId).toBe(first.sessionId);
    await manager.close();
  });

  test("sessionManager.keepLeavesThePoisonedEntryUntouched", async () => {
    const root = tempRoot();
    const firstAt = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await firstAt.manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    await first.release?.();
    await firstAt.manager.close();

    // Fresh process, no binding: the crash path offers the choice.
    const restarted = managerAt(root);
    const kept = await restarted.manager.consumeRecoveryDecision("ses_oc_1", "B", directory);
    expect(kept).toMatchObject({ abandoned: false });
    expect(kept?.text).toContain("Abandon");
    // The entry still blocks: a direct resolve still fails closed.
    await expect(restarted.manager.resolveSession(context("ses_oc_1", directory)))
      .rejects.toBeInstanceOf(MuseRecoveryChoiceRequiredError);
    await restarted.manager.close();
  });

  test("sessionManager.abandonDeletesThePoisonedEntry", async () => {
    const root = tempRoot();
    const firstAt = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await firstAt.manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    await first.release?.();
    await firstAt.manager.close();

    const restarted = managerAt(root);
    const abandoned = await restarted.manager.consumeRecoveryDecision("ses_oc_1", "A", directory);
    expect(abandoned).toMatchObject({ abandoned: true });
    expect(abandoned?.text).toContain("Re-prompt");
    const stored = await new SessionRegistry({ stateDirectory: root })
      .get("ses_oc_1", workspaceFingerprint(directory));
    expect(stored).toBeUndefined();
    // A follow-up resolves cleanly and starts a fresh session (the fake
    // reuses session ids per harness, so assert a clean re-created entry).
    await restarted.manager.resolveSession(context("ses_oc_1", directory));
    expect(restarted.calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    const recreated = await new SessionRegistry({ stateDirectory: root })
      .get("ses_oc_1", workspaceFingerprint(directory));
    expect(recreated).toMatchObject({ pendingCommands: {} });
    expect(recreated?.activeTurnId).toBeUndefined();
    await restarted.manager.close();
  });

  test("sessionManager.recoveryDecideIgnoresCleanSessions", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    await manager.resolveSession(context("ses_oc_1", directory));

    expect(await manager.consumeRecoveryDecision("ses_oc_1", "A", directory)).toBeNull();
    expect(await manager.consumeRecoveryDecision("unknown", "A", directory)).toBeNull();
    await manager.close();
  });

  test("sessionManager.deliversStaleVerdictsForDeadTurnsWithoutArmingJoin", async () => {
    const root = tempRoot();
    const { manager, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = exchanges[0] as ApprovalExchange;
    const parked = parkApproval(exchange, first.sessionId, "turn-1");
    await first.recordTurnCompleted?.("turn-1", "completed");
    void parked;

    const matched = await manager.settleApprovalResponses("ses_oc_1", [{ approvalId: "approval-9", approved: true }]);

    expect(matched).toEqual(["approval-9"]);
    expect(first.joinParkedTurnId).toBeUndefined();
    await manager.close();
  });

  test("sessionManager.consumesAConversationalVerdictAndArmsTheJoin", async () => {
    const root = tempRoot();
    const { manager, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = exchanges[0] as ApprovalExchange;
    const parked = exchange.requestApproval({
      sessionId: first.sessionId,
      turnId: "turn-1",
      approvalId: "approval-9",
      currentRequirementId: "req-1",
      toolCallId: "call-9",
      toolName: "shell",
      availableChoices: [
        { choiceId: "allow-once", decision: "approve", label: "Allow once", scope: "once" },
        { choiceId: "deny-once", decision: "reject", label: "Deny", scope: "once" },
      ],
    });

    const outcome = await manager.consumeConversationalVerdict("ses_oc_1", "a");
    const verdict = await parked;

    expect(verdict).toMatchObject({ choiceId: "allow-once" });
    expect(outcome).toMatchObject({ settledLast: true });
    expect(outcome?.text).toContain("Recorded: Allow once (once).");
    expect(first.joinParkedTurnId).toBe("turn-1");
    await manager.close();
  });

  test("sessionManager.reasksOnceThenDeniesAmbiguousVerdicts", async () => {
    const root = tempRoot();
    const { manager, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = exchanges[0] as ApprovalExchange;
    const parked = exchange.requestApproval({
      sessionId: first.sessionId,
      turnId: "turn-1",
      approvalId: "approval-9",
      currentRequirementId: "req-1",
      toolCallId: "call-9",
      availableChoices: [
        { choiceId: "allow-once", decision: "approve", label: "Allow once", scope: "once" },
        { choiceId: "deny-once", decision: "reject", label: "Deny", scope: "once" },
      ],
    });

    const reask = await manager.consumeConversationalVerdict("ses_oc_1", "yes please");
    expect(reask).toMatchObject({ settledLast: false });
    expect(reask?.text).toContain("yes please");
    expect(exchange.pendingApprovalIds()).toEqual(["approval-9"]);

    const denied = await manager.consumeConversationalVerdict("ses_oc_1", "uh huh");
    const verdict = await parked;
    expect(verdict).toMatchObject({ approved: false });
    expect(denied).toMatchObject({ settledLast: true });
    expect(denied?.text).toContain("Denied");
    expect(first.joinParkedTurnId).toBe("turn-1");
    await manager.close();
  });

  test("sessionManager.queuesMultiplePendingApprovalsOldestFirst", async () => {
    const root = tempRoot();
    const { manager, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = exchanges[0] as ApprovalExchange;
    const firstParked = exchange.requestApproval({
      sessionId: first.sessionId,
      turnId: "turn-1",
      approvalId: "approval-9",
      currentRequirementId: "req-1",
      toolCallId: "call-9",
      toolName: "shell",
      availableChoices: [
        { choiceId: "allow-once", decision: "approve", label: "Allow once", scope: "once" },
        { choiceId: "deny-once", decision: "reject", label: "Deny", scope: "once" },
      ],
    });
    const secondParked = exchange.requestApproval({
      sessionId: first.sessionId,
      turnId: "turn-1",
      approvalId: "approval-10",
      currentRequirementId: "req-1",
      toolCallId: "call-10",
      toolName: "edit_file",
      availableChoices: [
        { choiceId: "write-once", decision: "approve", label: "Write file", scope: "once" },
        { choiceId: "deny-write", decision: "reject", label: "Deny", scope: "once" },
      ],
    });

    const queued = await manager.consumeConversationalVerdict("ses_oc_1", "a");
    expect(await firstParked).toMatchObject({ choiceId: "allow-once" });
    expect(queued).toMatchObject({ settledLast: false });
    expect(queued?.text).toContain("Recorded: Allow once (once).");
    expect(queued?.text).toContain("edit_file");

    const last = await manager.consumeConversationalVerdict("ses_oc_1", "Write file");
    expect(await secondParked).toMatchObject({ choiceId: "write-once" });
    expect(last).toMatchObject({ settledLast: true });
    expect(first.joinParkedTurnId).toBe("turn-1");
    await manager.close();
  });

  test("sessionManager.consumesAConversationalAnswerAndJoinsOnTheLastQuestion", async () => {
    const root = tempRoot();
    const { manager, userExchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = userExchanges[0] as UserInputExchange;
    void exchange.requestUserInput({
      sessionId: first.sessionId,
      turnId: "turn-1",
      toolCallId: "call-1",
      itemId: "item-1",
      viewCursor: "head-1",
      userInputId: "ui-1",
      questions: [{
        id: "q-color",
        header: "Pick a color",
        question: "Which color?",
        options: [{ label: "Blue" }, { label: "Red" }],
      }],
    });

    const outcome = await manager.consumeConversationalAnswer("ses_oc_1", "b");
    expect(outcome).not.toBeNull();
    expect(outcome).toMatchObject({ settledLast: true });
    expect(outcome?.text).toContain("Recorded: Red.");
    expect(first.joinParkedTurnId).toBe("turn-1");
    expect(exchange.pendingUserInputIds()).toEqual([]);
    await manager.close();
  });

  test("sessionManager.reasksOnceThenCancelsAmbiguousAnswers", async () => {
    const root = tempRoot();
    const { manager, userExchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = userExchanges[0] as UserInputExchange;
    void exchange.requestUserInput({
      sessionId: first.sessionId,
      turnId: "turn-1",
      toolCallId: "call-1",
      itemId: "item-1",
      viewCursor: "head-1",
      userInputId: "ui-1",
      questions: [{
        id: "q-color",
        header: "Pick a color",
        question: "Which color?",
        options: [{ label: "Blue" }, { label: "Red" }],
      }],
    });

    const reask = await manager.consumeConversationalAnswer("ses_oc_1", "yellow");
    expect(reask).toMatchObject({ settledLast: false });
    expect(reask?.text).toContain("yellow");
    expect(exchange.pendingUserInputIds()).toEqual(["ui-1"]);

    const cancelled = await manager.consumeConversationalAnswer("ses_oc_1", "huh");
    expect(cancelled).toMatchObject({ settledLast: true });
    expect(cancelled?.text).toContain("Cancelled");
    expect(cancelled?.text).toContain("no valid option was given");
    expect(exchange.pendingUserInputIds()).toEqual([]);
    expect(first.joinParkedTurnId).toBe("turn-1");
    await manager.close();
  });

  test("sessionManager.cancelsMultiSelectQuestionsItCannotCollect", async () => {
    const root = tempRoot();
    const { manager, userExchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = userExchanges[0] as UserInputExchange;
    void exchange.requestUserInput({
      sessionId: first.sessionId,
      turnId: "turn-1",
      toolCallId: "call-1",
      itemId: "item-1",
      viewCursor: "head-1",
      userInputId: "ui-1",
      questions: [{
        id: "q-toppings",
        header: "Pick toppings",
        question: "Which toppings?",
        options: [{ label: "Cheese" }, { label: "Basil" }],
        selection: { mode: "multiple", maxSelections: 2 },
      }],
    });

    const outcome = await manager.consumeConversationalAnswer("ses_oc_1", "cheese, basil");
    expect(outcome).toMatchObject({ settledLast: true });
    expect(outcome?.text).toContain("multiple selections");
    expect(exchange.pendingUserInputIds()).toEqual([]);
    await manager.close();
  });

  test("sessionManager.deniesApprovalsWithoutPresentableChoices", async () => {
    const root = tempRoot();
    const { manager, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const exchange = exchanges[0] as ApprovalExchange;
    const parked = exchange.requestApproval({
      sessionId: first.sessionId,
      turnId: "turn-1",
      approvalId: "approval-9",
      currentRequirementId: "req-1",
      toolCallId: "call-9",
      // Truly nothing to offer: label-less choices now derive presentable
      // labels (see settlesALabellessApprovalByLetterAndReattaches), so the
      // deny path only triggers when no choice can be projected at all.
      availableChoices: [],
    });

    const outcome = await manager.consumeConversationalVerdict("ses_oc_1", "a");
    const verdict = await parked;

    expect(verdict).toMatchObject({ approved: false });
    expect(outcome).toMatchObject({ settledLast: true });
    expect(outcome?.text).toContain("no usable options");
    await manager.close();
  });

  test("sessionManager.disarmsJoinsThatCannotAttach", async () => {
    const root = tempRoot();
    const { manager, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    const parked = parkApproval(exchanges[0] as ApprovalExchange, first.sessionId, "turn-1");
    const matched = await manager.settleApprovalResponses("ses_oc_1", [{ approvalId: "approval-9", approved: true }]);
    await parked;

    expect(matched).toEqual(["approval-9"]);
    expect(first.joinParkedTurnId).toBe("turn-1");
    manager.disarmParkedJoin("ses_oc_1");
    expect(first.joinParkedTurnId).toBeUndefined();
    await manager.close();
  });
});

describe("rewind/fork anchors and explicit-cut fork", () => {
  const fa = "a".repeat(64);
  const fb = "b".repeat(64);
  const fc = "c".repeat(64);
  const fd = "d".repeat(64);
  const fe = "e".repeat(64);

  async function seed(root: string, sessionID: string, directory: string, overrides: Record<string, unknown> = {}) {
    const registry = new SessionRegistry({ stateDirectory: root });
    await registry.put({
      openCodeSessionId: sessionID,
      museSessionId: "ses_muse_parent",
      hostId: "host_seed",
      workspaceFingerprint: workspaceFingerprint(directory),
      providerId: "meta",
      modelId: "wonder",
      transcriptFingerprints: [],
      compactionFingerprints: [],
      pendingCommands: {},
      ...overrides,
    } as never);
  }

  async function storedFor(root: string, sessionID: string, directory: string) {
    return new SessionRegistry({ stateDirectory: root }).get(sessionID, workspaceFingerprint(directory));
  }

  test("sessionManager.recordsAnchorsForCleanTurnsOnly", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));
    await binding.recordTurnAccepted?.("018f4f17-9c2a-7c1a-a0fd-67a19db5d100", "turn-1");
    await binding.recordTurnCompleted?.("turn-1", "completed");
    await binding.commitTranscriptFingerprints?.([fa, fb]);
    await binding.recordTurnAccepted?.("018f4f17-9c2a-7c1a-a0fd-67a19db5d101", "turn-2");
    await binding.recordTurnCompleted?.("turn-2", "cancelled");
    await binding.recordTurnAccepted?.("018f4f17-9c2a-7c1a-a0fd-67a19db5d102", "turn-3");
    await binding.recordTurnCompleted?.("turn-3", "completed");
    await binding.commitTranscriptFingerprints?.([fa, fb, fc, fd]);

    expect((await storedFor(root, "ses_oc_1", directory))?.turnAnchors).toEqual([
      { sequenceLength: 2, turnId: "turn-1" },
      { sequenceLength: 4, turnId: "turn-3" },
    ]);
    await manager.close();
  });

  test("sessionManager.resetsAnchorsWhenCommitReplacesHistory", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));
    await binding.recordTurnAccepted?.("018f4f17-9c2a-7c1a-a0fd-67a19db5d100", "turn-1");
    await binding.recordTurnCompleted?.("turn-1", "completed");
    await binding.commitTranscriptFingerprints?.([fa, fb]);
    await binding.recordTurnAccepted?.("018f4f17-9c2a-7c1a-a0fd-67a19db5d101", "turn-9");
    await binding.recordTurnCompleted?.("turn-9", "completed");
    await binding.commitTranscriptFingerprints?.([fe]);

    expect((await storedFor(root, "ses_oc_1", directory))?.turnAnchors).toEqual([
      { sequenceLength: 1, turnId: "turn-9" },
    ]);
    await manager.close();
  });

  test("sessionManager.forksAtRetainedCutAndRepoints", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    await seed(root, "ses_oc_1", directory, {
      transcriptFingerprints: [fa, fb, fc, fd],
      turnAnchors: [
        { sequenceLength: 2, turnId: "turn-1" },
        { sequenceLength: 4, turnId: "turn-2" },
      ],
    });
    const { manager, calls } = managerAt(root);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));

    const result = await manager.forkSessionAtBoundary("ses_oc_1", 2);

    expect(result).toEqual({ forked: true });
    const fork = calls.find((call) => call.method === "session/fork");
    expect(fork?.params).toMatchObject({ sessionId: "ses_muse_parent", cutPoint: { lastTurnId: "turn-1" } });
    expect(typeof fork?.params.commandId).toBe("string");
    const stored = await storedFor(root, "ses_oc_1", directory);
    expect(stored?.museSessionId).toMatch(/^ses_muse_fork_/);
    // Pre-fork turn ids do not survive a fork (offline probe check 4b), so
    // the re-pointed entry carries no anchors; post-fork turns re-anchor.
    expect(stored?.turnAnchors).toEqual([]);
    expect(stored?.transcriptFingerprints).toEqual([fa, fb]);
    expect(binding.sessionId).toBe(stored?.museSessionId);
    await manager.close();
  });

  test("sessionManager.rejectsUnmappableBoundaryWithoutFork", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    await seed(root, "ses_oc_1", directory, {
      transcriptFingerprints: [fa, fb, fc, fd],
      turnAnchors: [
        { sequenceLength: 2, turnId: "turn-1" },
        { sequenceLength: 4, turnId: "turn-2" },
      ],
    });
    const { manager, calls } = managerAt(root);
    await manager.resolveSession(context("ses_oc_1", directory));

    const result = await manager.forkSessionAtBoundary("ses_oc_1", 3);

    expect(result).toEqual({ forked: false });
    expect(calls.filter((call) => call.method === "session/fork")).toHaveLength(0);
    await manager.close();
  });

  test("sessionManager.adoptsKnownTranscriptForNewSession", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    await seed(root, "ses_oc_parent", directory, {
      transcriptFingerprints: [fa, fb, fc, fd],
      turnAnchors: [
        { sequenceLength: 2, turnId: "turn-1" },
        { sequenceLength: 4, turnId: "turn-2" },
      ],
    });
    const { manager, calls } = managerAt(root);

    const binding = await manager.resolveSession(context("ses_oc_child", directory), { incomingFingerprints: [fa, fb, fc, fd] });

    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(0);
    const fork = calls.find((call) => call.method === "session/fork");
    expect(fork?.params).toMatchObject({ sessionId: "ses_muse_parent" });
    expect("cutPoint" in (fork?.params ?? {})).toBe(false);
    expect(binding.sessionId).toMatch(/^ses_muse_fork_/);
    expect((await storedFor(root, "ses_oc_child", directory))?.turnAnchors).toEqual([]);
    await manager.close();
  });

  test("sessionManager.opencodeBackendStartsWithLoopbackConfigAndAllowAll", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const userMuse = join(root, "user-muse");
    mkdirSync(userMuse, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { manager, calls, hostOptions } = managerAt(root, false, false, undefined, undefined, undefined, undefined, "opencode");
      const binding = await manager.resolveSession(context("ses_oc_1", directory));

      const start = calls.find((call) => call.method === "session/start");
      expect(start?.params).toMatchObject({ approvalMode: "allowAll" });
      const servers = (start?.params.config as { mcpServers?: Record<string, { transport?: string; url?: string; headers?: Record<string, string>; mode?: string }> } | undefined)?.mcpServers;
      expect(servers?.["opencode_loopback"]?.transport).toBe("streamableHttp");
      expect(servers?.["opencode_loopback"]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//);
      expect(servers?.["opencode_loopback"]?.headers?.Authorization).toMatch(/^Bearer [0-9a-f]{48}$/);
      expect(servers?.["opencode_loopback"]?.mode).toBe("required");
      expect(String(hostOptions[0]?.env?.XDG_CONFIG_HOME ?? "")).toContain(join("hosts", "ses_oc_1"));
      expect(hostOptions[0]?.capabilities).toMatchObject({ requestedCapabilities: ["sessionMcp"] });
      expect(binding.sessionId).toMatch(/^ses_muse_/);
      await binding.release?.();
      await manager.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("sessionManager.opencodeBackendRejectsArrayToolSchema", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { manager } = managerAt(root, false, false, undefined, undefined, undefined, undefined, "opencode");
      const binding = await manager.resolveSession(context("ses_oc_1", directory));

      expect(() =>
        binding.syncLoopbackTools?.([{ name: "opencode_write", description: "w", inputSchema: [] }]),
      ).toThrow(/tools/);
      expect(() =>
        binding.syncLoopbackTools?.([{ name: "opencode_write", description: "w", inputSchema: { type: "object" } }]),
      ).not.toThrow();
      await manager.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("sessionManager.opencodeBackendSweepKeepsLiveBinding", async () => {
    const root = tempRoot();
    const directoryA = join(root, "project-a");
    const directoryB = join(root, "project-b");
    mkdirSync(directoryA);
    mkdirSync(directoryB);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { manager } = managerAt(root, false, false, undefined, undefined, undefined, undefined, "opencode");
      await manager.resolveSession(context("ses_oc_a", directoryA));
      const hosts = join(root, "hosts");
      const control = join(hosts, "ses_control", "muse");
      mkdirSync(control, { recursive: true });
      const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
      utimesSync(join(hosts, "ses_oc_a"), past, past);
      utimesSync(join(hosts, "ses_control"), past, past);

      await manager.resolveSession(context("ses_oc_b", directoryB));

      expect(existsSync(join(hosts, "ses_oc_a"))).toBe(true);
      expect(existsSync(join(hosts, "ses_control"))).toBe(false);
      await manager.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("sessionManager.opencodeBackendStartNamesMissingSessionMcpGrant", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { manager } = managerAt(root, false, false, undefined, undefined, undefined, undefined, "opencode", {
        "session/start": { code: -32010, kind: "capabilityRequired" },
      });
      await expect(manager.resolveSession(context("ses_oc_1", directory))).rejects.toThrow(/sessionMcp/);
      await manager.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("sessionManager.opencodeBackendResumeNamesMissingSessionMcpGrant", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const registry = new SessionRegistry({ stateDirectory: root });
    await registry.put({
      openCodeSessionId: "ses_oc_1",
      museSessionId: "ses_muse_old",
      hostId: "host_seed",
      workspaceFingerprint: workspaceFingerprint(directory),
      providerId: "meta",
      modelId: "wonder",
      transcriptFingerprints: [],
      compactionFingerprints: [],
      pendingCommands: {},
    } as never);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { manager } = managerAt(root, false, false, undefined, undefined, undefined, undefined, "opencode", {
        "session/resume": { code: -32010, kind: "capabilityRequired" },
      });
      await expect(manager.resolveSession(context("ses_oc_1", directory))).rejects.toThrow(/sessionMcp/);
      await manager.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("sessionManager.museBackendStartRejectionStaysUntouched", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager } = managerAt(root, false, false, undefined, undefined, undefined, undefined, undefined, {
      "session/start": { code: -32010, kind: "capabilityRequired" },
    });
    const error = await manager.resolveSession(context("ses_oc_1", directory)).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(MspCommandRejectedError);
    expect(error).not.toBeInstanceOf(MuseInvalidConfigError);
    await manager.close();
  });

  test("sessionManager.museBackendOmitsLoopbackConfig", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager, calls, hostOptions } = managerAt(root);
    const binding = await manager.resolveSession(context("ses_oc_1", directory));

    const start = calls.find((call) => call.method === "session/start");
    expect(start?.params).toMatchObject({ approvalMode: "onRequest" });
    expect("config" in (start?.params ?? {})).toBe(false);
    expect(hostOptions[0]?.env).toBeUndefined();
    expect((hostOptions[0]?.capabilities as { requestedCapabilities?: unknown } | undefined)?.requestedCapabilities).toBeUndefined();
    expect(binding.sessionId).toMatch(/^ses_muse_/);
    await binding.release?.();
    await manager.close();
  });

  test("sessionManager.ambiguousTranscriptStaysFresh", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    await seed(root, "ses_oc_p1", directory, { transcriptFingerprints: [fa, fb] });
    await seed(root, "ses_oc_p2", directory, { transcriptFingerprints: [fa, fb] });
    const { manager, calls } = managerAt(root);

    await manager.resolveSession(context("ses_oc_child", directory), { incomingFingerprints: [fa, fb] });

    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "session/fork")).toHaveLength(0);
    await manager.close();
  });
});
