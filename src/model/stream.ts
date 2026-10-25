import {
  MspProtocolError,
  MuseTurnFailedError,
  MuseTurnUnqueuedError,
} from "../errors.js";
import type { MspNotification } from "../msp/client.js";
import { notificationCursorKey } from "../msp/notification.js";
import {
  renderConversationalApprovalPrompt,
  type ConversationalChoice,
} from "../msp/approvals.js";

export interface FlatMuseUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
  reasoningTokens: number | undefined;
}

export type MuseStreamPart = Record<string, unknown>;

interface ItemSnapshot {
  itemId?: string;
  turnId?: string | null;
  kind?: string;
  status?: string;
  text?: string;
  summary?: string[];
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function terminalFinishReason(terminal: string): "stop" | "error" | "other" {
  if (terminal === "completed") return "stop";
  if (terminal === "failed") return "error";
  return "other";
}

/** Maps typed Muse view facts to text/reasoning-only V3 events and safe usage. */
export class MuseStreamMapper {
  private readonly itemKinds = new Map<string, string>();
  private readonly itemStarted = new Set<string>();
  private readonly reasoningStarted = new Set<string>();
  private readonly itemDeltaCounts = new Map<string, number>();
  private readonly itemText = new Map<string, string>();
  private readonly seenUsageNotifications = new Set<string>();
  private readonly textParts: Array<{ type: "text"; text: string }> = [];
  private terminalUsage: FlatMuseUsage | undefined;
  private callUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0 };
  private hasCallUsage = false;
  private finishWasSent = false;
  private currentFinishReason: { unified: "stop" | "error" | "other"; raw: string } | undefined;
  terminal?: string;
  failure?: Error;

  constructor(
    readonly turnId: string,
    private readonly emittedApprovals: Set<string> = new Set(),
    private readonly approvalChoices?: (
      approvalId: string,
      requirementId: string,
    ) => { choices: ConversationalChoice[]; toolName?: string } | undefined,
  ) {}

  get generatedText(): string {
    return this.textParts.map((part) => part.text).join("");
  }

  get content(): Array<{ type: "text"; text: string }> {
    const text = this.generatedText;
    return text.length > 0 ? [{ type: "text", text }] : [];
  }

  get usage(): FlatMuseUsage | undefined {
    if (this.terminalUsage) return { ...this.terminalUsage };
    if (!this.hasCallUsage) return undefined;
    return { ...this.callUsage };
  }

  get finishWasSentToOpenCode(): boolean {
    return this.finishWasSent;
  }

  get finishReason(): { unified: "stop" | "error" | "other"; raw: string } | undefined {
    return this.currentFinishReason;
  }

  accept(notification: MspNotification): MuseStreamPart[] {
    const params = notification.params ?? {};
    switch (notification.method) {
      case "item/started":
        return this.itemStartedEvent(params);
      case "item/delta":
        return this.itemDeltaEvent(params);
      case "item/completed":
        return this.itemCompletedEvent(params);
      case "session/tokenUsage":
        this.tokenUsageEvent(params);
        return [];
      case "turn/foregroundCompleted":
        if (params.turnId !== this.turnId || this.finishWasSent) return [];
        this.terminal = "foregroundCompleted";
        return [this.finishPart("stop", "foregroundCompleted")];
      case "turn/unqueued":
        if (params.turnId !== this.turnId) return [];
        this.terminal = "unqueued";
        this.failure = new MuseTurnUnqueuedError();
        return this.finishWasSent ? [] : this.failAndFinish(this.failure, "unqueued");
      case "turn/retracted":
        if (params.turnId !== this.turnId) return [];
        this.terminal = "retracted";
        return this.finishWasSent ? [] : [this.finishPart("other", "retracted")];
      case "turn/completed":
        return this.turnCompleted(params);
      case "approval/requested":
        return this.approvalRequestedEvent(params);
      default:
        return [];
    }
  }

  private approvalRequestedEvent(params: Record<string, unknown>): MuseStreamPart[] {
    const approvalId = params.approvalId;
    const toolCallId = params.toolCallId;
    if (typeof approvalId !== "string" || typeof toolCallId !== "string") return [];
    const requirementId = typeof params.currentRequirementId === "string" ? params.currentRequirementId : "";
    const stageKey = `${approvalId} ${requirementId}`;
    if (this.emittedApprovals.has(stageKey)) return [];
    this.emittedApprovals.add(stageKey);
    // A parked approval ends the OpenCode turn with a conversational prompt
    // instead of a part core drops. The verdict arrives as the next user
    // message; the parked turn resumes once it is decided.
    const described = this.approvalChoices?.(approvalId, requirementId);
    const choices = described?.choices ?? [];
    const toolName = described?.toolName ?? (typeof params.toolName === "string" ? params.toolName : undefined);
    const prompt = choices.length > 0
      ? renderConversationalApprovalPrompt({ toolName, choices, attempt: 0 })
      : `**Approval needed** (opencode-muse bridge message, not the model): Muse requested approval${toolName ? ` to run \`${toolName}\`` : ""} but offered no presentable options; the parked turn denies on timeout. Re-prompt to try again.`;
    const itemId = `approval-${approvalId}`;
    this.textParts.push({ type: "text", text: prompt });
    return [
      { type: "text-start", id: itemId },
      { type: "text-delta", id: itemId, delta: prompt },
      { type: "text-end", id: itemId },
      this.finishPart("stop", "approval-parked"),
    ];
  }

  private itemStartedEvent(params: Record<string, unknown>): MuseStreamPart[] {
    const item = params.item as ItemSnapshot | undefined;
    if (!item || item.turnId !== this.turnId || typeof item.itemId !== "string") return [];
    this.itemKinds.set(item.itemId, item.kind ?? "unknown");
    this.itemStarted.add(item.itemId);
    if (item.kind === "agentMessage") return [{ type: "text-start", id: item.itemId }];
    return [];
  }

  private itemDeltaEvent(params: Record<string, unknown>): MuseStreamPart[] {
    if (typeof params.itemId !== "string" || typeof params.delta !== "string") return [];
    const kind = this.itemKinds.get(params.itemId);
    if (kind === "agentMessage" && (params.field === undefined || params.field === "text")) {
      this.itemDeltaCounts.set(params.itemId, (this.itemDeltaCounts.get(params.itemId) ?? 0) + 1);
      this.itemText.set(params.itemId, (this.itemText.get(params.itemId) ?? "") + params.delta);
      this.textParts.push({ type: "text", text: params.delta });
      return [{ type: "text-delta", id: params.itemId, delta: params.delta }];
    }
    if (kind === "reasoning" && typeof params.field === "string" && params.field.startsWith("summary.")) {
      this.itemDeltaCounts.set(params.itemId, (this.itemDeltaCounts.get(params.itemId) ?? 0) + 1);
      const parts: MuseStreamPart[] = [];
      if (!this.reasoningStarted.has(params.itemId)) {
        this.reasoningStarted.add(params.itemId);
        parts.push({ type: "reasoning-start", id: params.itemId });
      }
      parts.push({ type: "reasoning-delta", id: params.itemId, delta: params.delta });
      return parts;
    }
    return [];
  }

  private itemCompletedEvent(params: Record<string, unknown>): MuseStreamPart[] {
    const item = params.item as ItemSnapshot | undefined;
    if (!item || item.turnId !== this.turnId || typeof item.itemId !== "string") return [];
    this.itemKinds.set(item.itemId, item.kind ?? "unknown");
    if (item.kind === "reasoning") {
      const summaries = Array.isArray(item.summary) ? item.summary.filter((value): value is string => typeof value === "string") : [];
      const hasSummaryDeltas = (this.itemDeltaCounts.get(item.itemId) ?? 0) > 0;
      if (hasSummaryDeltas) return this.reasoningStarted.has(item.itemId)
        ? [{ type: "reasoning-end", id: item.itemId }]
        : [];
      if (summaries.length === 0) return [];
      return [
        { type: "reasoning-start", id: item.itemId },
        ...summaries.map((delta) => ({ type: "reasoning-delta", id: item.itemId!, delta })),
        { type: "reasoning-end", id: item.itemId },
      ];
    }
    if (item.kind !== "agentMessage") return [];

    const parts: MuseStreamPart[] = [];
    if (!this.itemStarted.has(item.itemId)) {
      this.itemStarted.add(item.itemId);
      parts.push({ type: "text-start", id: item.itemId });
    }
    if (typeof item.text === "string") {
      const observed = this.itemText.get(item.itemId) ?? "";
      if (observed.length === 0 && item.text.length > 0) {
        this.itemText.set(item.itemId, item.text);
        this.textParts.push({ type: "text", text: item.text });
        parts.push({ type: "text-delta", id: item.itemId, delta: item.text });
      } else if (observed.length > 0 && item.text.startsWith(observed)) {
        const suffix = item.text.slice(observed.length);
        if (suffix.length > 0) {
          this.itemText.set(item.itemId, item.text);
          this.textParts.push({ type: "text", text: suffix });
          parts.push({ type: "text-delta", id: item.itemId, delta: suffix });
        }
      } else if (observed !== item.text) {
        this.failure = new MspProtocolError("item/completed");
        return [{ type: "error", error: this.failure }];
      }
    }
    parts.push({ type: "text-end", id: item.itemId });
    return parts;
  }

  private tokenUsageEvent(params: Record<string, unknown>): void {
    if (params.turnId !== this.turnId || typeof params.viewCursor !== "string") return;
    const key = notificationCursorKey({ method: "session/tokenUsage", params });
    if (!key || this.seenUsageNotifications.has(key)) return;
    this.seenUsageNotifications.add(key);
    const raw = params.usage as Record<string, unknown> | undefined;
    if (!raw) return;
    const inputTokens = isNumber(params.promptTokens)
      ? params.promptTokens
      : isNumber(raw.inputTokens) ? raw.inputTokens : 0;
    const outputTokens = isNumber(raw.outputTokens) ? raw.outputTokens : 0;
    const reasoningTokens = isNumber(raw.reasoningTokens) ? raw.reasoningTokens : 0;
    const totalTokens = isNumber(params.totalTokens) ? params.totalTokens : inputTokens + outputTokens;
    this.callUsage.inputTokens += inputTokens;
    this.callUsage.outputTokens += outputTokens;
    this.callUsage.totalTokens += totalTokens;
    this.callUsage.reasoningTokens += reasoningTokens;
    this.hasCallUsage = true;
  }

  private turnCompleted(params: Record<string, unknown>): MuseStreamPart[] {
    if (params.turnId !== this.turnId || typeof params.terminal !== "string") return [];
    this.terminal = params.terminal;
    const unified = terminalFinishReason(params.terminal);
    this.currentFinishReason = { unified, raw: params.terminal };
    const terminalUsage = params.usage as Record<string, unknown> | undefined;
    if (terminalUsage) {
      const inputTokens = isNumber(terminalUsage.inputTokens) ? terminalUsage.inputTokens : undefined;
      const outputTokens = isNumber(terminalUsage.outputTokens) ? terminalUsage.outputTokens : undefined;
      const reasoningTokens = isNumber(terminalUsage.reasoningTokens) ? terminalUsage.reasoningTokens : undefined;
      this.terminalUsage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens === undefined || outputTokens === undefined ? undefined : inputTokens + outputTokens,
        reasoningTokens,
      };
    }
    if (this.failure) return this.finishWasSent ? [] : this.failAndFinish(this.failure, params.terminal);
    if (params.terminal === "failed") {
      const error = params.error as { kind?: unknown; retryable?: unknown } | undefined;
      this.failure = new MuseTurnFailedError(
        typeof error?.kind === "string" ? error.kind : "unknown",
        typeof error?.retryable === "boolean" ? error.retryable : undefined,
      );
      return this.finishWasSent ? [] : this.failAndFinish(this.failure, params.terminal);
    }
    return this.finishWasSent ? [] : [this.finishPart(terminalFinishReason(params.terminal), params.terminal)];
  }

  private failAndFinish(error: Error, terminal: string): MuseStreamPart[] {
    this.finishWasSent = true;
    const unified = error instanceof MspProtocolError ? "error" : terminalFinishReason(terminal);
    return [{ type: "error", error }, this.finishPart(unified, terminal)];
  }

  private finishPart(unified: "stop" | "error" | "other", raw: string): MuseStreamPart {
    this.finishWasSent = true;
    this.currentFinishReason = { unified, raw };
    return {
      type: "finish",
      finishReason: this.currentFinishReason,
      usage: this.usage ?? {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        reasoningTokens: undefined,
      },
    };
  }
}
