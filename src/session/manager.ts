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
  MuseInvalidConfigError,
  MuseRecoveryChoiceRequiredError,
  MuseUnsupportedInputError,
  MuseUnsupportedRequestError,
  RegistryWorkspaceMismatchError,
  WorkspaceBusyError,
} from "../errors.js";
import { SessionRegistry } from "./registry.js";
import type { PendingCommandRecord, SessionRegistryEntry, TurnAnchor } from "./registry.js";
import type { ToolBackend } from "../msp/tool-backend.js";
import { sweepHostConfigs, userMuseConfigDir, writeHostConfig } from "../msp/host-config.js";
import { LoopbackMcpServer, type ParkedCall } from "../mcp/loopback.js";
import type { LockLease, WorkspaceLock } from "./workspace-lock.js";
import type { MuseTurnSession } from "../model/language-model.js";
import type { AgentContextResult } from "../model/agent-context.js";

export interface MuseSessionHost extends Pick<MspHost, "command" | "request" | "subscribe" | "mintCommandId" | "close" | "approvals" | "userInput"> {
  initializeResult: Record<string, unknown>;
}

/** Host configs older than this are crashed-process leftovers (Pi parity). */
const STALE_HOST_CONFIG_MS = 24 * 60 * 60 * 1000;

/**
 * Opencode backend (#37): session/start and session/resume carry the
 * loopback mcpServers config, which requires the sessionMcp grant. A
 * capabilityRequired rejection means the host cannot run this backend —
 * fail with a clear error naming the grant, never fall back to Muse tools.
 * Without a loopback config (muse backend) every rejection passes through
 * untouched.
 */
function rethrowMissingSessionMcp(error: unknown, backendConfig: Record<string, unknown> | undefined): void {
  if (backendConfig && error instanceof MspCommandRejectedError && error.mspKind === "capabilityRequired") {
    throw new MuseInvalidConfigError(
      "The opencode tool backend requires the sessionMcp capability, but the Muse host did not grant it (session/start or session/resume was rejected as capabilityRequired). The muse backend is unaffected.",
    );
  }
}

export interface MuseSessionManagerOptions {
  stateDirectory?: string;
  registry: SessionRegistry;
  workspaceLock: WorkspaceLock;
  museBin?: string;
  /** Requested billing lane; defaults to "on" (matches the Muse TUI). */
  contributorMode?: ContributorMode;
  /** Tool backend; defaults to "muse" (vetted Shape B). "opencode" is explicit opt-in (#37). */
  toolBackend?: ToolBackend;
  createHost?(options: { museBin?: string; cwd: string; args: readonly string[]; env?: NodeJS.ProcessEnv; capabilities?: Parameters<MspHandshake["initialize"]>[0]["capabilities"] }): Promise<MuseSessionHost>;
  videoChunkBytes?: number;
  /** Worktree lifecycle seam (#34); defaults to git. */
  worktreeVcs?: WorktreeVcs;
}

interface ManagedBinding extends Omit<MuseTurnSession, "host"> {
  host: MuseSessionHost;
  workspaceFingerprint: string;
  museSessionId: string;
  toolBackend: ToolBackend;
  /** Opencode backend only: loopback MCP bridge serving OpenCode tools. */
  loopback?: LoopbackMcpServer;
  hostId: string;
  viewCursor?: string;
  transcriptFingerprints: string[];
  compactionFingerprints: string[];
  pendingCommands: Record<string, PendingCommandRecord>;
  turnAnchors: TurnAnchor[];
  /** Accepted but not yet completed turn: the anchor candidate. Cleared on unclean completion. */
  pendingAnchorTurnId?: string;
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
  private readonly toolBackend: ToolBackend;
  private readonly createHost: NonNullable<MuseSessionManagerOptions["createHost"]>;
  private readonly worktreeVcs: WorktreeVcs;
  private closed = false;

  constructor(private readonly options: MuseSessionManagerOptions) {
    this.contributorMode = options.contributorMode ?? "on";
    this.toolBackend = options.toolBackend ?? "muse";
    this.worktreeVcs = options.worktreeVcs ?? defaultWorktreeVcs;
    this.createHost = options.createHost ?? (async ({ museBin, cwd, args, env, capabilities }) => MspHost.start({
      museBin,
      cwd,
      args,
      env,
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
    options?: { verdictConsumed?: boolean; incomingFingerprints?: readonly string[] },
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
    // A live turn absorbs the follow-up via turn/steer — including while an
    // approval is parked, since the verdict flow still owns approval
    // decisions. Assigned (not conditionally set) so a completed turn clears
    // a stale marker; the bridge steers at most once, then turns fresh.
    // Re-entry also hands the output stream over like a verdict join (epoch
    // bump plus lease handoff): both calls drain the same turn, the first
    // finisher detaches, the second releases.
    if (existingBinding) {
      existingBinding.steerExpectedTurnId = existingBinding.activeTurnId;
      // The epoch bump marks the takeover for verdict flows; the takeover
      // count itself is committed lazily by the bridge at steer-accept time,
      // so a resolve that never drains cannot leak the lease.
      if (existingBinding.activeTurnId !== undefined) {
        existingBinding.streamEpoch = (existingBinding.streamEpoch ?? 0) + 1;
      }
    }

    // Same-session re-entry reuses the live binding's lease: a follow-up
    // while a turn runs must not fail the workspace busy guard. A fresh
    // acquire (and its release on failure below) happens only when no live
    // lease exists.
    const liveLease = existingBinding?.lease;
    const lease = liveLease ?? await this.options.workspaceLock.acquire(fingerprint, context.sessionID);
    const freshLease = liveLease === undefined;
    let host: MuseSessionHost | undefined;
    let ownedLoopback: LoopbackMcpServer | undefined;
    try {
      const stored = await this.options.registry.get(context.sessionID, fingerprint);
      const poisoned = stored !== undefined
        && (Object.keys(stored.pendingCommands).length > 0 || stored.activeTurnId !== undefined);
      if (stored && poisoned && !this.turnLifecycleOwns(stored, existingBinding)) {
        // Nothing alive owns the stuck turn (fresh process after a crash,
        // or a failed non-turn command like setModel): fail closed with the
        // choice attached. A live turn — accepted, or a turn/start awaiting
        // acceptance — belongs to the turn lifecycle (abort/retract,
        // timeouts, server-side queuing), never to recovery.
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
          if (freshLease) {
            existingBinding.lease = undefined;
            await lease.release();
          }
          throw error;
        }
        return existingBinding;
      }

      // Opencode backend (#37): isolate the serve child behind a private,
      // bridge-authored XDG config and serve OpenCode tools over a loopback
      // MCP bridge advertised on session start/resume. Parked loopback calls
      // fail fast until the turn flow wires execution through OpenCode core.
      let backendEnv: NodeJS.ProcessEnv | undefined;
      let loopback: LoopbackMcpServer | undefined;
      if (this.toolBackend === "opencode") {
        const stateDirectory = this.options.stateDirectory ?? SessionRegistry.resolveStateDirectory();
        sweepHostConfigs(stateDirectory, STALE_HOST_CONFIG_MS, Date.now(), new Set(this.bindings.keys()));
        const hostXdg = writeHostConfig(stateDirectory, context.sessionID, { authSourceDir: userMuseConfigDir() });
        backendEnv = { ...process.env, XDG_CONFIG_HOME: hostXdg };
        // A live same-process binding returns before this point, so a fresh
        // loopback is always needed here; restarts resume with the new URL.
        // Parked calls wait for the turn flow to surface them as native
        // OpenCode tool calls; the loopback timeout bounds a lost consumer.
        const created = new LoopbackMcpServer({ sessionKey: context.sessionID, tools: [] });
        await created.listen();
        loopback = created;
        ownedLoopback = created;
      }

      host = await this.createHost({
        museBin: this.options.museBin,
        cwd: canonicalDirectory,
        args: baseServeArgs(stored?.providerId ?? selected.providerId, this.contributorMode),
        env: backendEnv,
        capabilities: {
          userInputDialogs: false,
          experimentalApi: true,
          // Opencode backend (#37): advertising loopback mcpServers on
          // session/start requires the sessionMcp grant; without it the CLI
          // rejects the start as capabilityRequired. The muse backend keeps
          // its exact previous handshake.
          ...(this.toolBackend === "opencode" ? { requestedCapabilities: ["sessionMcp"] } : {}),
        },
      });
      const durability = host.initializeResult.sessionDurability;
      if (stored && durability === "ephemeral") throw new MuseRecoveryChoiceRequiredError();

      const experimentalWorktrees = host.initializeResult.experimentalApi === true;
      let museSessionId: string | undefined;
      let viewCursor: string | undefined;
      let replayAfterCursor: string | undefined;
      let adoptedAnchors: TurnAnchor[] | undefined;
      let adoptedPrevious: readonly string[] | undefined;
      let worktree: ManagedWorktree | undefined;
      // First-turn bridge context (approval instruction first, then any
      // worktree notices). Only new bindings get notices; re-resolves reuse
      // the binding's list, and resumed sessions with history skip them.
      const sessionNotices: string[] = [APPROVAL_BRIDGE_INSTRUCTION];
      let adoptedFork = false;
      if (!stored) {
        // No mapping for this OpenCode session: a transcript that uniquely
        // matches a known session's retained history is an OpenCode fork, so
        // adopt it by forking that Muse session instead of starting blank.
        // The fork gets no anchors: pre-fork turn ids do not survive a fork
        // (offline probe), so turns re-anchor as they complete on the fork.
        const incoming = options?.incomingFingerprints;
        const adoption = await this.findForkAdoption(fingerprint, incoming);
        if (adoption && incoming) {
          const forked = await this.forkViaHost(host, adoption.sourceMuseSessionId, adoption.cutTurnId);
          if (forked) {
            museSessionId = forked.sessionId;
            viewCursor = forked.viewCursor;
            adoptedAnchors = [];
            adoptedPrevious = [...incoming];
            adoptedFork = true;
          }
        }
      }
      const backendConfig = this.toolBackend === "opencode" && loopback ? this.backendSessionConfig(loopback) : undefined;
      if (!adoptedFork && stored && durability !== "ephemeral") {
        const resumed = await host.command("session/resume", {
          commandId: host.mintCommandId(),
          sessionId: stored.museSessionId,
          ...(stored.viewCursor ? { cursor: stored.viewCursor } : {}),
          // A restarted bridge brings a fresh loopback URL; the resumed
          // session must point at the live one.
          ...(backendConfig ? { config: backendConfig } : {}),
        }).catch((error: unknown) => {
          rethrowMissingSessionMcp(error, backendConfig);
          throw error;
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
      } else if (!adoptedFork) {
        const startParams = {
          commandId: host.mintCommandId(),
          workspaceRoot: canonicalDirectory,
          providerId: selected.providerId,
          modelId: selected.modelId,
          // Muse backend (#22): Muse must ask through approval/request so
          // OpenCode stays in the loop; the host default would let
          // side-effectful actions through silently. Opencode backend (#37):
          // Muse never asks — OpenCode's native permission evaluation is the
          // only fence, so a second Muse-side prompt would double-ask at
          // best and hang at worst.
          approvalMode: this.toolBackend === "opencode" ? "allowAll" : "onRequest",
          ...(backendConfig ? { config: backendConfig } : {}),
        };
        let start: Record<string, unknown>;
        let worktreeAttempted = false;
        let worktreeFallback = false;
        if (experimentalWorktrees) {
          worktreeAttempted = true;
          try {
            start = await host.command("session/start", { ...startParams, worktree: { mode: "create" } });
          } catch (error) {
            // A missing sessionMcp grant fails fast with a clear error: the
            // retry below drops only the worktree parameter, so it would hit
            // the same rejection.
            rethrowMissingSessionMcp(error, backendConfig);
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
          start = await host.command("session/start", startParams).catch((error: unknown) => {
            rethrowMissingSessionMcp(error, backendConfig);
            throw error;
          });
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

      // Adoption, resume, and start each assign the Muse session above; an
      // unassigned id here means none of the paths produced one.
      if (museSessionId === undefined) throw new MuseRecoveryChoiceRequiredError();
      const initialSelection = stored
        ? { providerId: stored.providerId ?? selected.providerId, modelId: stored.modelId ?? selected.modelId, profileId: stored.profileId ?? null }
        : { providerId: selected.providerId, modelId: selected.modelId, profileId: null };
      const sessionContext = this.contextBySession.get(context.sessionID);
      if (this.toolBackend === "opencode") {
        sessionNotices.push("Opencode tools backend: this Muse session runs host-provided tools through the loopback bridge; OpenCode permissions apply.");
      }
      const binding: ManagedBinding = {
        host,
        sessionId: museSessionId,
        museSessionId,
        toolBackend: this.toolBackend,
        loopback,
        hostId: randomUUID(),
        workspaceFingerprint: fingerprint,
        viewCursor,
        replayAfterCursor,
        worktree,
        sessionNotices,
        emittedApprovalPrompts: new Set<string>(),
        streamEpoch: 0,
        currentSelection: initialSelection,
        previousTranscriptFingerprints: adoptedPrevious ? [...adoptedPrevious] : stored?.transcriptFingerprints ?? [],
        transcriptFingerprints: adoptedPrevious ? [...adoptedPrevious] : stored?.transcriptFingerprints ?? [],
        compactionFingerprints: stored?.compactionFingerprints ?? [],
        pendingCommands: stored?.pendingCommands ?? {},
        turnAnchors: adoptedAnchors ? [...adoptedAnchors] : stored?.turnAnchors ? [...stored.turnAnchors] : [],
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
          const previousAnchor = binding.pendingAnchorTurnId;
          binding.activeTurnId = turnId;
          binding.pendingAnchorTurnId = turnId;
          try { await persist(); } catch (error) {
            binding.activeTurnId = previous;
            binding.pendingAnchorTurnId = previousAnchor;
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
          const previousAnchor = binding.pendingAnchorTurnId;
          binding.activeTurnId = undefined;
          binding.replayAfterCursor = undefined;
          binding.pendingCommands = {};
          binding.joinParkedTurnId = undefined;
          binding.handoffTakeovers = 0;
          binding.emittedApprovalPrompts = new Set<string>();
          if (_terminal !== "completed") binding.pendingAnchorTurnId = undefined;
          try { await persist(); } catch (error) {
            binding.activeTurnId = previousActive;
            binding.pendingCommands = previousPending;
            binding.pendingAnchorTurnId = previousAnchor;
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
        takeParkedToolCall() {
          return binding.loopback?.takeParked();
        },
        watchParkedToolCall() {
          const loopback = binding.loopback;
          if (!loopback) {
            let cancel = () => {};
            const wait = new Promise<ParkedCall>(() => {});
            return { wait, cancel };
          }
          return loopback.watchParked();
        },
        hasParkedToolCall(toolCallId) {
          return binding.loopback?.has(toolCallId) ?? false;
        },
        resolveParkedToolCall(toolCallId, resultText) {
          const loopback = binding.loopback;
          if (!loopback) return "unknown";
          if (loopback.resolve(toolCallId, { text: resultText })) return "resolved";
          return loopback.wasResolved(toolCallId) ? "already-resolved" : "unknown";
        },
        syncLoopbackTools(tools) {
          const loopback = binding.loopback;
          if (!loopback) return;
          const converted: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
          for (const tool of tools) {
            if (typeof tool !== "object" || tool === null) continue;
            const candidate = tool as { name?: unknown; description?: unknown; inputSchema?: unknown };
            if (typeof candidate.name !== "string" || candidate.name.length === 0) continue;
            if (Array.isArray(candidate.inputSchema)) continue;
            converted.push({
              name: candidate.name,
              description: typeof candidate.description === "string" ? candidate.description : "",
              inputSchema: typeof candidate.inputSchema === "object" && candidate.inputSchema !== null
                ? candidate.inputSchema as Record<string, unknown>
                : { type: "object" },
            });
          }
          // Forwarded tools always convert: an empty result means the bridge
          // and core disagree about the tool shape, and running tool-less
          // would silently drop the user's request.
          if (tools.length > 0 && converted.length === 0) throw new MuseUnsupportedInputError("tools");
          loopback.setTools(converted);
        },
        async commitTranscriptFingerprints(fingerprints) {
          const previousTranscript = binding.transcriptFingerprints;
          const previousFingerprints = binding.previousTranscriptFingerprints;
          const previousCompactions = binding.compactionFingerprints;
          const previousAnchors = binding.turnAnchors;
          const anchorTurnId = binding.pendingAnchorTurnId;
          binding.transcriptFingerprints = [...fingerprints];
          binding.previousTranscriptFingerprints = [...fingerprints];
          binding.compactionFingerprints = [];
          if (anchorTurnId !== undefined) {
            binding.pendingAnchorTurnId = undefined;
            const isExtension = previousTranscript.length <= fingerprints.length
              && previousTranscript.every((value, index) => fingerprints[index] === value);
            if (isExtension) {
              const last = binding.turnAnchors[binding.turnAnchors.length - 1];
              binding.turnAnchors = last?.sequenceLength === fingerprints.length
                ? [...binding.turnAnchors.slice(0, -1), { sequenceLength: fingerprints.length, turnId: anchorTurnId }]
                : [...binding.turnAnchors, { sequenceLength: fingerprints.length, turnId: anchorTurnId }];
            } else {
              // Compaction-style history replacement: earlier turn ids no
              // longer address this history, so re-anchor from this turn.
              binding.turnAnchors = [{ sequenceLength: fingerprints.length, turnId: anchorTurnId }];
            }
          }
          try { await persist(); } catch (error) {
            binding.transcriptFingerprints = [...previousTranscript];
            binding.previousTranscriptFingerprints = [...previousFingerprints];
            binding.compactionFingerprints = [...previousCompactions];
            binding.turnAnchors = previousAnchors;
            binding.pendingAnchorTurnId = anchorTurnId;
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
      if (ownedLoopback) await ownedLoopback.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Session extension for the opencode backend (#37): the loopback MCP
   * bridge advertised to this session. `mode: "required"` fails session
   * setup fast when the bridge is unreachable instead of running tool-less.
   */
  private backendSessionConfig(loopback: LoopbackMcpServer): Record<string, unknown> {
    return {
      mcpServers: {
        // Underscores, not hyphens: the CLI derives MCP tool names as
        // mcp__<key>/... and a hyphenated key lists no tools (offline probe:
        // hyphen key + hyphen glob fails the turn as configError).
        "opencode_loopback": {
          transport: "streamableHttp",
          url: loopback.url,
          headers: { Authorization: `Bearer ${loopback.token}` },
          mode: "required",
        },
      },
    };
  }

  /**
   * Fork the mapped Muse session at the retained transcript boundary (#20).
   * Only an explicit, uniquely anchored cut point forks: an active turn, any
   * pending command other than a matching earlier fork attempt, a retained
   * length outside the stored history, or anything but exactly one anchor at
   * that length reports `{ forked: false }` and sends nothing. The orphaned
   * pre-rewind session is left to the user's Muse home: MSP has no delete.
   */
  async forkSessionAtBoundary(openCodeSessionId: string, retainedLength: number): Promise<{ forked: true } | { forked: false }> {
    const binding = this.bindings.get(openCodeSessionId);
    if (!binding) return { forked: false };
    if (binding.activeTurnId !== undefined) return { forked: false };
    const unrelatedPending = Object.values(binding.pendingCommands).some((command) => command.method !== "session/fork");
    if (unrelatedPending) return { forked: false };
    if (retainedLength < 1 || retainedLength >= binding.transcriptFingerprints.length) return { forked: false };
    const cuts = binding.turnAnchors.filter((anchor) => anchor.sequenceLength === retainedLength);
    if (cuts.length !== 1) return { forked: false };
    const forked = await this.forkViaBinding(binding, cuts[0]!.turnId);
    if (!forked) return { forked: false };
    // Forks do not preserve source turn ids (offline probe: fork-of-fork at
    // a pre-fork id fails InvalidCut), so every carried anchor would address
    // a dead turn. Drop them: turns completed after the fork re-anchor, and
    // rewinding into pre-fork history stays a fail-closed fresh-session error.
    const previous = {
      sessionId: binding.sessionId,
      museSessionId: binding.museSessionId,
      viewCursor: binding.viewCursor,
      replayAfterCursor: binding.replayAfterCursor,
      joinParkedTurnId: binding.joinParkedTurnId,
      handoffTakeovers: binding.handoffTakeovers,
      emittedApprovalPrompts: binding.emittedApprovalPrompts,
      turnAnchors: binding.turnAnchors,
      transcriptFingerprints: binding.transcriptFingerprints,
      previousTranscriptFingerprints: binding.previousTranscriptFingerprints,
    };
    const retained = previous.transcriptFingerprints.slice(0, retainedLength);
    binding.sessionId = forked.sessionId;
    binding.museSessionId = forked.sessionId;
    binding.viewCursor = forked.viewCursor;
    binding.replayAfterCursor = undefined;
    binding.joinParkedTurnId = undefined;
    binding.handoffTakeovers = 0;
    binding.emittedApprovalPrompts = new Set<string>();
    binding.turnAnchors = [];
    binding.transcriptFingerprints = retained;
    binding.previousTranscriptFingerprints = [...retained];
    try {
      await this.persistBinding(openCodeSessionId, binding);
    } catch (error) {
      binding.sessionId = previous.sessionId;
      binding.museSessionId = previous.museSessionId;
      binding.viewCursor = previous.viewCursor;
      binding.replayAfterCursor = previous.replayAfterCursor;
      binding.joinParkedTurnId = previous.joinParkedTurnId;
      binding.handoffTakeovers = previous.handoffTakeovers;
      binding.emittedApprovalPrompts = previous.emittedApprovalPrompts;
      binding.turnAnchors = previous.turnAnchors;
      binding.transcriptFingerprints = previous.transcriptFingerprints;
      binding.previousTranscriptFingerprints = previous.previousTranscriptFingerprints;
      throw error;
    }
    return { forked: true };
  }

  private async forkViaBinding(binding: ManagedBinding, cutTurnId: string | undefined):
    Promise<{ sessionId: string; viewCursor?: string } | undefined> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ method: "session/fork", sessionId: binding.museSessionId, cutTurnId: cutTurnId ?? null }))
      .digest("hex");
    const pending = Object.entries(binding.pendingCommands)
      .find(([, command]) => command.method === "session/fork" && command.fingerprint === fingerprint);
    const commandId = pending?.[0] ?? binding.host.mintCommandId();
    // MSP treats id+payload as the idempotency key: a retry after an
    // ambiguous failure replays the same command and the server answers
    // with the original fork instead of branching a second one.
    if (!pending) await binding.recordPendingCommand?.({ commandId, method: "session/fork", fingerprint });
    let result: Record<string, unknown>;
    try {
      const params: { commandId: string; sessionId: string; cutPoint?: { lastTurnId: string } } =
        { commandId, sessionId: binding.museSessionId };
      if (cutTurnId !== undefined) params.cutPoint = { lastTurnId: cutTurnId };
      result = await binding.host.command("session/fork", params) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const sessionId = sessionIdFrom(result);
    if (!sessionId) return undefined;
    try {
      await binding.clearPendingCommand?.(commandId);
    } catch {
      // The fork landed but the pending mark could not clear: a later
      // retry reuses the same command id and rejoins this fork.
      return undefined;
    }
    return { sessionId, viewCursor: cursorFrom(result) };
  }

  private async forkViaHost(host: MuseSessionHost, sourceMuseSessionId: string, cutTurnId: string | undefined):
    Promise<{ sessionId: string; viewCursor?: string } | undefined> {
    let result: Record<string, unknown>;
    try {
      const params: { commandId: string; sessionId: string; cutPoint?: { lastTurnId: string } } =
        { commandId: host.mintCommandId(), sessionId: sourceMuseSessionId };
      if (cutTurnId !== undefined) params.cutPoint = { lastTurnId: cutTurnId };
      result = await host.command("session/fork", params) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const sessionId = sessionIdFrom(result);
    if (!sessionId) return undefined;
    return { sessionId, viewCursor: cursorFrom(result) };
  }

  /**
   * OpenCode-fork adoption: a session with no stored mapping whose incoming
   * transcript uniquely matches one known session's retained history forks
   * that Muse session — a full copy at the tip, an explicit cut below it.
   * Anything else (no match, several matches, a mid-turn prefix with no
   * anchor) stays a fresh session; recovery-quarantined entries are never
   * listed, so the fresh path there is unchanged.
   */
  private async findForkAdoption(workspaceFingerprintValue: string, incoming: readonly string[] | undefined):
    Promise<{ sourceMuseSessionId: string; cutTurnId?: string } | undefined> {
    if (!incoming || incoming.length === 0) return undefined;
    const entries = await this.options.registry.list();
    const matches = entries.filter((entry) =>
      entry.workspaceFingerprint === workspaceFingerprintValue
      && entry.transcriptFingerprints.length >= incoming.length
      && incoming.every((value, index) => entry.transcriptFingerprints[index] === value));
    if (matches.length !== 1) return undefined;
    const source = matches[0]!;
    if (incoming.length === source.transcriptFingerprints.length) {
      return { sourceMuseSessionId: source.museSessionId };
    }
    const cuts = source.turnAnchors.filter((anchor) => anchor.sequenceLength === incoming.length);
    if (cuts.length !== 1) return undefined;
    return {
      sourceMuseSessionId: source.museSessionId,
      cutTurnId: cuts[0]!.turnId,
    };
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
    // Committed eagerly: a verdict join always drains, so the joiner is a
    // guaranteed extra finisher for the takeover count.
    binding.handoffTakeovers = (binding.handoffTakeovers ?? 0) + 1;
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
  ): Promise<{ text: string; settledLast: boolean; runMessageAsTurn?: boolean } | null> {
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
    const denied = this.verdictOutcome(
      binding,
      `Denied ${oldest.toolName ? `\`${oldest.toolName}\`` : "the request"} — no valid option was given. That request is closed; your message now runs as a fresh turn.`,
    );
    // A second mismatch is not a verdict to act on: the user is trying to
    // say something else. Run their message as a fresh turn instead of
    // eating it, so a reviving model can never trap the conversation.
    // (Only when nothing remains parked; otherwise the next round decides.)
    return denied.settledLast ? { ...denied, runMessageAsTurn: true as const } : denied;
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
    // A live binding means resolution decides: the entry may be a
    // slow-but-healthy in-flight turn (or the verdict flow's parked turn),
    // which the turn-lifecycle rule lets through, or a failed non-turn
    // command, which still fails closed. Recovery offers only on fresh
    // processes, where no binding can vouch for the stuck turn.
    if (this.bindings.has(openCodeSessionId)) return null;
    if (matchRecoveryDecision(text) !== true) {
      return { text: this.recoveryRefusalText(block), abandoned: false };
    }
    await this.options.registry.deleteEntry(openCodeSessionId, fingerprint);
    return {
      text: `Abandoned the stuck ${block.method} turn — the Muse session link was dropped. Re-prompt to try again. (If the stuck turn actually ran elsewhere, its effects still apply.)`,
      abandoned: true,
    };
  }

  /**
   * Whether the stuck entry belongs to a live turn lifecycle rather than a
   * crash: an accepted turn, or a turn/start awaiting acceptance that the
   * server may still run, queue, or deduplicate. Only then may resolution
   * proceed past the poisoned entry.
   */
  private turnLifecycleOwns(
    stored: SessionRegistryEntry,
    existingBinding: ManagedBinding | undefined,
  ): boolean {
    if (!existingBinding) return false;
    if (stored.activeTurnId !== undefined) return true;
    return Object.values(stored.pendingCommands).some((command) => command.method === "turn/start");
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
    // Withdraw only the join that never attached; accepted steers keep
    // their own accounting.
    binding.handoffTakeovers = Math.max(0, (binding.handoffTakeovers ?? 0) - 1);
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
        await binding.loopback?.close().catch(() => {});
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
      turnAnchors: binding.turnAnchors,
    });
  }
}
