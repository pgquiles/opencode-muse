import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { MspHandshake } from "@muse-code/sdk";
import type { RequestContext } from "../types.js";
import { MspHost } from "../msp/host.js";
import type { ApprovalExchange } from "../msp/approvals.js";
import type { ApprovalResponse } from "../model/prompt.js";
import {
  MspCommandRejectedError,
  MuseApprovalPendingError,
  MuseRecoveryChoiceRequiredError,
  MuseUnsupportedRequestError,
  RegistryWorkspaceMismatchError,
  WorkspaceBusyError,
} from "../errors.js";
import type { PendingCommandRecord, SessionRegistry, SessionRegistryEntry } from "./registry.js";
import type { LockLease, WorkspaceLock } from "./workspace-lock.js";
import type { MuseTurnSession } from "../model/language-model.js";
import type { AgentContextResult } from "../model/agent-context.js";

export interface MuseSessionHost extends Pick<MspHost, "command" | "request" | "subscribe" | "mintCommandId" | "close" | "approvals"> {
  initializeResult: Record<string, unknown>;
}

export interface MuseSessionManagerOptions {
  stateDirectory?: string;
  registry: SessionRegistry;
  workspaceLock: WorkspaceLock;
  museBin?: string;
  createHost?(options: { museBin?: string; cwd: string; args: readonly string[]; capabilities?: Parameters<MspHandshake["initialize"]>[0]["capabilities"] }): Promise<MuseSessionHost>;
  videoChunkBytes?: number;
}

interface ManagedBinding extends Omit<MuseTurnSession, "host"> {
  host: MuseSessionHost;
  workspaceFingerprint: string;
  museSessionId: string;
  hostId: string;
  viewCursor?: string;
  transcriptFingerprints: string[];
  compactionFingerprints: string[];
  pendingCommands: Record<string, PendingCommandRecord>;
  activeTurnId?: string;
  /** Set when the next call must attach to this parked Muse turn. */
  joinParkedTurnId?: string;
  currentSelection: { providerId: string; modelId: string; profileId: string | null };
  lease?: LockLease;
}

function canonicalWorkspacePath(directory: string): string {
  const absolute = resolve(directory);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

export function workspaceFingerprint(directory: string): string {
  return createHash("sha256").update(canonicalWorkspacePath(directory)).digest("hex");
}

function sessionIdFrom(result: Record<string, unknown>): string | undefined {
  const session = result.session as { sessionId?: unknown } | undefined;
  return typeof session?.sessionId === "string" ? session.sessionId : undefined;
}

function cursorFrom(result: Record<string, unknown>): string | undefined {
  return typeof result.viewCursor === "string" ? result.viewCursor : undefined;
}

function modelSelection(context: RequestContext): { providerId: string; modelId: string; profileId: string | null } {
  return {
    providerId: context.museSelection.providerId,
    modelId: context.museSelection.modelId,
    profileId: context.museSelection.profileId,
  };
}

function selectionMatches(
  entry: Pick<SessionRegistryEntry, "providerId" | "modelId" | "profileId">,
  selected: { providerId: string; modelId: string; profileId: string | null },
): boolean {
  return entry.providerId === selected.providerId
    && entry.modelId === selected.modelId
    && (entry.profileId ?? null) === selected.profileId;
}

export class MuseSessionManager {
  private readonly bindings = new Map<string, ManagedBinding>();
  private readonly effortPins = new Map<string, string>();
  private readonly contextBySession = new Map<string, AgentContextResult>();
  private readonly createHost: NonNullable<MuseSessionManagerOptions["createHost"]>;
  private closed = false;

  constructor(private readonly options: MuseSessionManagerOptions) {
    this.createHost = options.createHost ?? (async ({ museBin, cwd, args, capabilities }) => MspHost.start({
      museBin,
      cwd,
      args,
      capabilities,
      startupTimeoutMs: 20_000,
      commandTimeoutMs: 30_000,
      requestTimeoutMs: 20_000,
    }) as Promise<MuseSessionHost>);
  }

  setContextForSession(openCodeSessionId: string, context: AgentContextResult): void {
    this.contextBySession.set(openCodeSessionId, {
      supported: context.supported,
      fragments: context.fragments.map((fragment) => ({ ...fragment })),
    });
    const binding = this.bindings.get(openCodeSessionId);
    if (binding) {
      binding.contextAllowlist = context.supported ? context.fragments.map((fragment) => ({ ...fragment })) : [];
      binding.contextError = context.supported ? undefined : "agent-instructions-unrepresentable";
    }
  }

  async resolveSession(context: RequestContext): Promise<MuseTurnSession> {
    if (this.closed) throw new MuseUnsupportedRequestError("plugin-closed");
    if (context.kind !== "primary") throw new MuseUnsupportedRequestError(context.kind);
    const canonicalDirectory = canonicalWorkspacePath(context.directory);
    const fingerprint = workspaceFingerprint(canonicalDirectory);
    const selected = modelSelection(context);
    const existingBinding = this.bindings.get(context.sessionID);
    if (existingBinding && existingBinding.workspaceFingerprint !== fingerprint) {
      throw new RegistryWorkspaceMismatchError();
    }

    if (existingBinding?.joinParkedTurnId !== undefined) {
      // The settled verdicts matched a parked turn: attach to it instead of
      // starting a new one. The parked call still holds the lease; the
      // handoff flag tells it to detach without releasing.
      return existingBinding;
    }
    if (existingBinding && existingBinding.host.approvals.pendingApprovalIds().length > 0) {
      throw new MuseApprovalPendingError();
    }

    const lease = await this.options.workspaceLock.acquire(fingerprint, context.sessionID);
    let host: MuseSessionHost | undefined;
    try {
      const stored = await this.options.registry.get(context.sessionID, fingerprint);
      if (stored && (Object.keys(stored.pendingCommands).length > 0 || stored.activeTurnId !== undefined)) {
        throw new MuseRecoveryChoiceRequiredError();
      }

      if (existingBinding) {
        existingBinding.lease = lease;
        try {
          await this.applySelectionIfChanged(existingBinding, selected);
          await this.persistBinding(context.sessionID, existingBinding);
        } catch (error) {
          existingBinding.lease = undefined;
          await lease.release();
          throw error;
        }
        return existingBinding;
      }

      host = await this.createHost({
        museBin: this.options.museBin,
        cwd: canonicalDirectory,
        args: ["serve", "--provider", stored?.providerId ?? selected.providerId],
        capabilities: { userInputDialogs: false },
      });
      const durability = host.initializeResult.sessionDurability;
      if (stored && durability === "ephemeral") throw new MuseRecoveryChoiceRequiredError();

      let museSessionId: string;
      let viewCursor: string | undefined;
      let replayAfterCursor: string | undefined;
      if (stored && durability !== "ephemeral") {
        const resumed = await host.command("session/resume", {
          commandId: host.mintCommandId(),
          sessionId: stored.museSessionId,
          ...(stored.viewCursor ? { cursor: stored.viewCursor } : {}),
        });
        const resumedSession = resumed.session as { activeTurnId?: unknown } | undefined;
        if (!resumedSession || !Object.hasOwn(resumedSession, "activeTurnId") || resumedSession.activeTurnId !== null) {
          throw new MuseRecoveryChoiceRequiredError();
        }
        museSessionId = sessionIdFrom(resumed) ?? stored.museSessionId;
        viewCursor = cursorFrom(resumed);
        // session/resume attaches at its returned head; avoid a redundant
        // view/subscribe at that same cursor. Task 12 owns older-cursor replay.
      } else {
        const start = await host.command("session/start", {
          commandId: host.mintCommandId(),
          workspaceRoot: canonicalDirectory,
          providerId: selected.providerId,
          modelId: selected.modelId,
          // #22: Muse must ask through approval/request so OpenCode stays in
          // the loop; the host default would let side-effectful actions
          // through silently.
          approvalMode: "onRequest",
        });
        const startedSessionId = sessionIdFrom(start);
        if (!startedSessionId) throw new MuseRecoveryChoiceRequiredError();
        museSessionId = startedSessionId;
        viewCursor = cursorFrom(start);
      }

      const initialSelection = stored
        ? { providerId: stored.providerId ?? selected.providerId, modelId: stored.modelId ?? selected.modelId, profileId: stored.profileId ?? null }
        : { providerId: selected.providerId, modelId: selected.modelId, profileId: null };
      const sessionContext = this.contextBySession.get(context.sessionID);
      const binding: ManagedBinding = {
        host,
        sessionId: museSessionId,
        museSessionId,
        hostId: randomUUID(),
        workspaceFingerprint: fingerprint,
        viewCursor,
        replayAfterCursor,
        emittedApprovalPrompts: new Set<string>(),
        streamEpoch: 0,
        currentSelection: initialSelection,
        previousTranscriptFingerprints: stored?.transcriptFingerprints ?? [],
        transcriptFingerprints: stored?.transcriptFingerprints ?? [],
        compactionFingerprints: stored?.compactionFingerprints ?? [],
        pendingCommands: stored?.pendingCommands ?? {},
        contextAllowlist: sessionContext?.supported ? sessionContext.fragments.map((fragment) => ({ ...fragment })) : [],
        contextError: sessionContext?.supported ? undefined : "agent-instructions-unrepresentable",
        lease,
        async recordPendingCommand(input) {
          binding.pendingCommands[input.commandId] = { method: input.method, fingerprint: input.fingerprint };
          await managerOptions.registry.recordPendingCommand(context.sessionID, fingerprint, input);
        },
        async clearPendingCommand(commandId) {
          await managerOptions.registry.clearPendingCommand(context.sessionID, fingerprint, commandId);
          delete binding.pendingCommands[commandId];
        },
        async recordTurnAccepted(_commandId, turnId) {
          const previous = binding.activeTurnId;
          binding.activeTurnId = turnId;
          try { await persist(); } catch (error) {
            binding.activeTurnId = previous;
            throw error;
          }
        },
        async updateCursor(cursor) {
          const previous = binding.viewCursor;
          binding.viewCursor = cursor;
          try {
            await managerOptions.registry.updateCursor(context.sessionID, fingerprint, cursor);
          } catch {
            // Retaining the older durable cursor is safe: the next resume will
            // replay this suffix. Do not abandon an active turn because a
            // per-event cursor write temporarily failed.
            binding.viewCursor = previous;
          }
        },
        async recordTurnCompleted(_turnId, _terminal) {
          const previousActive = binding.activeTurnId;
          const previousPending = binding.pendingCommands;
          binding.activeTurnId = undefined;
          binding.replayAfterCursor = undefined;
          binding.pendingCommands = {};
          binding.joinParkedTurnId = undefined;
          binding.handoffLeaseToJoiner = false;
          binding.emittedApprovalPrompts = new Set<string>();
          try { await persist(); } catch (error) {
            binding.activeTurnId = previousActive;
            binding.pendingCommands = previousPending;
            throw error;
          }
        },
        async cancelParkedApprovals() {
          for (const approvalId of binding.host.approvals.pendingApprovalIds()) {
            binding.host.approvals.settle(approvalId, false);
          }
        },
        async release() {
          const currentLease = binding.lease;
          binding.lease = undefined;
          await currentLease?.release();
        },
        async commitTranscriptFingerprints(fingerprints) {
          const previousTranscript = binding.transcriptFingerprints;
          const previousFingerprints = binding.previousTranscriptFingerprints;
          const previousCompactions = binding.compactionFingerprints;
          binding.transcriptFingerprints = [...fingerprints];
          binding.previousTranscriptFingerprints = [...fingerprints];
          binding.compactionFingerprints = [];
          try { await persist(); } catch (error) {
            binding.transcriptFingerprints = [...previousTranscript];
            binding.previousTranscriptFingerprints = [...previousFingerprints];
            binding.compactionFingerprints = [...previousCompactions];
            throw error;
          }
        },
      };
      const managerOptions = this.options;
      const persist = async () => {
        await this.persistBinding(context.sessionID, binding);
      };

      this.bindingSessionIDs.set(binding, context.sessionID);
      this.bindings.set(context.sessionID, binding);
      await persist();
      await this.applySelectionIfChanged(binding, selected, stored);
      await persist();
      return binding;
    } catch (error) {
      await lease.release();
      if (host) await host.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Route OpenCode's answers to previously emitted `tool-approval-request`
   * chunks into the parked MSP approval round trips. Returns the approval
   * ids that matched a still-parked approval. When a matched approval
   * belongs to the binding's active turn, the next `resolveSession` call
   * attaches to that turn instead of starting a new one.
   */
  async settleApprovalResponses(openCodeSessionId: string, responses: ApprovalResponse[]): Promise<string[]> {
    const binding = this.bindings.get(openCodeSessionId);
    if (!binding) return [];
    const matched: string[] = [];
    let joinTurnId: string | undefined;
    for (const response of responses) {
      // Capture the parked turn before settle clears the pending entry.
      const parkedTurnId = binding.host.approvals.pendingApprovalTurnId(response.approvalId);
      if (parkedTurnId === undefined) continue;
      if (!binding.host.approvals.settle(response.approvalId, response.approved)) continue;
      matched.push(response.approvalId);
      // Arm the join only for verdicts that belong to the still-active turn;
      // a verdict for a dead turn is delivered but never joined.
      if (joinTurnId === undefined && parkedTurnId === binding.activeTurnId) joinTurnId = parkedTurnId;
    }
    if (joinTurnId !== undefined) {
      binding.joinParkedTurnId = joinTurnId;
      binding.streamEpoch = (binding.streamEpoch ?? 0) + 1;
      binding.handoffLeaseToJoiner = true;
    }
    return matched;
  }

  /** Pin a reasoning effort for the session; explicit per-turn choices still win. */
  setEffortPin(openCodeSessionId: string, variant: string): void {
    this.effortPins.set(openCodeSessionId, variant);
  }

  /** The session's pinned effort, if the /effort command set one. */
  effortPinForSession(openCodeSessionId: string): string | undefined {
    return this.effortPins.get(openCodeSessionId);
  }

  /** True while the binding's active turn is parked awaiting a verdict. */
  hasParkedApprovals(openCodeSessionId: string): boolean {
    const binding = this.bindings.get(openCodeSessionId);
    return binding !== undefined
      && binding.activeTurnId !== undefined
      && binding.host.approvals.pendingApprovalIds().length > 0;
  }

  /** Drop a join that can no longer attach (diverged prompt, failed start). */
  disarmParkedJoin(openCodeSessionId: string): void {
    const binding = this.bindings.get(openCodeSessionId);
    if (!binding) return;
    binding.joinParkedTurnId = undefined;
    binding.handoffLeaseToJoiner = false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.effortPins.clear();
    const bindings = [...this.bindings.values()];
    this.bindings.clear();
    await Promise.all(bindings.map(async (binding) => {
      try {
        await binding.host.close?.();
      } catch {
        // The diagnostic may include CLI stderr; shutdown must still release
        // the local lease once the owned process has been asked to stop.
      } finally {
        await binding.release?.().catch(() => {});
      }
    }));
  }

  async recordCompactionCandidate(openCodeSessionId: string, fingerprint: string): Promise<void> {
    const binding = this.bindings.get(openCodeSessionId);
    if (binding) {
      const lease = await this.options.workspaceLock.acquire(binding.workspaceFingerprint, openCodeSessionId);
      try {
        binding.compactionFingerprints = [fingerprint];
        await this.persistBinding(openCodeSessionId, binding);
      } finally {
        await lease.release();
      }
      return;
    }
    const stored = await this.options.registry.getForOpenCodeSession(openCodeSessionId);
    if (!stored) return;
    const lease = await this.options.workspaceLock.acquire(stored.workspaceFingerprint, openCodeSessionId);
    try {
      await this.options.registry.recordCompactionCandidate(openCodeSessionId, fingerprint);
    } finally {
      await lease.release();
    }
  }

  private async applySelectionIfChanged(
    binding: ManagedBinding,
    selected: { providerId: string; modelId: string; profileId: string | null },
    stored?: Pick<SessionRegistryEntry, "providerId" | "modelId" | "profileId">,
  ): Promise<void> {
    const currentMatches = stored
      ? selectionMatches(stored, selected)
      : binding.currentSelection.providerId === selected.providerId
        && binding.currentSelection.modelId === selected.modelId
        && binding.currentSelection.profileId === selected.profileId;
    if (currentMatches) {
      binding.currentSelection = selected;
      return;
    }
    const commandId = binding.host.mintCommandId();
    const method = "session/setModel";
    const params = {
      commandId,
      sessionId: binding.sessionId,
      model: selected,
    };
    const commandFingerprint = createHash("sha256").update(JSON.stringify({ method, params })).digest("hex");
    const openCodeSessionId = this.openCodeSessionIdFor(binding);
    const pending = { method, fingerprint: commandFingerprint };
    binding.pendingCommands[commandId] = pending;
    try {
      await this.options.registry.recordPendingCommand(openCodeSessionId, binding.workspaceFingerprint, {
        commandId,
        ...pending,
      });
    } catch (error) {
      delete binding.pendingCommands[commandId];
      throw error;
    }
    try {
      await binding.host.command(method, params);
    } catch (error) {
      if (error instanceof MspCommandRejectedError) {
        await this.options.registry.clearPendingCommand(openCodeSessionId, binding.workspaceFingerprint, commandId);
        delete binding.pendingCommands[commandId];
      }
      throw error;
    }
    await this.options.registry.clearPendingCommand(openCodeSessionId, binding.workspaceFingerprint, commandId);
    delete binding.pendingCommands[commandId];
    binding.currentSelection = selected;
    await this.persistBinding(openCodeSessionId, binding);
  }

  private readonly bindingSessionIDs = new WeakMap<ManagedBinding, string>();

  private openCodeSessionIdFor(binding: ManagedBinding): string {
    const sessionId = this.bindingSessionIDs.get(binding);
    if (!sessionId) throw new MuseRecoveryChoiceRequiredError();
    return sessionId;
  }

  private async persistBinding(openCodeSessionId: string, binding: ManagedBinding): Promise<void> {
    await this.options.registry.put({
      openCodeSessionId,
      museSessionId: binding.museSessionId,
      hostId: binding.hostId,
      workspaceFingerprint: binding.workspaceFingerprint,
      providerId: binding.currentSelection.providerId,
      ...(binding.currentSelection.profileId !== null ? { profileId: binding.currentSelection.profileId } : {}),
      modelId: binding.currentSelection.modelId,
      ...(binding.viewCursor ? { viewCursor: binding.viewCursor } : {}),
      ...(binding.activeTurnId ? { activeTurnId: binding.activeTurnId } : {}),
      transcriptFingerprints: binding.transcriptFingerprints,
      compactionFingerprints: binding.compactionFingerprints,
      pendingCommands: binding.pendingCommands,
    });
  }
}
