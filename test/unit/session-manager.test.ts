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

  test("sessionManager.keepLeavesThePoisonedEntryUntouched", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    await first.release?.();

    const kept = await manager.consumeRecoveryDecision("ses_oc_1", "B", directory);
    expect(kept).toMatchObject({ abandoned: false });
    expect(kept?.text).toContain("Abandon");
    // The entry still blocks: a direct resolve still fails closed.
    await expect(manager.resolveSession(context("ses_oc_1", directory)))
      .rejects.toBeInstanceOf(MuseRecoveryChoiceRequiredError);
    await manager.close();
  });

  test("sessionManager.abandonDeletesThePoisonedEntry", async () => {
    const root = tempRoot();
    const { manager, calls } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.recordTurnAccepted?.("cmd-1", "turn-1");
    await first.release?.();

    const abandoned = await manager.consumeRecoveryDecision("ses_oc_1", "A", directory);
    expect(abandoned).toMatchObject({ abandoned: true });
    expect(abandoned?.text).toContain("Re-prompt");
    const stored = await new SessionRegistry({ stateDirectory: root })
      .get("ses_oc_1", workspaceFingerprint(directory));
    expect(stored).toBeUndefined();
    // A follow-up resolves cleanly and starts a fresh session.
    const second = await manager.resolveSession(context("ses_oc_1", directory));
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(2);
    await manager.close();
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
