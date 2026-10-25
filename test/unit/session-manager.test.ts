import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../../src/session/registry.js";
import { WorkspaceLock } from "../../src/session/workspace-lock.js";
import { MuseSessionManager } from "../../src/session/manager.js";
import { MspCommandTimeoutError, MuseApprovalPendingError, WorkspaceBusyError, MuseRecoveryChoiceRequiredError } from "../../src/errors.js";
import { ApprovalExchange } from "../../src/msp/approvals.js";
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
) {
  let id = 0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const hostOptions: Array<Record<string, unknown>> = [];
  const hosts: Array<{ closeCount: number }> = [];
  const exchanges: ApprovalExchange[] = [];
  const registry = registryOverride ?? new SessionRegistry({ stateDirectory: root });
  const manager = new MuseSessionManager({
    stateDirectory: root,
    registry,
    workspaceLock: workspaceLockOverride ?? new WorkspaceLock({ stateDirectory: root }),
    async createHost(options) {
      hostOptions.push(options as unknown as Record<string, unknown>);
      const record = { closeCount: 0 };
      hosts.push(record);
      const approvals = new ApprovalExchange({ timeoutMs: 50 });
      exchanges.push(approvals);
      return {
        initializeResult: { sessionDurability: "durable" },
        mintCommandId: () => `018f4f17-9c2a-7c1a-a0fd-67a19db5d1${String(id++).padStart(2, "0")}`,
        approvals,
        async command(method: string, params: Record<string, unknown>) {
          calls.push({ method, params });
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
  return { manager, calls, hosts, hostOptions, exchanges };
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
    expect(hostOptions[0]?.capabilities).toEqual({ userInputDialogs: false });
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

  test("sessionManager.storesAndReturnsEffortPinsPerSession", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);

    expect(manager.effortPinForSession("ses_oc_1")).toBeUndefined();
    manager.setEffortPin("ses_oc_1", "low");
    expect(manager.effortPinForSession("ses_oc_1")).toBe("low");
    manager.setEffortPin("ses_oc_1", "high");
    expect(manager.effortPinForSession("ses_oc_1")).toBe("high");
    expect(manager.effortPinForSession("ses_oc_2")).toBeUndefined();
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

  test("sessionManager.rejectsNewTurnsWhileAnApprovalIsParked", async () => {
    const root = tempRoot();
    const { manager, exchanges } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    parkApproval(exchanges[0] as ApprovalExchange, first.sessionId, "turn-1");

    await expect(manager.resolveSession(context("ses_oc_1", directory)))
      .rejects.toBeInstanceOf(MuseApprovalPendingError);
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
