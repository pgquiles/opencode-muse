import { matchConversationalChoice } from "./approvals.js";

/**
 * Conversational answers for structured `userInput` option-questions (#31).
 * Mirrors the approval flow: prompt verbatim, match exactly one option,
 * re-ask once, then cancel with a reason. Multi-select and free-text
 * inference are out of v1 scope and cancel with a reason instead.
 */

const CHOICE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface UserInputOption {
  label: string;
  description?: string;
}

export interface UserInputSelection {
  mode?: string;
  minSelections?: number;
  maxSelections?: number;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputOption[];
  selection?: UserInputSelection;
}

export interface UserInputAnswer {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
}

/** Multi-select when the mode says multiple or more than one pick is allowed. */
/**
 * Validate conversational answers against the offered questions before
 * sending. Every answer names a real question and only verbatim offered
 * labels; anything else fails closed to `userInput/cancel`.
 */
export function validUserInputAnswers(
  questions: readonly UserInputQuestion[],
  answers: readonly UserInputAnswer[]
): boolean {
  if (answers.length === 0) return false;
  const byId = new Map(questions.map((question) => [question.id, question]));
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question) return false;
    const offered = new Set(question.options.map((option) => option.label));
    if (answer.selectedLabel !== undefined && !offered.has(answer.selectedLabel)) return false;
    if (answer.selectedLabels !== undefined) {
      if (!Array.isArray(answer.selectedLabels)) return false;
      const seen = new Set<string>();
      for (const label of answer.selectedLabels) {
        if (typeof label !== "string" || !offered.has(label) || seen.has(label)) return false;
        seen.add(label);
      }
    }
    if (answer.selectedLabel === undefined && answer.selectedLabels === undefined) return false;
  }
  return true;
}

/**
 * The oldest question a lettered prompt can actually collect: validated
 * labels, at least one option, single-select. Anything else cancels with
 * a reason instead of guessing.
 */
export function presentableQuestion(value: unknown): UserInputQuestion | null {
  const question = asQuestion(value);
  if (!question || question.options.length === 0) return null;
  if (isMultiSelectQuestion(question.selection)) return null;
  return question;
}

export function isMultiSelectQuestion(selection: UserInputSelection | undefined): boolean {
  if (!selection) return false;
  if (typeof selection.mode === "string" && selection.mode.toLowerCase().includes("multi")) return true;
  return typeof selection.maxSelections === "number" && selection.maxSelections > 1;
}

/**
 * Render one question verbatim with lettered options. Labeled as bridge text:
 * the Muse transcript never sees it (the bridge only forwards new user
 * input), and the OpenCode side must not mistake it for model output.
 */
export function renderConversationalQuestionPrompt(input: {
  question: Pick<UserInputQuestion, "header" | "question" | "options">;
  toolName?: string;
  attempt: number;
  received?: string;
}): string {
  const lines = input.question.options.map((option, index) => {
    const suffix = typeof option.description === "string" && option.description !== "" ? ` — ${option.description}` : "";
    return `${CHOICE_LETTERS[index] ?? "?"}. ${option.label}${suffix}`;
  });
  const contract = "Reply with one option (letter, number, or name). Anything else is asked once more, then the request is cancelled.";
  const action = input.toolName ? ` while running \`${input.toolName}\`` : "";
  const header = `**Question** (opencode-muse bridge message, not the model)${action}: ${input.question.header}\n${input.question.question}`;
  if (input.attempt > 0 && input.received !== undefined) {
    const quoted = input.received.length > 200 ? `${input.received.slice(0, 200)}…` : input.received;
    return `${header}\nI didn't understand "${quoted}" — reply with one of:\n${lines.join("\n")}\n${contract}`;
  }
  return `${header}\n${lines.join("\n")}\n${contract}`;
}

export { matchConversationalChoice };

export interface UserInputRequestParams {
  userInputId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName?: string;
  itemId: string;
  viewCursor: string;
  questions: UserInputQuestion[];
}

export type UserInputVerdict =
  | { answers: UserInputAnswer[]; params: UserInputRequestParams }
  | { cancelled: true; params: UserInputRequestParams }
  | { timedOut: true; params: UserInputRequestParams }
  | { alreadyDecided: true; params: UserInputRequestParams };

function asQuestion(value: unknown): UserInputQuestion | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string") return null;
  if (typeof candidate.header !== "string") return null;
  if (typeof candidate.question !== "string") return null;
  if (!Array.isArray(candidate.options)) return null;
  const options: UserInputOption[] = [];
  for (const entry of candidate.options) {
    if (typeof entry !== "object" || entry === null) continue;
    const option = entry as Record<string, unknown>;
    if (typeof option.label !== "string" || option.label.trim() === "") continue;
    options.push({
      label: option.label,
      ...(typeof option.description === "string" ? { description: option.description } : {}),
    });
  }
  const selection = candidate.selection;
  return {
    id: candidate.id,
    header: candidate.header,
    question: candidate.question,
    options,
    ...(typeof selection === "object" && selection !== null
      ? {
        selection: {
          ...((selection as Record<string, unknown>).mode !== undefined
            ? { mode: (selection as Record<string, unknown>).mode as string }
            : {}),
          ...((selection as Record<string, unknown>).minSelections !== undefined
            ? { minSelections: (selection as Record<string, unknown>).minSelections as number }
            : {}),
          ...((selection as Record<string, unknown>).maxSelections !== undefined
            ? { maxSelections: (selection as Record<string, unknown>).maxSelections as number }
            : {}),
        },
      }
      : {}),
  };
}

function asRequestParams(value: unknown): UserInputRequestParams | null {
  if (typeof value !== "object" || value === null) return null;
  const params = value as Record<string, unknown>;
  if (typeof params.userInputId !== "string") return null;
  if (typeof params.sessionId !== "string") return null;
  if (typeof params.turnId !== "string") return null;
  if (typeof params.toolCallId !== "string") return null;
  if (typeof params.itemId !== "string") return null;
  if (typeof params.viewCursor !== "string") return null;
  if (!Array.isArray(params.questions)) return null;
  const questions = params.questions.map(asQuestion).filter((question): question is UserInputQuestion => question !== null);
  return {
    userInputId: params.userInputId,
    sessionId: params.sessionId,
    turnId: params.turnId,
    toolCallId: params.toolCallId,
    itemId: params.itemId,
    viewCursor: params.viewCursor,
    ...(typeof params.toolName === "string" ? { toolName: params.toolName } : {}),
    questions,
  };
}

interface PendingStage {
  params: UserInputRequestParams;
  resolve: (verdict: UserInputVerdict) => void;
  promise: Promise<UserInputVerdict>;
}

interface PendingUserInput {
  userInputId: string;
  stage: PendingStage;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Conversational answer attempts consumed; re-ask once, then cancel. */
  answerAttempts?: number;
  /** Answers recorded across turns; sent once every question is answered. */
  answers: UserInputAnswer[];
}

/**
 * Per-session latch for MSP userInput round trips. One verdict per request;
 * late verdicts for settled requests are dropped as stale. Mirrors the
 * approval exchange without its requirement-id stages: a userInput request
 * carries its own id and no advancing requirement.
 */
export class UserInputExchange {
  private readonly pending = new Map<string, PendingUserInput>();
  private readonly decided = new Set<string>();
  constructor(private readonly options: { timeoutMs: number } = { timeoutMs: 10 * 60 * 1000 }) {}

  pendingUserInputIds(): string[] {
    return [...this.pending.keys()];
  }

  requestUserInput(params: unknown): Promise<UserInputVerdict> {
    const parsed = asRequestParams(params);
    if (parsed === null) return Promise.reject(new Error("unroutable-user-input-request"));
    if (this.decided.has(parsed.userInputId)) {
      return Promise.resolve({ alreadyDecided: true as const, params: parsed });
    }
    const existing = this.pending.get(parsed.userInputId);
    if (existing) {
      existing.stage.params = parsed;
      return existing.stage.promise;
    }
    let resolveStage!: (verdict: UserInputVerdict) => void;
    const promise = new Promise<UserInputVerdict>((resolve) => { resolveStage = resolve; });
    const pending: PendingUserInput = {
      userInputId: parsed.userInputId,
      stage: { params: parsed, resolve: resolveStage, promise },
      timer: undefined,
      answers: [],
    };
    pending.timer = setTimeout(() => this.timeOut(parsed.userInputId), this.options.timeoutMs);
    this.pending.set(parsed.userInputId, pending);
    return promise;
  }

  settleAnswer(userInputId: string, answers: UserInputAnswer[]): boolean {
    const pending = this.pending.get(userInputId);
    if (!pending) return false;
    this.clear(userInputId);
    pending.stage.resolve({ answers, params: pending.stage.params });
    return true;
  }

  /**
   * Resolve a parked request as cancelled (second miss, unpresentable
   * schema, or stale state). The host sends `userInput/cancel`.
   */
  settleCancelled(userInputId: string): boolean {
    const pending = this.pending.get(userInputId);
    if (!pending) return false;
    this.clear(userInputId);
    pending.stage.resolve({ cancelled: true as const, params: pending.stage.params });
    return true;
  }

  markDecided(userInputId: string): void {
    this.decided.add(userInputId);
    this.clear(userInputId);
  }

  /**
   * Consume one conversational answer attempt for a pending request.
   * Returns the zero-based attempt index, or -1 when nothing pends.
   */
  noteVerdictAttempt(userInputId: string): number {
    const pending = this.pending.get(userInputId);
    if (!pending) return -1;
    const attempts = pending.answerAttempts ?? 0;
    pending.answerAttempts = attempts + 1;
    return attempts;
  }

  /**
   * Record one conversational answer. Returns the accumulated answers and
   * the number of still-unanswered questions, or null when the request or
   * the question is unknown.
   */
  appendAnswer(userInputId: string, answer: UserInputAnswer): { remaining: number; answers: UserInputAnswer[] } | null {
    const pending = this.pending.get(userInputId);
    if (!pending) return null;
    if (!pending.stage.params.questions.some((question) => question.id === answer.questionId)) return null;
    if (!pending.answers.some((recorded) => recorded.questionId === answer.questionId)) {
      pending.answers.push(answer);
    }
    const answered = new Set(pending.answers.map((recorded) => recorded.questionId));
    const remaining = pending.stage.params.questions.filter((question) => !answered.has(question.id)).length;
    return { remaining, answers: [...pending.answers] };
  }

  /** Pending requests in arrival order with validated questions and recorded answers. */
  describePending(): Array<{
    userInputId: string;
    turnId: string;
    toolName?: string;
    questions: UserInputQuestion[];
    answeredQuestionIds: string[];
    answers: UserInputAnswer[];
  }> {
    return [...this.pending.values()].map((pending) => ({
      userInputId: pending.userInputId,
      turnId: pending.stage.params.turnId,
      ...(pending.stage.params.toolName ? { toolName: pending.stage.params.toolName } : {}),
      questions: pending.stage.params.questions,
      answeredQuestionIds: pending.answers.map((answer) => answer.questionId),
      answers: [...pending.answers],
    }));
  }

  private timeOut(userInputId: string): void {
    const pending = this.pending.get(userInputId);
    if (!pending) return;
    this.clear(userInputId);
    pending.stage.resolve({ timedOut: true as const, params: pending.stage.params });
  }

  private clear(userInputId: string): void {
    const pending = this.pending.get(userInputId);
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    this.pending.delete(userInputId);
  }
}
