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
