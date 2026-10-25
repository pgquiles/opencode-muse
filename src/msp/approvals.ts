// Selection of an MSP approval choice id from an OpenCode-style boolean verdict.
//
// OpenCode owns persistence (its "always allow" equivalent suppresses future
// prompts before MSP is ever asked), so a bare `true` maps to the minimal
// grant: one `once`-scoped approve choice. Anything broader or ambiguous
// fails closed by returning null, and `localPersistent` choices are never
// selected: the plugin must not create host-side persistent policy.

interface ValidApprovalChoice {
  choiceId: string;
  decision: "approve" | "reject";
  scope: string;
}

function validChoices(choices: readonly unknown[]): ValidApprovalChoice[] {
  const valid: ValidApprovalChoice[] = [];
  for (const entry of choices) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.choiceId !== "string") continue;
    if (candidate.decision !== "approve" && candidate.decision !== "reject") continue;
    if (typeof candidate.scope !== "string") continue;
    valid.push({ choiceId: candidate.choiceId, decision: candidate.decision, scope: candidate.scope });
  }
  return valid;
}

function singleChoiceId(choices: readonly ValidApprovalChoice[]): string | null {
  return choices.length === 1 ? choices[0].choiceId : null;
}

/**
 * Map an OpenCode boolean approval verdict onto an MSP approval choice id.
 *
 * @param choices The `choices` array from the `approval/request` payload.
 * @param approved True when OpenCode approved, false when denied.
 * @returns The selected `choiceId`, or null when no single safe choice fits.
 *   Null means the caller must fail closed (deny with a fresh-session hint).
 */
export interface ApprovalRequestParams {
  approvalId: string;
  currentRequirementId: string;
  availableChoices: readonly unknown[];
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName?: string;
}

export type ApprovalVerdict =
  | { approved: boolean; params: ApprovalRequestParams }
  | { choiceId: string; params: ApprovalRequestParams }
  | { approved: false; timedOut: true; params: ApprovalRequestParams }
  | { alreadyDecided: true; params: ApprovalRequestParams };

function asApprovalRequestParams(value: unknown): ApprovalRequestParams | null {
  if (typeof value !== "object" || value === null) return null;
  const params = value as Record<string, unknown>;
  if (typeof params.approvalId !== "string") return null;
  if (typeof params.currentRequirementId !== "string") return null;
  if (!Array.isArray(params.availableChoices)) return null;
  if (typeof params.sessionId !== "string") return null;
  if (typeof params.turnId !== "string") return null;
  if (typeof params.toolCallId !== "string") return null;
  return {
    approvalId: params.approvalId,
    currentRequirementId: params.currentRequirementId,
    availableChoices: params.availableChoices,
    sessionId: params.sessionId,
    turnId: params.turnId,
    toolCallId: params.toolCallId,
    ...(typeof params.toolName === "string" ? { toolName: params.toolName } : {}),
  };
}

interface PendingStage {
  params: ApprovalRequestParams;
  resolve: (verdict: ApprovalVerdict) => void;
  promise: Promise<ApprovalVerdict>;
}

interface PendingApproval {
  approvalId: string;
  stages: Map<string, PendingStage>;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Conversational verdict attempts consumed; re-ask once, then deny. */
  verdictAttempts?: number;
}

/** A validated offer from `availableChoices`, in presented order. */
export interface ConversationalChoice {
  choiceId: string;
  label: string;
  scope: string;
}

/** Keep only choices with a usable verbatim label, in presented order. */
export function conversationalChoices(availableChoices: readonly unknown[]): ConversationalChoice[] {
  const choices: ConversationalChoice[] = [];
  for (const entry of availableChoices) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.choiceId !== "string") continue;
    if (typeof candidate.label !== "string" || candidate.label.trim() === "") continue;
    if (typeof candidate.scope !== "string") continue;
    choices.push({ choiceId: candidate.choiceId, label: candidate.label, scope: candidate.scope });
  }
  return choices;
}

const CHOICE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function normalizeChoiceText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Match free text to exactly one presented choice by letter, number, label,
 * or letter+label (case/punctuation/whitespace-insensitive). Anything else —
 * unknown forms, ties across choices, meaning-based pleas — returns null so
 * the caller re-asks once, then fails closed. Ambiguity never resolves to an
 * approval. Generic over the choice shape so userInput options reuse it.
 */
export function matchConversationalChoice<T extends { label: string }>(
  choices: readonly T[],
  input: string,
): T | null {
  const wanted = normalizeChoiceText(input);
  if (wanted === "") return null;
  let matched: T | null = null;
  for (let index = 0; index < choices.length; index += 1) {
    const choice = choices[index]!;
    const forms = new Set([
      normalizeChoiceText(CHOICE_LETTERS[index] ?? ""),
      normalizeChoiceText(choice.label),
      normalizeChoiceText(`${CHOICE_LETTERS[index] ?? ""}${choice.label}`),
      String(index + 1),
    ]);
    forms.delete("");
    if (!forms.has(wanted)) continue;
    if (matched !== null) return null;
    matched = choice;
  }
  return matched;
}

/**
 * Render the choices verbatim as a lettered list with the reply contract.
 * Labeled as bridge text: the Muse transcript never sees this (the bridge
 * only forwards new user input), and the OpenCode side must not mistake it
 * for model output.
 */
export function renderConversationalApprovalPrompt(input: {
  toolName?: string;
  choices: readonly ConversationalChoice[];
  attempt: number;
  received?: string;
}): string {
  const action = input.toolName ? `Muse wants to run \`${input.toolName}\`.` : "Muse wants to perform an action.";
  const lines = input.choices.map((choice, index) =>
    `${CHOICE_LETTERS[index] ?? "?"}. ${choice.label} (${choice.scope})`);
  const contract = "Reply with one option (letter, number, or name). Anything else is asked once more, then denied.";
  const header = `**Approval needed** (opencode-muse bridge message, not the model): ${action}`;
  if (input.attempt > 0 && input.received !== undefined) {
    const quoted = input.received.length > 200 ? `${input.received.slice(0, 200)}…` : input.received;
    return `${header}\nI didn't understand "${quoted}" — reply with one of:\n${lines.join("\n")}\n${contract}`;
  }
  return `${header}\n${lines.join("\n")}\n${contract}`;
}

/**
 * Per-session latch for MSP approval round trips. Mirrors the SDK router's
 * discipline without duplicating it: one verdict per approval, a new stage
 * (requirement id) replaces nothing but parks alongside, decided stages
 * never re-park, and an undecided wait fails closed as denied on timeout.
 * Late verdicts for settled approvals are dropped as stale.
 */
export class ApprovalExchange {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly decided = new Set<string>();
  constructor(private readonly options: { timeoutMs: number } = { timeoutMs: 10 * 60 * 1000 }) {}

  pendingApprovalIds(): string[] {
    return [...this.pending.keys()];
  }

  /** The Muse turn that opened a pending approval, if it is still parked. */
  pendingApprovalTurnId(approvalId: string): string | undefined {
    const stages = this.pending.get(approvalId)?.stages.values();
    return stages?.next().value?.params.turnId;
  }

  requestApproval(params: unknown): Promise<ApprovalVerdict> {
    const parsed = asApprovalRequestParams(params);
    if (parsed === null) return Promise.reject(new Error("unroutable-approval-request"));
    const stageKey = `${parsed.approvalId} ${parsed.currentRequirementId}`;
    if (this.decided.has(stageKey)) {
      return Promise.resolve({ alreadyDecided: true as const, params: parsed });
    }
    const existing = this.pending.get(parsed.approvalId);
    if (existing) {
      const staged = existing.stages.get(parsed.currentRequirementId);
      if (staged) {
        staged.params = parsed;
        return staged.promise;
      }
      let resolveStage!: (verdict: ApprovalVerdict) => void;
      const promise = new Promise<ApprovalVerdict>((resolve) => { resolveStage = resolve; });
      existing.stages.set(parsed.currentRequirementId, { params: parsed, resolve: resolveStage, promise });
      return promise;
    }
    let resolveStage!: (verdict: ApprovalVerdict) => void;
    const promise = new Promise<ApprovalVerdict>((resolve) => { resolveStage = resolve; });
    const pending: PendingApproval = {
      approvalId: parsed.approvalId,
      stages: new Map([[parsed.currentRequirementId, { params: parsed, resolve: resolveStage, promise }]]),
      timer: undefined,
    };
    pending.timer = setTimeout(() => this.timeOut(parsed.approvalId), this.options.timeoutMs);
    this.pending.set(parsed.approvalId, pending);
    return promise;
  }

  settle(approvalId: string, approved: boolean): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) return false;
    this.clear(approvalId);
    for (const stage of pending.stages.values()) {
      stage.resolve({ approved, params: stage.params });
    }
    return true;
  }

  /**
   * Settle with the exact choice the user picked conversationally. The host
   * validates the id against the offered choices before deciding.
   */
  settleChoice(approvalId: string, choiceId: string): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) return false;
    this.clear(approvalId);
    for (const stage of pending.stages.values()) {
      stage.resolve({ choiceId, params: stage.params });
    }
    return true;
  }

  /**
   * Consume one conversational verdict attempt for a pending approval.
   * Returns the zero-based attempt index, or -1 when nothing pends.
   */
  noteVerdictAttempt(approvalId: string): number {
    const pending = this.pending.get(approvalId);
    if (!pending) return -1;
    const attempts = pending.verdictAttempts ?? 0;
    pending.verdictAttempts = attempts + 1;
    return attempts;
  }

  /** Pending approvals in arrival order with their latest offered choices. */
  describePending(): Array<{
    approvalId: string;
    requirementId: string;
    choices: ConversationalChoice[];
    toolName?: string;
    turnId: string;
  }> {
    const described: Array<{
      approvalId: string;
      requirementId: string;
      choices: ConversationalChoice[];
      toolName?: string;
      turnId: string;
    }> = [];
    for (const pending of this.pending.values()) {
      const requirementIds = [...pending.stages.keys()];
      const latest = pending.stages.get(requirementIds[requirementIds.length - 1]!)!;
      described.push({
        approvalId: pending.approvalId,
        requirementId: latest.params.currentRequirementId,
        choices: conversationalChoices(latest.params.availableChoices),
        ...(typeof latest.params.toolName === "string" ? { toolName: latest.params.toolName } : {}),
        turnId: latest.params.turnId,
      });
    }
    return described;
  }

  markDecided(approvalId: string, requirementId: string): void {
    this.decided.add(`${approvalId} ${requirementId}`);
    this.clear(approvalId);
  }

  private timeOut(approvalId: string): void {
    const pending = this.pending.get(approvalId);
    if (!pending) return;
    this.clear(approvalId);
    for (const stage of pending.stages.values()) {
      stage.resolve({ approved: false as const, timedOut: true as const, params: stage.params });
    }
  }

  private clear(approvalId: string): void {
    const pending = this.pending.get(approvalId);
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    this.pending.delete(approvalId);
  }
}

export function selectApprovalChoiceId(choices: readonly unknown[], approved: boolean): string | null {
  const valid = validChoices(choices);
  const wantedDecision = approved ? "approve" : "reject";
  const once = valid.filter((choice) => choice.decision === wantedDecision && choice.scope === "once");
  if (once.length === 1) return once[0].choiceId;
  if (once.length > 1) return null;
  const session = valid.filter((choice) =>
    choice.decision === wantedDecision && choice.scope === "session",
  );
  return singleChoiceId(session);
}
