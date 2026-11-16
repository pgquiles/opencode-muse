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
/**
 * One requirement of an approval. The MSP wire sends
 * `currentRequirementId` as this object (never a string); legacy string
 * ids are still accepted and attributed to requirement 0 of the approval.
 */
export interface ApprovalRequirementId {
  approvalId: string;
  sourceIndex: number;
}

export interface ApprovalRequestParams {
  approvalId: string;
  currentRequirementId: string | ApprovalRequirementId;
  availableChoices: readonly unknown[];
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName?: string;
  /** What the approval is for (host words). Display only; never a grant. */
  subject?: ApprovalSubjectInfo;
  /** The tool call's arguments as a string, usually JSON. Display fallback. */
  rawArgs?: string;
  /** The judge's escalation reason, one bounded display line. Display only. */
  reviewerReason?: string;
}

/**
 * Display projection of the MSP `ApprovalSubject`. The wire kind is open
 * (`shell | fileAccess | network | unixSocket | process | tool | …`); only
 * the fields the prompt can show are kept, and unknown kinds fall back to
 * `rawArgs`. Nothing here authorizes anything.
 */
export interface ApprovalSubjectInfo {
  kind: string;
  host?: string;
  port?: number;
  protocol?: string;
  command?: string;
  path?: string;
  access?: string;
  target?: string;
}

function asApprovalSubject(value: unknown): ApprovalSubjectInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.kind !== "string" || candidate.kind === "") return undefined;
  const info: ApprovalSubjectInfo = { kind: candidate.kind };
  if (typeof candidate.host === "string") info.host = candidate.host;
  if (typeof candidate.port === "number" && Number.isFinite(candidate.port)) info.port = candidate.port;
  if (typeof candidate.protocol === "string") info.protocol = candidate.protocol;
  if (typeof candidate.command === "string") info.command = candidate.command;
  if (typeof candidate.path === "string") info.path = candidate.path;
  if (typeof candidate.access === "string") info.access = candidate.access;
  if (typeof candidate.target === "string") info.target = candidate.target;
  return info;
}

/**
 * Canonical stage key shared by parking, lookup, and dedup. The wire
 * object and a legacy string for the same stage resolve identically, so a
 * notification always finds the parked request it announces.
 */
export function approvalStageKey(approvalId: string, requirementId: unknown): string | null {
  if (typeof requirementId === "object" && requirementId !== null) {
    const ref = requirementId as Record<string, unknown>;
    if (typeof ref.approvalId === "string" && typeof ref.sourceIndex === "number") {
      return `${ref.approvalId}:${ref.sourceIndex}`;
    }
    return null;
  }
  if (typeof requirementId === "string" && requirementId !== "") {
    return `${approvalId}:${requirementId}`;
  }
  return null;
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
  if (approvalStageKey(params.approvalId, params.currentRequirementId) === null) return null;
  if (!Array.isArray(params.availableChoices)) return null;
  if (typeof params.sessionId !== "string") return null;
  if (typeof params.turnId !== "string") return null;
  if (typeof params.toolCallId !== "string") return null;
  const subject = asApprovalSubject(params.subject);
  return {
    approvalId: params.approvalId,
    currentRequirementId: params.currentRequirementId as string | ApprovalRequirementId,
    availableChoices: params.availableChoices,
    sessionId: params.sessionId,
    turnId: params.turnId,
    toolCallId: params.toolCallId,
    ...(typeof params.toolName === "string" ? { toolName: params.toolName } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(typeof params.rawArgs === "string" ? { rawArgs: params.rawArgs } : {}),
    ...(typeof params.reviewerReason === "string" ? { reviewerReason: params.reviewerReason } : {}),
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

/**
 * First-turn instruction so the model does not ask for permission in prose
 * on top of the enforced prompt (the double-ask). Attempting is safe: the
 * bridge parks the call and presents the approval itself. Never a grant,
 * never self-approval — it only removes the redundant round trip.
 */
export const APPROVAL_BRIDGE_INSTRUCTION =
  "[opencode-muse bridge instruction, not user input: tool approvals are enforced by the bridge's own prompt — do not ask the user for permission in prose, attempt the call and let the bridge present the approval. Never approve an action yourself.]";

/** A validated offer from `availableChoices`, in presented order. */
export interface ConversationalChoice {
  choiceId: string;
  label: string;
  scope: string;
  /** Human-readable preview of what this choice grants; shown verbatim apart from control/format-scalar folding and a length cap. */
  rulePreview?: string;
}

/**
 * Keep only choices with a usable verbatim label, in presented order. Some
 * MSP approvals (notably network requests) offer choices without labels;
 * when NOTHING is presentable, derive labels from the decision/scope so the
 * lettered prompt still offers exactly what Muse offered instead of failing
 * closed with nothing to pick. Choice ids stay verbatim, and matching still
 * requires an exact letter, number, or name — ambiguity never approves.
 */
export function conversationalChoices(availableChoices: readonly unknown[]): ConversationalChoice[] {
  const choices: ConversationalChoice[] = [];
  for (const entry of availableChoices) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.choiceId !== "string") continue;
    if (typeof candidate.label !== "string" || candidate.label.trim() === "") continue;
    if (typeof candidate.scope !== "string") continue;
    choices.push({
      choiceId: candidate.choiceId,
      label: candidate.label,
      scope: candidate.scope,
      ...(typeof candidate.rulePreview === "string" && candidate.rulePreview.trim() !== ""
        ? { rulePreview: candidate.rulePreview }
        : {}),
    });
  }
  if (choices.length > 0) return choices;
  for (const entry of availableChoices) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.choiceId !== "string") continue;
    const derived = candidate.decision === "approve"
      ? "Approve"
      : candidate.decision === "reject"
        ? "Deny"
        : candidate.choiceId;
    choices.push({
      choiceId: candidate.choiceId,
      label: derived,
      scope: typeof candidate.scope === "string" ? candidate.scope : "",
      ...(typeof candidate.rulePreview === "string" && candidate.rulePreview.trim() !== ""
        ? { rulePreview: candidate.rulePreview }
        : {}),
    });
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
 * Fold control and format scalars (C0/C1, line separators, bidi overrides,
 * BOM) and cap length so untrusted wire text stays one bounded display line.
 */
function displayLine(value: string, cap: number): string {
  const folded = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return folded.length > cap ? `${folded.slice(0, cap)}…` : folded;
}

/**
 * One display line naming what the approval is for, in the host's words.
 * Known kinds render their subject fields; anything else falls back to the
 * bounded raw arguments, as the MSP schema recommends for unrecognized
 * kinds. Display only — never a grant, never auto-approval.
 */
export function describeApprovalSubject(
  subject: ApprovalSubjectInfo | undefined,
  rawArgs: string | undefined,
): string | undefined {
  if (subject !== undefined) {
    switch (subject.kind) {
      case "network":
        if (subject.host !== undefined && subject.host !== "") {
          const protocol = subject.protocol !== undefined && subject.protocol !== "" ? `${subject.protocol}://` : "";
          const port = subject.port !== undefined ? `:${subject.port}` : "";
          return `${protocol}${subject.host}${port}`;
        }
        break;
      case "shell":
        if (subject.command !== undefined && subject.command !== "") return subject.command;
        break;
      case "fileAccess":
        if (subject.path !== undefined && subject.path !== "") {
          return subject.access !== undefined && subject.access !== "" ? `${subject.access} ${subject.path}` : subject.path;
        }
        break;
      case "unixSocket":
        if (subject.path !== undefined && subject.path !== "") return subject.path;
        break;
      case "process":
        if (subject.target !== undefined && subject.target !== "") return subject.target;
        break;
      default:
        break;
    }
  }
  return typeof rawArgs === "string" && rawArgs !== "" ? rawArgs : undefined;
}

/**
 * Render the choices verbatim as a lettered list with the reply contract.
 * Labeled as bridge text: the Muse transcript never sees this (the bridge
 * only forwards new user input), and the OpenCode side must not mistake it
 * for model output. When the host names a subject (destination, command,
 * path), it is shown so distinct approvals never look like the same prompt
 * repeated; each choice's `rulePreview` is shown verbatim apart from
 * control/format-scalar folding and a length cap.
 */
export function renderConversationalApprovalPrompt(input: {
  toolName?: string;
  choices: readonly ConversationalChoice[];
  attempt: number;
  received?: string;
  subject?: ApprovalSubjectInfo;
  rawArgs?: string;
  reviewerReason?: string;
}): string {
  const action = input.toolName ? `Muse wants to run \`${input.toolName}\`.` : "Muse wants to perform an action.";
  const lines = input.choices.map((choice, index) => {
    const base = `${CHOICE_LETTERS[index] ?? "?"}. ${choice.label} (${choice.scope})`;
    return choice.rulePreview !== undefined ? `${base}\n   ${displayLine(choice.rulePreview, 300)}` : base;
  });
  const contract = "Reply with one option (letter, number, or name). Anything else is asked once more, then denied.";
  const header = `**Approval needed** (opencode-muse bridge message, not the model): ${action}`;
  const target = describeApprovalSubject(input.subject, input.rawArgs);
  const context = [
    ...(target !== undefined ? [`Target: ${displayLine(target, 300)}`] : []),
    ...(input.reviewerReason !== undefined && input.reviewerReason.trim() !== ""
      ? [`Reviewer: ${displayLine(input.reviewerReason, 200)}`]
      : []),
  ];
  const body = [...context, ...lines].join("\n");
  if (input.attempt > 0 && input.received !== undefined) {
    const quoted = input.received.length > 200 ? `${input.received.slice(0, 200)}…` : input.received;
    return `${header}\nI didn't understand "${quoted}" — reply with one of:\n${body}\n${contract}`;
  }
  return `${header}\n${body}\n${contract}`;
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
    // Validated above: the key always resolves.
    const stageKey = approvalStageKey(parsed.approvalId, parsed.currentRequirementId)!;
    if (this.decided.has(stageKey)) {
      return Promise.resolve({ alreadyDecided: true as const, params: parsed });
    }
    const existing = this.pending.get(parsed.approvalId);
    if (existing) {
      const staged = existing.stages.get(stageKey);
      if (staged) {
        staged.params = parsed;
        return staged.promise;
      }
      let resolveStage!: (verdict: ApprovalVerdict) => void;
      const promise = new Promise<ApprovalVerdict>((resolve) => { resolveStage = resolve; });
      existing.stages.set(stageKey, { params: parsed, resolve: resolveStage, promise });
      return promise;
    }
    let resolveStage!: (verdict: ApprovalVerdict) => void;
    const promise = new Promise<ApprovalVerdict>((resolve) => { resolveStage = resolve; });
    const pending: PendingApproval = {
      approvalId: parsed.approvalId,
      stages: new Map([[stageKey, { params: parsed, resolve: resolveStage, promise }]]),
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
    subject?: ApprovalSubjectInfo;
    rawArgs?: string;
    reviewerReason?: string;
    turnId: string;
  }> {
    const described: Array<{
      approvalId: string;
      requirementId: string;
      choices: ConversationalChoice[];
      toolName?: string;
      subject?: ApprovalSubjectInfo;
      rawArgs?: string;
      reviewerReason?: string;
      turnId: string;
    }> = [];
    for (const pending of this.pending.values()) {
      // Stage map keys are canonical stage keys; the latest stage wins.
      const stageKeys = [...pending.stages.keys()];
      const latestKey = stageKeys[stageKeys.length - 1]!;
      const latest = pending.stages.get(latestKey)!;
      described.push({
        approvalId: pending.approvalId,
        requirementId: latestKey,
        choices: conversationalChoices(latest.params.availableChoices),
        ...(typeof latest.params.toolName === "string" ? { toolName: latest.params.toolName } : {}),
        ...(latest.params.subject !== undefined ? { subject: latest.params.subject } : {}),
        ...(latest.params.rawArgs !== undefined ? { rawArgs: latest.params.rawArgs } : {}),
        ...(latest.params.reviewerReason !== undefined ? { reviewerReason: latest.params.reviewerReason } : {}),
        turnId: latest.params.turnId,
      });
    }
    return described;
  }

  markDecided(approvalId: string, requirementId: unknown): void {
    const key = approvalStageKey(approvalId, requirementId);
    if (key !== null) this.decided.add(key);
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
