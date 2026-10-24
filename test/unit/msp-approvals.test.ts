import { describe, expect, test } from "bun:test";
import { selectApprovalChoiceId } from "../../src/msp/approvals.js";

function choice(choiceId: unknown, decision: unknown, scope: unknown): Record<string, unknown> {
  return { choiceId, decision, label: `${String(decision)} ${String(scope)}`, scope };
}

describe("approvals.selectApprovalChoiceId", () => {
  test("approved picks the once-scoped approve choice", () => {
    expect(selectApprovalChoiceId([
      choice("a-once", "approve", "once"),
      choice("b-session", "approve", "session"),
      choice("c-reject", "reject", "once"),
    ], true)).toBe("a-once");
  });

  test("approved falls back to a session-scoped approve choice", () => {
    expect(selectApprovalChoiceId([
      choice("b-session", "approve", "session"),
      choice("c-reject", "reject", "once"),
    ], true)).toBe("b-session");
  });

  test("approved never selects a persistent choice", () => {
    expect(selectApprovalChoiceId([
      choice("p-persist", "approve", "localPersistent"),
      choice("c-reject", "reject", "once"),
    ], true)).toBeNull();
  });

  test("approved with no approve choice returns null", () => {
    expect(selectApprovalChoiceId([choice("c-reject", "reject", "once")], true)).toBeNull();
  });

  test("approved with two once approve choices returns null", () => {
    expect(selectApprovalChoiceId([
      choice("a-one", "approve", "once"),
      choice("a-two", "approve", "once"),
    ], true)).toBeNull();
  });

  test("malformed choices are ignored", () => {
    expect(selectApprovalChoiceId([
      { label: "no id", decision: "approve", scope: "once" },
      { choiceId: 42, decision: "approve", scope: "once" },
      { choiceId: "ok", decision: "approve", scope: "once" },
    ], true)).toBe("ok");
    expect(selectApprovalChoiceId([
      { label: "no id", decision: "approve", scope: "once" },
      null,
      "approve-once",
    ], true)).toBeNull();
  });

  test("denied picks the reject choice", () => {
    expect(selectApprovalChoiceId([
      choice("a-once", "approve", "once"),
      choice("c-reject", "reject", "once"),
    ], false)).toBe("c-reject");
  });

  test("denied with no reject choice returns null instead of inventing one", () => {
    expect(selectApprovalChoiceId([choice("a-once", "approve", "once")], false)).toBeNull();
  });

  test("denied never selects a persistent reject choice", () => {
    expect(selectApprovalChoiceId([
      choice("a-once", "approve", "once"),
      choice("p-reject", "reject", "localPersistent"),
    ], false)).toBeNull();
  });

  test("denied prefers the once-scoped reject choice", () => {
    expect(selectApprovalChoiceId([
      choice("c-one", "reject", "once"),
      choice("c-two", "reject", "session"),
    ], false)).toBe("c-one");
  });

  test("denied with two once reject choices returns null", () => {
    expect(selectApprovalChoiceId([
      choice("c-one", "reject", "once"),
      choice("c-two", "reject", "once"),
    ], false)).toBeNull();
  });

  test("approved with two session approve choices returns null", () => {
    expect(selectApprovalChoiceId([
      choice("b-one", "approve", "session"),
      choice("b-two", "approve", "session"),
    ], true)).toBeNull();
  });
});
