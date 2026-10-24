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
