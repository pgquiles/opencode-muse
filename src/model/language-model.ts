import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { createHash } from "node:crypto";
import { MspCommandRejectedError, MuseBridgeError, MuseRecoveryChoiceRequiredError, MuseTranscriptDivergedError, MuseUnsupportedInputError, MuseUnsupportedRequestError, MspProtocolError, MspTransportError } from "../errors.js";
import type { MspNotification } from "../msp/client.js";
import type { ToolBackend } from "../msp/tool-backend.js";
import type { ParkedCall } from "../mcp/loopback.js";
import { notificationCursorKey } from "../msp/notification.js";
import { MUSE_CONTEXT_HEADERS, readRequestContext } from "./context.js";
import { classifyMetaRequest, makeCompactionDigest, makeLocalTitle, type MetaRequestClass } from "./meta.js";
import { promptContainsCompactionFingerprint } from "../session/fingerprint.js";
import {
  extractApprovalResponses,
  extractToolResults,
  extractTurnInput,
  fingerprintVisibleTranscript,
  latestUserText,
  validateModelOptions,
  type ApprovalResponse,
  type ContextFragment,
  type ExtractedTurnPart,
  type ExtractTurnInputResult,
} from "./prompt.js";
import { MuseStreamMapper, resultUsage } from "./stream.js";
import type { MuseModelSelection, RequestContext } from "../types.js";
import type { UserInputQuestion as UserInputQuestionShape } from "../msp/user-input.js";
import type { TranscribeAudio } from "../msp/transcribe.js";
import { pendingFirstTurnNotices, resolveStagingRoot } from "../msp/worktree.js";
import type { StagePdfOutcome } from "../msp/pdf.js";

export interface MuseTurnHost {
  mintCommandId(): string;
  command<TResult extends object = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> & { commandId: string },
  ): Promise<TResult>;
  request<TResult extends object = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<TResult>;
  subscribe(sessionId: string, after?: string, signal?: AbortSignal): AsyncIterable<MspNotification>;
  close?(): Promise<void>;
}

export interface MuseTurnSession {
  host: MuseTurnHost;
  sessionId: string;
  previousTranscriptFingerprints: readonly string[];
  compactionFingerprints?: readonly string[];
  commitTranscriptFingerprints?(fingerprints: readonly string[]): Promise<void>;
  contextAllowlist: readonly ContextFragment[];
  contextError?: string;
  replayAfterCursor?: string;
  /** Latest observed view cursor; attach subscribes from here. */
  viewCursor?: string;
  currentSelection?: Pick<MuseModelSelection, "providerId" | "modelId" | "profileId">;
  recordPendingCommand?(input: { commandId: string; method: string; fingerprint: string }): Promise<void>;
  clearPendingCommand?(commandId: string): Promise<void>;
  recordTurnAccepted?(commandId: string, turnId: string): Promise<void>;
  /** The manager clears this when the turn reaches a terminal state. */
  activeTurnId?: string;
  /** Tool backend that owns tool execution for this session; absent means "muse". */
  toolBackend?: ToolBackend;
  /** Attach to the live turn instead of starting one (tool-result re-invocation, #37). Consumed at run entry. */
  attachToActiveTurn?: boolean;
  /** Next queued parked loopback call, if any (opencode backend). */
  takeParkedToolCall?(): ParkedCall | undefined;
  /** Wait for the next parked loopback call without removing it. */
  watchParkedToolCall?(): { wait: Promise<ParkedCall>; cancel(): void };
  /** Whether the loopback bridge still holds this call parked. */
  hasParkedToolCall?(toolCallId: string): boolean;
  /** Resolve a parked loopback call with the OpenCode tool result. */
  resolveParkedToolCall?(toolCallId: string, resultText: string): "resolved" | "already-resolved" | "unknown";
  /** Publish OpenCode's forwarded tools on the loopback bridge. */
  syncLoopbackTools?(tools: readonly unknown[]): void;
  updateCursor?(cursor: string): Promise<void>;
  recordTurnCompleted?(turnId: string, terminal: string, usage?: Record<string, unknown>): Promise<void>;
  release?(): Promise<void>;
  /** Session workspace override (#34); PDF staging follows the session onto its worktree. Unverified path stays undefined. */
  worktree?: { path?: string; branch?: string };
  /** Bridge-authored first-turn labels; emitted once, never replayed. */
  sessionNotices?: string[];
  /** Cross-turn chunk dedup for approval prompts; shared per OpenCode session. */
  emittedApprovalPrompts?: Set<string>;
  /** Set by the session manager when this call must attach to a parked turn. */
  joinParkedTurnId?: string;
  /**
   * Set by the session manager when this call must steer fresh input into
   * the live Muse turn instead of starting a new one. A refused steer falls
   * back to turn/start exactly once — never a second steer.
   */
  steerExpectedTurnId?: string;
  /** Bumped by the manager when a newer call takes over this session's output. */
  streamEpoch?: number;
  /**
   * Committed takeovers sharing the turn (verdict joins plus accepted
   * steers). Finishers decrement; the last finisher releases the lease, so
   * exactly one release runs no matter how many calls drain the turn.
   */
  handoffTakeovers?: number;
  /** Settle every still-pending approval verdict as denied (cancel path). */
  cancelParkedApprovals?(): Promise<void> | void;
}


export interface MuseLanguageRuntime {
  selectionIndex: ReadonlyMap<string, MuseModelSelection>;
  resolveSession(context: RequestContext, options?: { verdictConsumed?: boolean; incomingFingerprints?: readonly string[] }): Promise<MuseTurnSession>;
  /**
   * Fork the mapped Muse session at a retained transcript boundary (#20).
   * Reports `{ forked: false }` — and sends nothing — when the cut is not a
   * unique clean-turn anchor. Absent preserves the fail-closed divergence
   * error without attempting a fork.
   */
  forkSessionAtBoundary?(sessionID: string, retainedLength: number): Promise<{ forked: true } | { forked: false }>;
  videoChunkBytes?: number;
  settleApprovalResponses?(sessionID: string, responses: ApprovalResponse[]): Promise<string[]>;
  /**
   * Interpret a message as the recovery decision for a poisoned registry
   * entry. Returns null when the entry is clean (normal turn flow).
   * Abandon deletes the stuck entry; anything else leaves it and the
   * caller surfaces the enriched error carrying the choice.
   */
  consumeRecoveryDecision?(sessionID: string, text: string, directory: string): Promise<{
    text: string;
    abandoned: boolean;
  } | null>;
  /**
   * Fingerprints the bridge has already forwarded for this OpenCode
   * session. Lets the verdict peek slice the prompt to fresh user text
   * before resolving (and its workspace lease). Absent behaves as no
   * history: the peek falls back to the final user turn.
   */
  previousTranscriptFingerprints?(sessionID: string): readonly string[] | undefined;
  hasParkedApprovals?(sessionID: string): boolean | Promise<boolean>;
  disarmParkedJoin?(sessionID: string): void;
  consumeConversationalVerdict?(sessionID: string, text: string): Promise<{ text: string; settledLast: boolean; runMessageAsTurn?: boolean } | null>;
  describePendingApproval?(sessionID: string, approvalId: string, requirementId: string): { choices: Array<{ choiceId: string; label: string; scope: string }>; toolName?: string } | undefined;
  consumeConversationalAnswer?(sessionID: string, text: string): Promise<{ text: string; settledLast: boolean } | null>;
  describeCurrentUserInputQuestion?(sessionID: string): { question: UserInputQuestionShape; toolName?: string } | undefined;
  /** Audio attachment transcription (#32); absent preserves the unsupported-media rejection. */
  transcribeAudioClip?: TranscribeAudio;
  /**
   * PDF workspace staging (#33): bound to the requesting workspace
   * directory. Absent preserves the unsupported-media rejection.
   */
  stagePdfAttachment?: (directory: string, bytes: Uint8Array) => Promise<StagePdfOutcome>;
}

export interface MuseTurnExecution {
  turnId: string;
  commandId: string;
  disposition: string;
  events: AsyncIterable<MspNotification>;
  cancel(): Promise<void>;
}

/** Verdict text is the concatenated user text, if any; media alone never decides. */
function userTextOf(parts: ExtractedTurnPart[]): string {
  return parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Bridge prompt rendering to the stream mapper for one OpenCode session. */
function describeApprovals(runtime: MuseLanguageRuntime, sessionID: string) {
  return (approvalId: string, requirementId: string) =>
    runtime.describePendingApproval?.(sessionID, approvalId, requirementId);
}

/** Bridge question rendering to the stream mapper for one OpenCode session. */
function describeUserInputQuestion(runtime: MuseLanguageRuntime, sessionID: string) {
  return (_userInputId: string) =>
    runtime.describeCurrentUserInputQuestion?.(sessionID);
}

/** A parked loopback call as a bridge notification for the stream mapper. */
function syntheticParkedNotification(
  session: MuseTurnSession,
  turnId: string | undefined,
  parked: ParkedCall,
): MspNotification {
  return {
    jsonrpc: "2.0",
    method: "bridge/tool-parked",
    params: {
      sessionId: session.sessionId,
      turnId,
      mcpCallId: parked.callId,
      toolName: parked.toolName,
      args: parked.args,
    },
  };
}

/** Length of the shared leading run: the retained transcript prefix after a rewind. */
function commonPrefixLength(previous: readonly string[], current: readonly string[]): number {
  let length = 0;
  while (length < previous.length && length < current.length && previous[length] === current[length]) length += 1;
  return length;
}

/** A verdict turn that needs no Muse turn: re-asks and queued prompts. */
function syntheticVerdictExecution(): MuseTurnExecution {
  return {
    turnId: "synthetic-verdict",
    commandId: "synthetic-verdict",
    disposition: "synthetic",
    events: (async function* (): AsyncGenerator<MspNotification> {})(),
    cancel: async () => {},
  };
}

const DEFAULT_VIDEO_CHUNK_BYTES = 6 * 1024 * 1024;

function fingerprint(method: string, params: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ method, params })).digest("hex");
}

function sameSelection(
  current: Pick<MuseModelSelection, "providerId" | "modelId" | "profileId"> | undefined,
  next: MuseModelSelection,
): boolean {
  return current !== undefined
    && current.providerId === next.providerId
    && current.modelId === next.modelId
    && (current.profileId ?? null) === next.profileId;
}

/**
 * Best-effort interrupt of a denied parked turn (same retracting
 * `turn/interrupt` the abort path uses). The turn never got past its
 * approval gate, so there is nothing gated to undo; if it already
 * completed, the fresh turn proceeds regardless.
 */
async function interruptParkedTurn(session: MuseTurnSession, turnId: string): Promise<void> {
  try {
    await submitCommand(session, "turn/interrupt", session.host.mintCommandId(), {
      sessionId: session.sessionId,
      turnId,
      retract: true,
    });
  } catch {
    // The parked turn may already have completed; never fail the user's
    // fresh turn because the cleanup raced it.
  }
}

async function submitCommand(
  session: MuseTurnSession,
  method: string,
  commandId: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestParams = { ...params, commandId };
  const requestFingerprint = fingerprint(method, requestParams);
  await session.recordPendingCommand?.({ commandId, method, fingerprint: requestFingerprint });
  try {
    const result = await session.host.command(method, requestParams);
    if (method !== "turn/start") {
      try {
        await session.clearPendingCommand?.(commandId);
      } catch {
        // The command ACK proves its outcome. Keep the conservative pending
        // fingerprint; the manager clears acknowledged transaction commands at
        // terminal completion. Never discard a successful model turn because a
        // registry cleanup write failed after the remote side effect.
      }
    }
    return result as Record<string, unknown>;
  } catch (error) {
    // A typed command rejection is an explicit refusal. Timeouts and transport
    // loss leave the pending fingerprint for recovery; never retry with a new ID.
    if (error instanceof MspCommandRejectedError) await session.clearPendingCommand?.(commandId);
    throw error;
  }
}

async function mapVideoParts(
  session: MuseTurnSession,
  parts: readonly ExtractedTurnPart[],
  signal?: AbortSignal,
  chunkBytes = DEFAULT_VIDEO_CHUNK_BYTES,
): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type !== "video") {
      result.push(part);
      continue;
    }
    if (signal?.aborted) throw new DOMException("Muse request aborted before turn start", "AbortError");
    const bytes = Buffer.from(part.base64Data, "base64");
    if (bytes.byteLength !== part.totalBytes || bytes.byteLength === 0) throw new MspProtocolError("media/upload");
    const uploadId = session.host.mintCommandId();
    const chunkCount = Math.ceil(bytes.byteLength / chunkBytes);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      if (signal?.aborted) throw new DOMException("Muse request aborted before turn start", "AbortError");
      const chunk = bytes.subarray(chunkIndex * chunkBytes, Math.min(bytes.byteLength, (chunkIndex + 1) * chunkBytes));
      const commandId = session.host.mintCommandId();
      const receipt = await submitCommand(session, "media/upload", commandId, {
        sessionId: session.sessionId,
        uploadId,
        mediaType: part.mediaType,
        chunkIndex,
        chunkCount,
        totalBytes: bytes.byteLength,
        chunkBase64: Buffer.from(chunk).toString("base64"),
      });
      if (receipt.uploadId !== uploadId) throw new MspProtocolError("media/upload");
    }
    result.push({ type: "video", uploadId });
  }
  return result;
}

function eventTurnId(notification: MspNotification, itemTurnIds: Map<string, string>): string | undefined {
  const params = notification.params ?? {};
  if (typeof params.turnId === "string") return params.turnId;
  const item = params.item as { itemId?: unknown; turnId?: unknown } | undefined;
  if (typeof item?.itemId === "string" && typeof item.turnId === "string") itemTurnIds.set(item.itemId, item.turnId);
  if (typeof item?.turnId === "string") return item.turnId;
  if (notification.method === "item/delta" && typeof params.itemId === "string") return itemTurnIds.get(params.itemId);
  return undefined;
}

async function* pageGapNotifications(
  host: MuseTurnHost,
  sessionId: string,
  gap: { after: string; next: string },
): AsyncIterable<MspNotification> {
  let cursor = gap.after;
  const requestedCursors = new Set<string>([gap.after]);
  const eventKeys = new Set<string>();
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const requestCursor = cursor;
    const page = await host.request<{ events?: unknown; nextCursor?: unknown }>("view/page", {
      sessionId,
      cursor,
      direction: "forward",
      limit: 1000,
    });
    if (!Array.isArray(page.events)) throw new MspProtocolError("view/page");
    let boundaryReached = false;
    for (const event of page.events) {
      if (typeof event !== "object" || event === null) throw new MspProtocolError("view/page");
      const record = event as { method?: unknown; params?: unknown };
      const params = record.params as Record<string, unknown> | undefined;
      if (typeof record.method !== "string" || !params || params.sessionId !== sessionId || typeof params.viewCursor !== "string") {
        throw new MspProtocolError("view/page");
      }
      const atBoundary = params.viewCursor === gap.next;
      if (atBoundary) boundaryReached = true;
      cursor = params.viewCursor;
      const notification = { jsonrpc: "2.0", method: record.method, params } as MspNotification;
      const key = notificationCursorKey(notification);
      if (key && eventKeys.has(key)) throw new MspProtocolError("view/page");
      if (key) eventKeys.add(key);
      yield notification;
    }
    if (boundaryReached) return;
    if (page.nextCursor === null || typeof page.nextCursor !== "string"
      || page.nextCursor === requestCursor || requestedCursors.has(page.nextCursor)) {
      throw new MspProtocolError("view/page");
    }
    requestedCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new MspProtocolError("view/page");
}

export async function runMuseTurn(
  context: RequestContext,
  input: readonly ExtractedTurnPart[],
  options: Pick<LanguageModelV3CallOptions, "abortSignal">,
  runtime: MuseLanguageRuntime,
  transcriptFingerprints?: readonly string[],
): Promise<MuseTurnExecution> {
  const session = await runtime.resolveSession(context);
  let terminalSeen = false;
  let accepted = false;
  let abortRequested = options.abortSignal?.aborted ?? false;
  let cancelPromise: Promise<void> | undefined;
  let turnId: string | undefined;
  let disposition: string | undefined;
  let subscription: AsyncIterator<MspNotification> | undefined;
  let firstNotification: Promise<IteratorResult<MspNotification>> | undefined;
  let subscriptionController: AbortController | undefined;
  const joinTurnId = session.joinParkedTurnId;
  session.joinParkedTurnId = undefined;
  const joinedTurn = joinTurnId !== undefined;
  // A tool-result re-invocation attaches; it never steers, even though the
  // manager arms a steer for every re-entry on a live turn (steering tool
  // results as follow-up input breaks the parked turn's input contract and
  // the fallback fresh turn has no valid input). The explicit attach flag
  // always wins over the generic steer arming.
  const attachTurn = session.attachToActiveTurn === true && !joinedTurn && session.activeTurnId !== undefined;
  session.attachToActiveTurn = undefined;
  const steerTarget = !joinedTurn && !attachTurn ? session.steerExpectedTurnId : undefined;
  session.steerExpectedTurnId = undefined;
  const steering = steerTarget !== undefined;
  // Opencode backend (#37): a tool-result re-invocation attaches to the live
  // turn. It consumes the handoff the emitting stream left for it, so the
  // completing drainer releases the lease exactly once.
  if (!joinedTurn && !steering && !attachTurn) {
    // A fresh turn resumes single ownership: stale takeover counts die here,
    // bounding any leak from a join that never drained to one extra turn.
    // Steers keep the re-entry count so all drainers share one lease release.
    session.handoffTakeovers = 0;
  } else if (attachTurn) {
    session.handoffTakeovers = Math.max(0, (session.handoffTakeovers ?? 0) - 1);
  }

  const cancel = () => {
    if (cancelPromise) return cancelPromise;
    // A superseded stream detaches silently: the joining call owns the turn now.
    if (!joinedTurn && !attachTurn && (session.handoffTakeovers ?? 0) > 0) return Promise.resolve();
    const denyParked = async () => {
      try {
        await session.cancelParkedApprovals?.();
      } catch {
        // The verdict latch settles denied on its own timeout; a cancel-time
        // settle failure must not mask the interrupt below.
      }
    };
    if (!turnId || !disposition) {
      abortRequested = true;
      return denyParked();
    }
    const unqueue = disposition === "queued";
    const method = unqueue ? "turn/unqueue" : "turn/interrupt";
    const params = unqueue
      ? { sessionId: session.sessionId, turnId }
      : { sessionId: session.sessionId, turnId, retract: true };
    cancelPromise = denyParked().then(() =>
      submitCommand(session, method, session.host.mintCommandId(), params).then(() => {}),
    );
    return cancelPromise;
  };
  const onAbort = () => { abortRequested = true; void cancel().catch(() => {}); };
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const turnCommandId = session.host.mintCommandId();
    if (joinedTurn) {
      // Attach to the parked turn: no turn/start, no model switch, no
      // acceptance record. The settled verdict already resumed it server-side.
      turnId = joinTurnId;
      disposition = "joined";
      subscriptionController = new AbortController();
      subscription = session.host.subscribe(session.sessionId, session.replayAfterCursor, subscriptionController.signal)[Symbol.asyncIterator]();
      firstNotification = subscription.next();
      accepted = true;
    } else if (attachTurn) {
      // Attach to the live turn with resolved tool results: no turn/start,
      // no model switch, no acceptance record. The parked loopback calls are
      // already resolved; this stream drains the turn's remaining events.
      turnId = session.activeTurnId!;
      disposition = "joined";
      subscriptionController = new AbortController();
      subscription = session.host.subscribe(session.sessionId, session.viewCursor, subscriptionController.signal)[Symbol.asyncIterator]();
      firstNotification = subscription.next();
      accepted = true;
    } else {
      if (!sameSelection(session.currentSelection, context.museSelection)) {
        const model: Record<string, unknown> = {
          providerId: context.museSelection.providerId,
          modelId: context.museSelection.modelId,
        };
        if (context.museSelection.profileId !== null) model.profileId = context.museSelection.profileId;
        await submitCommand(session, "session/setModel", session.host.mintCommandId(), {
          sessionId: session.sessionId,
          model,
        });
      }

      const inputParts = await mapVideoParts(session, input, options.abortSignal, runtime.videoChunkBytes);
      if (options.abortSignal?.aborted) throw new DOMException("Muse request aborted before turn start", "AbortError");
      subscriptionController = new AbortController();
      subscription = session.host.subscribe(session.sessionId, session.replayAfterCursor, subscriptionController.signal)[Symbol.asyncIterator]();
      firstNotification = subscription.next();
      // A follow-up on a live turn steers into it instead of queueing a new
      // one behind it. Aborting after a steer interrupts the whole turn: the
      // protocol offers no un-steer, so the queued-turn abort granularity is
      // intentionally not preserved here. A refused steer clears the re-entry
      // handoff (single ownership again) and falls through to a fresh turn.
      if (steering) {
        try {
          await submitCommand(session, "turn/steer", turnCommandId, {
            sessionId: session.sessionId,
            expectedTurnId: steerTarget,
            input: inputParts,
          });
          turnId = steerTarget;
          disposition = "steered";
          accepted = true;
          session.handoffTakeovers = (session.handoffTakeovers ?? 0) + 1;
        } catch (error) {
          if (!(error instanceof MspCommandRejectedError)) throw error;
          session.handoffTakeovers = 0;
        }
      }
      if (!accepted) {
        const startCommandId = session.host.mintCommandId();
        const params: Record<string, unknown> = {
          sessionId: session.sessionId,
          input: inputParts,
        };
        if (context.effort) params.reasoningEffort = context.effort;
        const ack = await submitCommand(session, "turn/start", startCommandId, params);
        if (typeof ack.turnId !== "string" || typeof ack.disposition !== "string") {
          throw new MspProtocolError("turn/start");
        }
        turnId = ack.turnId;
        disposition = ack.disposition;
        accepted = true;
        await session.recordTurnAccepted?.(startCommandId, turnId);
      }
    }
    if (turnId === undefined || disposition === undefined) {
      throw new MspProtocolError(steering ? "turn/steer" : "turn/start");
    }
    if (abortRequested) await cancel();

    const events: AsyncIterable<MspNotification> = {
      [Symbol.asyncIterator]: async function* () {
        const itemTurnIds = new Map<string, string>();
        const seenNotifications = new Set<string>();
        let parkedBreak = false;
        const processNotification = async function* (notification: MspNotification): AsyncIterable<MspNotification> {
          const params = notification.params ?? {};
          if (params.sessionId !== session.sessionId) return;
          if (typeof params.viewCursor === "string") await session.updateCursor?.(params.viewCursor);
          const notificationTurnId = eventTurnId(notification, itemTurnIds);
          if (notificationTurnId !== turnId) return;
          yield notification;
          if (notification.method === "turn/completed" || notification.method === "turn/unqueued" || notification.method === "turn/retracted") {
            terminalSeen = true;
            const terminal = notification.method === "turn/completed" && typeof params.terminal === "string"
              ? params.terminal
              : notification.method === "turn/unqueued" ? "unqueued" : "retracted";
            await session.recordTurnCompleted?.(turnId!, terminal, params.usage as Record<string, unknown> | undefined);
            if (terminal === "completed" && transcriptFingerprints) {
              await session.commitTranscriptFingerprints?.(transcriptFingerprints);
            }
          }
        };
        try {
          let next = await firstNotification!;
          while (!next.done) {
            const notification = next.value;
            const params = notification.params ?? {};
            if (notification.method === "view/gap" && params.sessionId === session.sessionId) {
              if (typeof params.after !== "string" || typeof params.next !== "string") throw new MspProtocolError("view/gap");
              for await (const replay of pageGapNotifications(session.host, session.sessionId, { after: params.after, next: params.next })) {
                const replayKey = notificationCursorKey(replay);
                if (replayKey && seenNotifications.has(replayKey)) continue;
                if (replayKey) seenNotifications.add(replayKey);
                for await (const output of processNotification(replay)) yield output;
                if (terminalSeen) return;
              }
            } else {
              const notificationKey = notificationCursorKey(notification);
              if (notificationKey && seenNotifications.has(notificationKey)) {
                next = await subscription!.next();
                continue;
              }
              if (notificationKey) seenNotifications.add(notificationKey);
              for await (const output of processNotification(notification)) yield output;
              if (terminalSeen) return;
            }
            // Opencode backend: surface parked loopback calls as native tool
            // calls the moment they arrive. The turn stays open server-side
            // (parked), so ending the OpenCode turn here must not wait for
            // another Muse event — core executes, then re-invokes with the
            // result, and that call attaches to the live turn. The handoff
            // count pays for the attaching drainer; the emitter only detaches.
            if (session.toolBackend === "opencode") {
              const queued = session.takeParkedToolCall?.();
              if (queued) {
                for await (const output of processNotification(syntheticParkedNotification(session, turnId, queued))) yield output;
                parkedBreak = true;
                session.handoffTakeovers = (session.handoffTakeovers ?? 0) + 1;
                break;
              }
              const watcher = session.watchParkedToolCall?.();
              if (watcher) {
                try {
                  const raced = await Promise.race([
                    subscription!.next().then((result) => ({ result })),
                    watcher.wait.then((call) => ({ call })),
                  ]);
                  if ("call" in raced) {
                    // The destructive take wins over the peeked call: emitting
                    // the peek would duplicate it when the take drains next.
                    const taken = session.takeParkedToolCall?.() ?? raced.call;
                    for await (const output of processNotification(syntheticParkedNotification(session, turnId, taken))) yield output;
                    parkedBreak = true;
                    session.handoffTakeovers = (session.handoffTakeovers ?? 0) + 1;
                    break;
                  }
                  next = raced.result;
                  continue;
                } finally {
                  watcher.cancel();
                }
              }
            }
            next = await subscription!.next();
          }
          if (!terminalSeen && !parkedBreak) throw new MspTransportError();
        } finally {
          options.abortSignal?.removeEventListener("abort", onAbort);
          subscriptionController?.abort();
          await subscription?.return?.();
          // Takeover accounting: every finisher except the last detaches
          // without releasing. The last finisher releases only while no newer
          // turn owns the lease — the wrapper closes the stream at finish
          // while this teardown still runs detached, so a fast follow-up may
          // have reused the lease already. A parked break is not a finish:
          // the turn stays live, so the handoff is left for the attaching
          // drainer to consume and the lease is never released here.
          if (!parkedBreak) {
            const takeovers = session.handoffTakeovers ?? 0;
            if (takeovers > 0) session.handoffTakeovers = takeovers - 1;
            else if (session.activeTurnId === undefined || session.activeTurnId === turnId) {
              await session.release?.();
            }
          }
        }
      },
    };
    return { turnId, commandId: turnCommandId, disposition, events, cancel };
  } catch (error) {
    options.abortSignal?.removeEventListener("abort", onAbort);
    if (accepted && subscription && firstNotification && turnId) {
      // The turn was accepted but its local ack could not be durably recorded.
      // Stop it, then keep draining until the terminal event before releasing
      // the workspace lease; dropping this subscription would orphan a writer.
      try { await cancel(); } catch { /* continue monitoring even if interrupt admission failed */ }
      void (async () => {
        const itemTurnIds = new Map<string, string>();
        try {
          let next = await firstNotification!.catch(() => ({ done: true as const, value: undefined }));
          while (!next.done) {
            const notification = next.value;
            const params = notification.params ?? {};
            if (eventTurnId(notification, itemTurnIds) === turnId) {
              if (typeof params.viewCursor === "string") {
                await session.updateCursor?.(params.viewCursor).catch(() => {});
              }
              if (["turn/completed", "turn/unqueued", "turn/retracted"].includes(notification.method)) {
                const terminal = notification.method === "turn/completed" && typeof params.terminal === "string"
                  ? params.terminal
                  : notification.method === "turn/unqueued" ? "unqueued" : "retracted";
                await session.recordTurnCompleted?.(turnId!, terminal, params.usage as Record<string, unknown> | undefined).catch(() => {});
                if (terminal === "completed" && transcriptFingerprints) {
                  await session.commitTranscriptFingerprints?.(transcriptFingerprints).catch(() => {});
                }
                break;
              }
            }
            next = await subscription!.next();
          }
        } catch {
          // The host may have died; its manager will see the unreconciled state.
        } finally {
          subscriptionController?.abort();
          await subscription?.return?.().catch(() => {});
          const takeovers = session.handoffTakeovers ?? 0;
          if (takeovers > 0) session.handoffTakeovers = takeovers - 1;
          else if (session.activeTurnId === undefined || session.activeTurnId === turnId) {
            await session.release?.().catch(() => {});
          }
        }
      })();
    } else if (!accepted) {
      subscriptionController?.abort();
      await firstNotification?.catch(() => undefined);
      await subscription?.return?.();
      const commandMethod = (error as { method?: unknown } | null)?.method;
      const ambiguousTurnStart = commandMethod === "turn/start" && !(error instanceof MspCommandRejectedError);
      // A failed join never owned the lease; the parked owner still holds it.
      if (!ambiguousTurnStart && !joinedTurn) await session.release?.();
    }
    throw error;
  }
}

function contextErrorToException(error: { code: string; field: string }): MuseBridgeError {
  return new MuseBridgeError("MUSE_UNSUPPORTED_REQUEST", `Muse model request context is ${error.code} (${error.field})`, false);
}

function inputErrorToException(error: { code: string; field?: string; mediaType?: string }): Error {
  if (error.code === "transcript-diverged") return new MuseTranscriptDivergedError();
  return new MuseUnsupportedInputError(error.field ?? error.mediaType ?? error.code);
}

function ignoredOptionWarnings(ignoredOptions: readonly string[]): Array<Record<string, unknown>> {
  return ignoredOptions.map((feature) => ({
    type: "unsupported",
    feature,
    details: "Muse MSP does not expose this per-turn option; the setting was ignored.",
  }));
}

function requestKindFromHeaders(options: LanguageModelV3CallOptions): string | undefined {
  const headers = options.headers;
  if (!headers) return undefined;
  const name = MUSE_CONTEXT_HEADERS.kind.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

function classifyCall(options: LanguageModelV3CallOptions): MetaRequestClass {
  return classifyMetaRequest(requestKindFromHeaders(options), options.prompt);
}

function localMetaText(kind: "title" | "compaction", options: LanguageModelV3CallOptions): string {
  return kind === "title"
    ? makeLocalTitle(options.prompt)
    : makeCompactionDigest(options.prompt, options.maxOutputTokens);
}

function localMetaGenerateResult(kind: "title" | "compaction", text: string): Awaited<ReturnType<LanguageModelV3["doGenerate"]>> {
  return {
    content: text ? [{ type: "text", text }] : [],
    finishReason: { unified: "stop", raw: `local-${kind}` },
    usage: resultUsage(undefined),
    warnings: [],
  } as unknown as Awaited<ReturnType<LanguageModelV3["doGenerate"]>>;
}

function localMetaStream(kind: "title" | "compaction", text: string): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] } as unknown as LanguageModelV3StreamPart);
      if (text) {
        controller.enqueue({ type: "text-start", id: `local-${kind}` } as unknown as LanguageModelV3StreamPart);
        controller.enqueue({ type: "text-delta", id: `local-${kind}`, delta: text } as unknown as LanguageModelV3StreamPart);
        controller.enqueue({ type: "text-end", id: `local-${kind}` } as unknown as LanguageModelV3StreamPart);
      }
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: `local-${kind}` },
        usage: resultUsage(undefined),
      } as unknown as LanguageModelV3StreamPart);
      controller.close();
    },
  });
}

export function createMuseLanguageModel(runtime: MuseLanguageRuntime, modelID: string): LanguageModelV3 {
  const doPrepare = async (options: LanguageModelV3CallOptions, allowParkedJoin: boolean) => {
    const requestKind = classifyCall(options);
    if (requestKind !== "agent") throw new MuseUnsupportedRequestError(requestKind);
    const context = readRequestContext(options, runtime.selectionIndex);
    if ("type" in context) throw contextErrorToException(context);
    if (context.kind !== "primary") throw new MuseUnsupportedRequestError(context.kind);
    const supportedOptions = validateModelOptions(options);
    if (!supportedOptions.ok) throw inputErrorToException(supportedOptions.error);
    const initialExtraction = await extractTurnInput(options.prompt, [], [], {
      signal: options.abortSignal,
      transcribeAudio: runtime.transcribeAudioClip,
      stagePdfAttachment: runtime.stagePdfAttachment
        ? (bytes: Uint8Array) => runtime.stagePdfAttachment!(context.directory, bytes)
        : undefined,
    });
    if (!initialExtraction.ok) throw inputErrorToException(initialExtraction.error);
    const approvalResponses = extractApprovalResponses(options.prompt);
    if (!allowParkedJoin && approvalResponses.length > 0) {
      if (await runtime.hasParkedApprovals?.(context.sessionID)) {
        throw new MuseUnsupportedRequestError("approval-response");
      }
      await runtime.settleApprovalResponses?.(context.sessionID, approvalResponses);
    }
    if (allowParkedJoin && approvalResponses.length > 0) {
      if (!runtime.settleApprovalResponses) {
        if (await runtime.hasParkedApprovals?.(context.sessionID)) {
          throw new MuseUnsupportedRequestError("approval-response");
        }
      } else {
        await runtime.settleApprovalResponses(context.sessionID, approvalResponses);
      }
    }
    // Conversational verdict peek: try the fresh user text against parked
    // approvals/questions BEFORE resolving. A live parked turn holds the
    // workspace lease, so resolving first would either throw the parked
    // guard or fight the lease (WorkspaceBusyError) before the verdict —
    // which answers the parked request — is ever consumed. A consumed
    // verdict reattaches lease-free; anything else resolves normally.
    // The peek is text-only (no transcription/staging yet): media-only
    // replies peek as "" and stay on today's post-resolve path.
    const peekPrints = runtime.previousTranscriptFingerprints?.(context.sessionID) ?? [];
    const peekText = approvalResponses.length === 0 ? latestUserText(options.prompt, peekPrints) : "";
    // Recovery first: a poisoned entry means no live binding (and no parked
    // approvals) can exist, so its decision precedes the verdict peek.
    // Abandon clears the entry and the turn below runs clean; anything else
    // throws the enriched error, whose message carries the choice.
    const recovery = approvalResponses.length === 0
      ? await runtime.consumeRecoveryDecision?.(context.sessionID, peekText, context.directory)
      : null;
    if (recovery && !recovery.abandoned) {
      throw new MuseRecoveryChoiceRequiredError(recovery.text);
    }
    const recoveryAbandoned = recovery?.abandoned === true;
    const peekOutcome = peekText !== ""
      ? await runtime.consumeConversationalVerdict?.(context.sessionID, peekText)
        ?? await runtime.consumeConversationalAnswer?.(context.sessionID, peekText)
      : null;
    const currentFingerprints = fingerprintVisibleTranscript(options.prompt);
    const session = await runtime.resolveSession(context, {
      ...(peekOutcome ? { verdictConsumed: true } : {}),
      incomingFingerprints: currentFingerprints,
    });
    // Set by the manager when the settled verdicts matched a parked turn.
    const joining = session.joinParkedTurnId !== undefined;
    // Opencode backend (#37): publish OpenCode's forwarded tools on the
    // loopback bridge, then attach tool-result re-invocations to the live
    // turn instead of starting one. Every result must address a parked call
    // (already-resolved repeats are skipped); anything else fails closed
    // before touching the turn.
    if (session.toolBackend === "opencode") {
      const forwarded = (options as { tools?: unknown }).tools;
      if (Array.isArray(forwarded) && forwarded.length > 0) {
        session.syncLoopbackTools?.(forwarded);
      }
      if (!joining && session.activeTurnId !== undefined) {
        const toolResults = extractToolResults(options.prompt);
        if (toolResults.length > 0) {
          for (const toolResult of toolResults) {
            const outcome = session.resolveParkedToolCall?.(toolResult.toolCallId, toolResult.outputText) ?? "unknown";
            if (outcome === "unknown") {
              await session.release?.();
              throw new MuseUnsupportedInputError("tool-result");
            }
          }
          session.attachToActiveTurn = true;
          const execution = await runMuseTurn(context, [], options, {
            ...runtime,
            resolveSession: async () => session,
          }, currentFingerprints);
          return {
            context,
            execution,
            mapper: new MuseStreamMapper(
              execution.turnId,
              session.emittedApprovalPrompts,
              describeApprovals(runtime, context.sessionID),
              describeUserInputQuestion(runtime, context.sessionID),
            ),
            warnings: ignoredOptionWarnings(supportedOptions.options.ignoredOptions),
            epoch: session.streamEpoch,
            session,
            initialText: undefined,
            syntheticOnly: false,
          };
        }
      }
    }
    // The effort tier arrives as the resolved request variant (Ctrl+T,
    // OpenCode's /effort, or a #variant model suffix); "default" already
    // resolved to the catalog default upstream. Unknown variants fail closed
    // in readRequestContext before reaching this point.
    if (session.contextError) {
      if (joining) runtime.disarmParkedJoin?.(context.sessionID);
      else await session.release?.();
      throw new MuseUnsupportedRequestError(session.contextError);
    }
    const observedCompaction = (session.compactionFingerprints ?? []).some((candidate) =>
      promptContainsCompactionFingerprint(options.prompt, candidate),
    );
    const runExtraction = () => extractTurnInput(
      options.prompt,
      observedCompaction ? [] : session.previousTranscriptFingerprints,
      session.contextAllowlist,
      {
        signal: options.abortSignal,
        transcribeAudio: runtime.transcribeAudioClip,
        stagePdfAttachment: runtime.stagePdfAttachment
          ? (bytes: Uint8Array) =>
              runtime.stagePdfAttachment!(resolveStagingRoot(session.worktree?.path, context.directory), bytes)
          : undefined,
      },
    );
    const noteFirstTurn = (result: ExtractTurnInputResult) => {
      if (!result.ok) return;
      const notices = pendingFirstTurnNotices(session.sessionNotices, session.previousTranscriptFingerprints, observedCompaction);
      if (notices.length > 0) result.parts.unshift({ type: "text", text: notices.join("\n") });
    };
    let extracted = await runExtraction();
    noteFirstTurn(extracted);
    if (!extracted.ok && !joining && extracted.error.code === "transcript-diverged" && session.activeTurnId === undefined) {
      // Rewind: the retained prefix maps to a completed Muse turn, so fork
      // there and continue on the fork. Anything unmappable — or a fork the
      // manager refuses — falls through to the fail-closed divergence error:
      // no uncut turn on the original session, no prompt replay.
      const retained = commonPrefixLength(session.previousTranscriptFingerprints, currentFingerprints);
      const fork = await runtime.forkSessionAtBoundary?.(context.sessionID, retained) ?? { forked: false };
      if (fork.forked) {
        extracted = await runExtraction();
        noteFirstTurn(extracted);
      }
    }
    if (!extracted.ok) {
      if (joining && extracted.error.code === "no-new-user-input") {
        try {
          const execution = await runMuseTurn(context, [], options, {
            ...runtime,
            resolveSession: async () => session,
          }, session.previousTranscriptFingerprints);
          return {
            context,
            execution,
            mapper: new MuseStreamMapper(
              execution.turnId,
              session.emittedApprovalPrompts,
              describeApprovals(runtime, context.sessionID),
              describeUserInputQuestion(runtime, context.sessionID),
            ),
            warnings: ignoredOptionWarnings(supportedOptions.options.ignoredOptions),
            epoch: session.streamEpoch,
            session,
            initialText: undefined,
            syntheticOnly: false,
          };
        } catch (error) {
          runtime.disarmParkedJoin?.(context.sessionID);
          throw error;
        }
      }
      if (joining) runtime.disarmParkedJoin?.(context.sessionID);
      else await session.release?.();
      throw inputErrorToException(extracted.error);
    }
    // Conversational verdicts: with a parked approval or question and fresh
    // user text (and no legacy structured responses), the message answers
    // the oldest pending item instead of starting a turn. Approvals decide
    // first — side effects gate the turn — then questions. Verdict text is
    // never forwarded to the model. The pre-resolve peek above already
    // consumed when the text matched; the post-resolve consume below only
    // runs when the peek found nothing (e.g. media-only replies), so a
    // verdict is never consumed twice.
    const verdictText = approvalResponses.length === 0 ? userTextOf(extracted.parts) : "";
    let initialText: string | undefined;
    let syntheticOnly = false;
    const outcome = peekOutcome ?? (verdictText !== ""
      ? await runtime.consumeConversationalVerdict?.(context.sessionID, verdictText)
        ?? await runtime.consumeConversationalAnswer?.(context.sessionID, verdictText)
      : null);
    let runMessageAsTurn = false;
    if (outcome) {
      initialText = outcome.text;
      // Join only the final verdict while the parked turn is still
      // attached: it resumes the turn. Re-asks, queued items, and
      // dead turns end synthetically with the outcome text.
      syntheticOnly = !outcome.settledLast || session.joinParkedTurnId === undefined;
      if (outcome.settledLast && "runMessageAsTurn" in outcome && outcome.runMessageAsTurn === true) {
        // Second mismatch: the user is saying something else, not answering.
        // The denial is recorded; interrupt the parked turn so a reviving
        // model can't re-park, clear the join, and run the message as a
        // fresh turn instead of eating it.
        const parkedTurnId = session.joinParkedTurnId;
        session.joinParkedTurnId = undefined;
        runMessageAsTurn = true;
        syntheticOnly = false;
        if (parkedTurnId !== undefined) await interruptParkedTurn(session, parkedTurnId);
      }
    }
    if (recoveryAbandoned && recovery) {
      // The stuck entry is gone and the session below is fresh, but the
      // abandon message itself ("A") is not a turn: confirm synthetically
      // and let the user re-prompt.
      initialText = recovery.text;
      syntheticOnly = true;
    }
    let execution: MuseTurnExecution;
    try {
      execution = syntheticOnly
        ? syntheticVerdictExecution()
        : await runMuseTurn(context, initialText !== undefined && !runMessageAsTurn ? [] : extracted.parts, options, {
          ...runtime,
          resolveSession: async () => session,
        }, extracted.nextTranscriptFingerprints);
    } catch (error) {
      if (joining || session.joinParkedTurnId !== undefined) runtime.disarmParkedJoin?.(context.sessionID);
      throw error;
    }
    return {
      context,
      execution,
      mapper: new MuseStreamMapper(
        execution.turnId,
        session.emittedApprovalPrompts,
        describeApprovals(runtime, context.sessionID),
        describeUserInputQuestion(runtime, context.sessionID),
      ),
      warnings: ignoredOptionWarnings(supportedOptions.options.ignoredOptions),
      epoch: session.streamEpoch,
      session,
      initialText,
      syntheticOnly,
    };
  };

  return {
    specificationVersion: "v3",
    // OpenCode 2.1.2's proven in-process hook consumes specVersion and flat
    // usage; keep the official SDK type member as well for type-level V3.
    specVersion: "v3",
    provider: "muse",
    modelId: modelID,
    supportedUrls: {},
    async doStream(options: LanguageModelV3CallOptions) {
      const requestKind = classifyCall(options);
      if (requestKind === "title" || requestKind === "compaction") {
        return { stream: localMetaStream(requestKind, localMetaText(requestKind, options)) };
      }
      if (requestKind === "unsupported-generate") throw new MuseUnsupportedRequestError("generate");
      const prepared = await doPrepare(options, true);
      let outputClosed = false;
      let controllerRef: ReadableStreamDefaultController<LanguageModelV3StreamPart> | undefined;
      const closeOutput = () => {
        if (outputClosed) return;
        outputClosed = true;
        try { controllerRef?.close(); } catch { /* stream was cancelled by OpenCode */ }
      };
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controllerRef = controller;
          controller.enqueue({ type: "stream-start", warnings: prepared.warnings } as unknown as LanguageModelV3StreamPart);
          void (async () => {
            if (prepared.initialText !== undefined) {
              controller.enqueue({ type: "text-start", id: "bridge-verdict" } as unknown as LanguageModelV3StreamPart);
              controller.enqueue({ type: "text-delta", id: "bridge-verdict", delta: prepared.initialText } as unknown as LanguageModelV3StreamPart);
              controller.enqueue({ type: "text-end", id: "bridge-verdict" } as unknown as LanguageModelV3StreamPart);
              if (prepared.syntheticOnly) {
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop", raw: "conversational-verdict" },
                  usage: resultUsage(prepared.mapper.usage),
                } as unknown as LanguageModelV3StreamPart);
                closeOutput();
                return;
              }
            }
            try {
              for await (const notification of prepared.execution.events) {
                // A newer call took over this session's output: end this
                // stream without a finish part. The generator's finally
                // detaches the lease to the joining call.
                if (prepared.epoch !== undefined && prepared.session.streamEpoch !== undefined
                  && prepared.session.streamEpoch !== prepared.epoch) {
                  closeOutput();
                  break;
                }
                const parts = prepared.mapper.accept(notification);
                for (const part of parts) {
                  if (outputClosed) continue;
                  if (part.type === "finish") {
                    controller.enqueue(part as unknown as LanguageModelV3StreamPart);
                    closeOutput();
                    continue;
                  }
                  controller.enqueue(part as unknown as LanguageModelV3StreamPart);
                }
              }
              if (!outputClosed) closeOutput();
            } catch (error) {
              if (outputClosed) return;
              const safeError = error instanceof MuseBridgeError ? error : new MspTransportError();
              controller.enqueue({ type: "error", error: safeError } as unknown as LanguageModelV3StreamPart);
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "error", raw: undefined },
                usage: resultUsage(prepared.mapper.usage),
              } as unknown as LanguageModelV3StreamPart);
              closeOutput();
            }
          })();
        },
        async cancel() {
          outputClosed = true;
          await prepared.execution.cancel();
        },
      });
      return { stream };
    },
    async doGenerate(options: LanguageModelV3CallOptions) {
      const requestKind = classifyCall(options);
      if (requestKind === "title" || requestKind === "compaction") {
        return localMetaGenerateResult(requestKind, localMetaText(requestKind, options));
      }
      if (requestKind === "unsupported-generate") throw new MuseUnsupportedRequestError("generate");
      const prepared = await doPrepare(options, false);
      if (prepared.syntheticOnly) {
        return {
          content: prepared.initialText !== undefined ? [{ type: "text", text: prepared.initialText }] : [],
          finishReason: { unified: "stop", raw: "conversational-verdict" },
          usage: resultUsage(undefined),
          warnings: prepared.warnings,
        } as unknown as Awaited<ReturnType<LanguageModelV3["doGenerate"]>>;
      }
      let terminalError: Error | undefined;
      const iterator = prepared.execution.events[Symbol.asyncIterator]();
      while (true) {
        if (prepared.epoch !== undefined && prepared.session.streamEpoch !== undefined
          && prepared.session.streamEpoch !== prepared.epoch) {
          break;
        }
        const next = await iterator.next();
        if (next.done) break;
        const parts = prepared.mapper.accept(next.value);
        if (prepared.mapper.failure) terminalError = prepared.mapper.failure;
        const foregroundFinished = parts.some((part) =>
          part.type === "finish"
          && (part.finishReason as { raw?: unknown } | undefined)?.raw === "foregroundCompleted",
        );
        if (foregroundFinished) {
          void (async () => {
            try {
              while (!(await iterator.next()).done) {
                // Continue monitoring terminal state and release the workspace lease.
              }
            } catch {
              // The foreground response is already complete; terminal monitor
              // failure is recorded by the session manager's durable state.
            }
          })();
          break;
        }
      }
      if (terminalError) throw terminalError;
      return {
        content: prepared.initialText !== undefined
          ? [{ type: "text", text: prepared.initialText }, ...prepared.mapper.content]
          : prepared.mapper.content,
        finishReason: prepared.mapper.finishReason ?? { unified: "other", raw: undefined },
        usage: resultUsage(prepared.mapper.usage),
        warnings: prepared.warnings,
      } as unknown as Awaited<ReturnType<LanguageModelV3["doGenerate"]>>;
    },
  } as unknown as LanguageModelV3;
}
