import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { MspHandshake } from "@muse-code/sdk";
import type { RequestContext } from "../types.js";
import { MspHost } from "../msp/host.js";
import { baseServeArgs, type ContributorMode } from "../msp/contributor.js";
import {
  APPROVAL_BRIDGE_INSTRUCTION,
  matchConversationalChoice,
  renderConversationalApprovalPrompt,
  type ConversationalChoice,
} from "../msp/approvals.js";
import {
  describeRecoveryBlock,
  matchRecoveryDecision,
  renderRecoveryPrompt,
  type RecoveryBlock,
} from "./recovery.js";
import {
  isMultiSelectQuestion,
  matchConversationalChoice as matchUserInputChoice,
  presentableQuestion,
  renderConversationalQuestionPrompt,
  type UserInputAnswer,
  type UserInputQuestion,
} from "../msp/user-input.js";
import type { ApprovalExchange } from "../msp/approvals.js";
import type { ApprovalResponse } from "../model/prompt.js";
import {
  composeWorktreeNotices,
  countSharedSessions,
  defaultWorktreeVcs,
  findOwnWorktree,
  purgeWorktreeIfEmpty,
  type ManagedWorktree,
  type WorktreeVcs,
} from "../msp/worktree.js";
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

export interface MuseSessionHost extends Pick<MspHost, "command" | "request" | "subscribe" | "mintCommandId" | "close" | "approvals" | "userInput"> {
  initializeResult: Record<string, unknown>;
}

export interface MuseSessionManagerOptions {
  stateDirectory?: string;
  registry: SessionRegistry;
  workspaceLock: WorkspaceLock;
  museBin?: string;
  /** Requested billing lane; defaults to "on" (matches the Muse TUI). */
  contributorMode?: ContributorMode;
  createHost?(options: { museBin?: string; cwd: string; args: readonly string[]; capabilities?: Parameters<MspHandshake["initialize"]>[0]["capabilities"] }): Promise<MuseSessionHost>;
  videoChunkBytes?: number;
  /** Worktree lifecycle seam (#34); defaults to git. */
  worktreeVcs?: WorktreeVcs;
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
  private readonly contextBySession = new Map<string, AgentContextResult>();
  private readonly contributorMode: ContributorMode;
  private readonly createHost: NonNullable<MuseSessionManagerOptions["createHost"]>;
  private readonly worktreeVcs: WorktreeVcs;
  private closed = false;

  constructor(private readonly options: MuseSessionManagerOptions) {
    this.contributorMode = options.contributorMode ?? "on";
    this.worktreeVcs = options.worktreeVcs ?? defaultWorktreeVcs;
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

  async resolveSession(
    context: RequestContext,
    options?: { verdictConsumed?: boolean },
  ): Promise<MuseTurnSession> {
    if (this.closed) throw new MuseUnsupportedRequestError("plugin-closed");
    if (context.kind !== "primary") throw new MuseUnsupportedRequestError(context.kind);
    const canonicalDirectory = canonicalWorkspacePath(context.directory);
    const fingerprint = workspaceFingerprint(canonicalDirectory);
    const selected = modelSelection(context);
    const existingBinding = this.bindings.get(context.sessionID);
    if (existingBinding && existingBinding.workspaceFingerprint !== fingerprint) {
      throw new RegistryWorkspaceMismatchError();
    }

    if (existingBinding && options?.verdictConsumed === true) {
      // The verdict was already consumed against this binding's parked
      // requests: reattach without touching the workspace lease the parked
      // turn still holds. The parked-turn guard below stays for genuinely
      // new turns, which never set this flag.
      return existingBinding;
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
        const block = describeRecoveryBlock(stored);
        throw new MuseRecoveryChoiceRequiredError(
          block ? this.recoveryRefusalText(block) : "stuck turn with no recorded detail",
        );
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
        args: baseServeArgs(stored?.providerId ?? selected.providerId, this.contributorMode),
        capabilities: { userInputDialogs: false, experimentalApi: true },
      });
      const durability = host.initializeResult.sessionDurability;
      if (stored && durability === "ephemeral") throw new MuseRecoveryChoiceRequiredError();

      const experimentalWorktrees = host.initializeResult.experimentalApi === true;
      let museSessionId: string;
      let viewCursor: string | undefined;
      let replayAfterCursor: string | undefined;
      let worktree: ManagedWorktree | undefined;
      // First-turn bridge context (approval instruction first, then any
      // worktree notices). Only new bindings get notices; re-resolves reuse
      // the binding's list, and resumed sessions with history skip them.
      const sessionNotices: string[] = [APPROVAL_BRIDGE_INSTRUCTION];
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
        if (experimentalWorktrees) {
          // Best-effort rediscovery: a restarted bridge reattaches the label
          // but never fails the resume when the surface is unavailable.
          try {
            const listed = await host.request("worktree/list", { workspaceRoot: canonicalDirectory });
            const own = findOwnWorktree(listed, museSessionId);
            if (own?.path) {
              worktree = { path: own.path, branch: own.branch };
              sessionNotices.push(...composeWorktreeNotices({ workspaceRoot: canonicalDirectory, worktree: own }));
            }
          } catch {
            // The session runs on; the label stays absent.
          }
        }
      } else {
        const startParams = {
          commandId: host.mintCommandId(),
          workspaceRoot: canonicalDirectory,
          providerId: selected.providerId,
          modelId: selected.modelId,
          // #22: Muse must ask through approval/request so OpenCode stays in
          // the loop; the host default would let side-effectful actions
          // through silently.
          approvalMode: "onRequest",
        };
        let start: Record<string, unknown>;
        let worktreeAttempted = false;
        let worktreeFallback = false;
        if (experimentalWorktrees) {
          worktreeAttempted = true;
          try {
            start = await host.command("session/start", { ...startParams, worktree: { mode: "create" } });
          } catch (error) {
            // A rejected worktree-bearing start is retried once without the
            // worktree parameter: non-git checkouts, Subversion/Mercurial and
            // plain directories, and untrusted workspaces all surface under
            // server-chosen rejection kinds we cannot enumerate. Only an
            // explicit rejection retries (a timeout/transport failure must
            // never risk creating the session twice). When the plain start
            // succeeds the worktree parameter was the problem: fall back to
            // the single-writer lock with notice. Its own failure propagates.
            if (!(error instanceof MspCommandRejectedError)) throw error;
            // A changed payload must never reuse the rejected command's id
            // (the host treats id+payload as the idempotency key).
            start = await host.command("session/start", { ...startParams, commandId: host.mintCommandId() });
            worktreeFallback = true;
            sessionNotices.push(
              ...composeWorktreeNotices({
                workspaceRoot: canonicalDirectory,
                fallbackReason: error.mspKind,
              }),
            );
          }
        } else {
          start = await host.command("session/start", startParams);
        }
        const startedSessionId = sessionIdFrom(start);
        if (!startedSessionId) throw new MuseRecoveryChoiceRequiredError();
        museSessionId = startedSessionId;
        viewCursor = cursorFrom(start);
        if (worktreeAttempted && !worktreeFallback) {
          // Verify-and-bind: resolve the managed path and the sharing
          // picture. A failed verify leaves a working session whose
          // worktree can neither be labeled nor purged.
          try {
            const listed = await host.request("worktree/list", { workspaceRoot: canonicalDirectory });
            const own = findOwnWorktree(listed, museSessionId);
            const sharedOthers = countSharedSessions(listed, canonicalDirectory, museSessionId);
            const baseSha = await this.worktreeVcs.baseCommit(canonicalDirectory);
            if (own?.path) worktree = { path: own.path, branch: own.branch, baseSha };
            sessionNotices.push(
              ...composeWorktreeNotices({
                workspaceRoot: canonicalDirectory,
                worktree: own,
                sharedOthers,
              }),
            );
          } catch {
            sessionNotices.push(
              `[Muse session workspace: worktree verification unavailable; merging back through normal source control.]`,
            );
          }
        }
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
        worktree,
        sessionNotices,
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
   * Route approval answers into the parked MSP approval round trips — both
   * the legacy structured funnel and conversational verdicts carrying an
   * exact offered choice (validated again on `approval/decide`). Returns the
   * approval ids that matched a still-parked approval. When a matched
   * approval belongs to the binding's active turn, the next `resolveSession`
   * call attaches to that turn instead of starting a new one.
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
      const settled = response.choiceId !== undefined
        ? binding.host.approvals.settleChoice(response.approvalId, response.choiceId)
        : binding.host.approvals.settle(response.approvalId, response.approved);
      if (!settled) continue;
      matched.push(response.approvalId);
      // Arm the join only for verdicts that belong to the still-active turn;
      // a verdict for a dead turn is delivered but never joined.
      if (joinTurnId === undefined && parkedTurnId === binding.activeTurnId) joinTurnId = parkedTurnId;
    }
    if (joinTurnId !== undefined) {
      this.armJoin(binding, joinTurnId);
    }
    return matched;
  }

  /**
   * Arm the join only for verdicts that belong to the still-active turn;
   * a verdict for a dead turn is delivered but never joined.
   */
  private armJoin(binding: ManagedBinding, turnId: string | undefined): boolean {
    if (turnId === undefined || turnId !== binding.activeTurnId) return false;
    binding.joinParkedTurnId = turnId;
    binding.streamEpoch = (binding.streamEpoch ?? 0) + 1;
    binding.handoffLeaseToJoiner = true;
    return true;
  }

  /**
   * Interpret a user message as a verdict for the oldest pending approval.
   * Returns null when nothing pends (normal turn flow). Otherwise the text
   * carries the outcome: a recorded echo, a re-ask, or a denial. `settledLast`
   * is true only when no approvals remain, in which case the caller joins the
   * parked turn; anything else ends synthetically, and the next message
   * decides the next queued approval. Ambiguity is re-asked once, then
   * denied via the narrowest reject choice — never approved.
   */
  async consumeConversationalVerdict(
    openCodeSessionId: string,
    text: string,
  ): Promise<{ text: string; settledLast: boolean } | null> {
    const binding = this.bindings.get(openCodeSessionId);
    if (!binding) return null;
    const pending = binding.host.approvals.describePending();
    if (pending.length === 0) return null;
    const oldest = pending[0]!;
    if (oldest.choices.length === 0) {
      // Nothing presentable: fail closed exactly like the stream notice.
      await this.settleApprovalResponses(openCodeSessionId, [{ approvalId: oldest.approvalId, approved: false }]);
      return this.verdictOutcome(
        binding,
        `Denied ${oldest.toolName ? `\`${oldest.toolName}\`` : "the request"} — Muse offered no usable options. Re-prompt to try again.`,
      );
    }
    const matched = matchConversationalChoice(oldest.choices, text);
    if (matched) {
      await this.settleApprovalResponses(openCodeSessionId, [{
        approvalId: oldest.approvalId,
        approved: true,
        choiceId: matched.choiceId,
      }]);
      return this.verdictOutcome(binding, `Recorded: ${matched.label} (${matched.scope}).`);
    }
    const attempts = binding.host.approvals.noteVerdictAttempt(oldest.approvalId);
    if (attempts === 0) {
      return {
        text: renderConversationalApprovalPrompt({
          toolName: oldest.toolName,
          choices: oldest.choices,
          attempt: 1,
          received: text,
        }),
        settledLast: false,
      };
    }
    await this.settleApprovalResponses(openCodeSessionId, [{ approvalId: oldest.approvalId, approved: false }]);
    return this.verdictOutcome(
      binding,
      `Denied ${oldest.toolName ? `\`${oldest.toolName}\`` : "the request"} — no valid option was given. Re-prompt to try again.`,
    );
  }

  private verdictOutcome(
    binding: ManagedBinding,
    recorded: string,
  ): { text: string; settledLast: boolean } {
    const remaining = binding.host.approvals.describePending();
    if (remaining.length === 0) return { text: `${recorded} Resuming…`, settledLast: true };
    const next = remaining[0]!;
    return {
      text: `${recorded}\n\n${renderConversationalApprovalPrompt({
        toolName: next.toolName,
        choices: next.choices,
        attempt: 0,
      })}`,
      settledLast: false,
    };
  }

  /**
   * Fingerprints the bridge already forwarded for one OpenCode session.
   * The verdict peek reads these before resolving so it only consumes
   * fresh user text; undefined when no binding exists yet (the peek then
   * falls back to the final user turn, and finds nothing pending anyway).
   */
  previousTranscriptFingerprints(openCodeSessionId: string): readonly string[] | undefined {
    return this.bindings.get(openCodeSessionId)?.previousTranscriptFingerprints;
  }

  /**
   * Interpret a user message as the recovery decision for a poisoned
   * registry entry. Returns null when the entry is clean or missing, or
   * when a live binding still holds parked approvals/questions — the
   * verdict flow owns that case, not recovery. Abandon deletes the stuck
   * entry and its Muse linkage and drops any idle in-memory binding, so
   * the next resolve starts fresh; anything else leaves the entry
   * untouched and re-presents the choice via the enriched error. Only an
   * exact abandon form clears — ambiguity never abandons.
   */
  async consumeRecoveryDecision(
    openCodeSessionId: string,
    text: string,
    directory: string,
  ): Promise<{ text: string; abandoned: boolean } | null> {
    const fingerprint = workspaceFingerprint(canonicalWorkspacePath(directory));
    const stored = await this.options.registry.get(openCodeSessionId, fingerprint);
    if (!stored) return null;
    const block = describeRecoveryBlock(stored);
    if (!block) return null;
    const binding = this.bindings.get(openCodeSessionId);
    if (binding && (binding.host.approvals.pendingApprovalIds().length > 0
      || binding.host.userInput.describePending().length > 0)) {
      return null;
    }
    if (matchRecoveryDecision(text) !== true) {
      return { text: this.recoveryRefusalText(block), abandoned: false };
    }
    await this.options.registry.deleteEntry(openCodeSessionId, fingerprint);
    if (binding) {
      this.bindings.delete(openCodeSessionId);
      try {
        await binding.host.close?.();
      } catch {
        // Best-effort orphan cleanup; the entry is already gone, so the
        // next resolve starts fresh regardless.
      }
      try {
        await binding.lease?.release();
      } catch {
        // A leaked lease from the dead turn must not block the restart.
      }
    }
    return {
      text: `Abandoned the stuck ${block.method} turn — the Muse session link was dropped. Re-prompt to try again. (If the stuck turn actually ran elsewhere, its effects still apply.)`,
      abandoned: true,
    };
  }

  /** Layer-1 facts for the recovery error: method, age, and Muse session. */
  private recoveryDetails(block: RecoveryBlock): string {
    return `${block.method} from ${block.ageMs}ms ago on Muse session ${block.museSessionId}; reply A to abandon and restart fresh`;
  }

  /** Full refusal body: facts plus the choice, so the error itself is the offer. */
  private recoveryRefusalText(block: RecoveryBlock): string {
    return `${this.recoveryDetails(block)}\n\n${renderRecoveryPrompt(block)}`;
  }

  /** Latest offered choices for one pending approval, for prompt rendering. */
  describePendingApproval(
    openCodeSessionId: string,
    approvalId: string,
    requirementId: string,
  ): { choices: ConversationalChoice[]; toolName?: string } | undefined {
    const binding = this.bindings.get(openCodeSessionId);
    const found = binding?.host.approvals.describePending().find((entry) =>
      entry.approvalId === approvalId && entry.requirementId === requirementId
    );
    if (!found) return undefined;
    return {
      choices: found.choices,
      ...(found.toolName ? { toolName: found.toolName } : {}),
    };
  }

  /**
   * Interpret a user message as an answer for the oldest pending userInput
   * question. Returns null when nothing pends (normal turn flow). Otherwise
   * the text carries the outcome: a recorded echo (plus the next question
   * when more remain), a re-ask, or a cancellation. `settledLast` is true
   * only when no requests remain, in which case the caller joins the parked
   * turn; anything else ends synthetically. Ambiguity is re-asked once,
   * then cancelled — never fabricated. Multi-select and option-less
   * questions cancel immediately with a reason.
   */
  async consumeConversationalAnswer(
    openCodeSessionId: string,
    text: string,
  ): Promise<{ text: string; settledLast: boolean } | null> {
    const binding = this.bindings.get(openCodeSessionId);
    if (!binding) return null;
    const pending = binding.host.userInput.describePending();
    if (pending.length === 0) return null;
    const oldest = pending[0]!;
    const current = oldest.questions.find((question) => !oldest.answeredQuestionIds.includes(question.id));
    if (!current) {
      // Every question already answered but the request never settled:
      // settle with the accumulated answers rather than asking again.
      return this.finishUserInputAnswers(binding, oldest.userInputId, oldest.answers, "Recorded.");
    }
    if (presentableQuestion(current) === null) {
      // Nothing the lettered prompt can collect: cancel with a reason.
      const reason = current.options.length === 0
        ? `"${current.header}" offered no usable options`
        : `"${current.header}" needs multiple selections, which cannot be collected here`;
      this.settleUserInputCancelled(binding, oldest.userInputId);
      return this.userInputOutcome(binding, `Cancelled ${oldest.toolName ? `\`${oldest.toolName}\`` : "the request"} — ${reason}.`);
    }
    const matched = matchUserInputChoice(current.options, text);
    if (matched) {
      const appended = binding.host.userInput.appendAnswer(oldest.userInputId, {
        questionId: current.id,
        selectedLabel: matched.label,
      });
      if (appended && appended.remaining === 0) {
        return this.finishUserInputAnswers(binding, oldest.userInputId, appended.answers, `Recorded: ${matched.label}.`);
      }
      const next = oldest.questions.find((question) =>
        !oldest.answeredQuestionIds.includes(question.id) && question.id !== current.id
      ) ?? oldest.questions.find((question) => question.id !== current.id);
      return {
        text: `Recorded: ${matched.label}.\n\n${renderConversationalQuestionPrompt({ question: next!, attempt: 0 })}`,
        settledLast: false,
      };
    }
    const attempts = binding.host.userInput.noteVerdictAttempt(oldest.userInputId);
    if (attempts === 0) {
      return {
        text: renderConversationalQuestionPrompt({ question: current, attempt: 1, received: text }),
        settledLast: false,
      };
    }
    this.settleUserInputCancelled(binding, oldest.userInputId);
    return this.userInputOutcome(
      binding,
      `Cancelled ${oldest.toolName ? `\`${oldest.toolName}\`` : "the request"} — no valid option was given.`,
    );
  }

  private finishUserInputAnswers(
    binding: ManagedBinding,
    userInputId: string,
    answers: UserInputAnswer[],
    recorded: string,
  ): { text: string; settledLast: boolean } {
    const pendingTurnId = binding.host.userInput.describePending()
      .find((entry) => entry.userInputId === userInputId)?.turnId;
    if (binding.host.userInput.settleAnswer(userInputId, answers)) {
      this.armJoin(binding, pendingTurnId);
    }
    return this.userInputOutcome(binding, recorded);
  }

  private settleUserInputCancelled(binding: ManagedBinding, userInputId: string): void {
    const pendingTurnId = binding.host.userInput.describePending()
      .find((entry) => entry.userInputId === userInputId)?.turnId;
    if (binding.host.userInput.settleCancelled(userInputId)) {
      this.armJoin(binding, pendingTurnId);
    }
  }

  private userInputOutcome(
    binding: ManagedBinding,
    recorded: string,
  ): { text: string; settledLast: boolean } {
    const remaining = binding.host.userInput.describePending();
    if (remaining.length === 0) return { text: `${recorded} Resuming…`, settledLast: true };
    const next = this.oldestUnansweredQuestion(remaining[0]!);
    return {
      text: `${recorded}\n\n${next
        ? renderConversationalQuestionPrompt({ question: next, attempt: 0 })
        : "The next question cannot be presented and will be cancelled on your reply."}`,
      settledLast: false,
    };
  }

  private oldestUnansweredQuestion(
    entry: { questions: UserInputQuestion[]; answeredQuestionIds: string[] },
  ): UserInputQuestion | undefined {
    return entry.questions.find((question) => !entry.answeredQuestionIds.includes(question.id));
  }

  /** Oldest still-unanswered presentable question, for prompt rendering. */
  describeCurrentUserInputQuestion(
    openCodeSessionId: string,
  ): { question: UserInputQuestion; toolName?: string } | undefined {
    const binding = this.bindings.get(openCodeSessionId);
    const oldest = binding?.host.userInput.describePending()[0];
    if (!oldest) return undefined;
    const current = this.oldestUnansweredQuestion(oldest);
    const presented = current ? presentableQuestion(current) : null;
    if (!presented) return undefined;
    return {
      question: presented,
      ...(oldest.toolName ? { toolName: oldest.toolName } : {}),
    };
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
    const bindings = [...this.bindings.values()];
    this.bindings.clear();
    // Purge-only-provably-empty (#34): dirty worktrees are left for the
    // human to merge; purge never fails the shutdown.
    await Promise.all(bindings.map((binding) => purgeWorktreeIfEmpty(this.worktreeVcs, binding.worktree)));
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
