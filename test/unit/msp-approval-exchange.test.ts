import { describe, expect, test } from "bun:test";
import { ApprovalExchange, type ApprovalRequestParams } from "../../src/msp/approvals.js";

function request(overrides: Partial<ApprovalRequestParams> = {}): ApprovalRequestParams {
  return {
    approvalId: "approval-1",
    currentRequirementId: "req-1",
    availableChoices: [],
    sessionId: "ses-1",
    turnId: "turn-1",
    toolCallId: "call-1",
    ...overrides,
  };
}

describe("approvals.ApprovalExchange", () => {
  test("first request for a stage parks and awaits the verdict", async () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    let settled = false;
    const pending = exchange.requestApproval(request());
    void pending.then(() => { settled = true; });
    expect(exchange.pendingApprovalIds()).toEqual(["approval-1"]);
    expect(settled).toBe(false);
    expect(exchange.settle("approval-1", true)).toBe(true);
    const verdict = await pending;
    expect(verdict).toEqual({ approved: true, params: request() });
    expect(settled).toBe(true);
    expect(exchange.pendingApprovalIds()).toEqual([]);
  });

  test("duplicate request for the same stage does not re-park", async () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    const first = exchange.requestApproval(request());
    const second = exchange.requestApproval(request());
    expect(exchange.pendingApprovalIds()).toEqual(["approval-1"]);
    expect(second).toBe(first);
    exchange.settle("approval-1", false);
    await first;
    await second;
  });

  test("new requirement id opens a new stage", async () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    const first = exchange.requestApproval(request());
    const second = exchange.requestApproval(request({ currentRequirementId: "req-2" }));
    expect(second).not.toBe(first);
    expect(exchange.pendingApprovalIds()).toEqual(["approval-1"]);
    exchange.settle("approval-1", true);
    await first;
    await second;
  });

  test("settle before any request is dropped as stale", () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    expect(exchange.settle("approval-unknown", true)).toBe(false);
  });

  test("pending approvals report their parked turn", async () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    const pending = exchange.requestApproval(request({ turnId: "turn-7" }));
    expect(exchange.pendingApprovalTurnId("approval-1")).toBe("turn-7");
    expect(exchange.pendingApprovalTurnId("approval-unknown")).toBeUndefined();
    exchange.settle("approval-1", true);
    await pending;
    expect(exchange.pendingApprovalTurnId("approval-1")).toBeUndefined();
  });

  test("verdict wait times out as denied", async () => {
    const exchange = new ApprovalExchange({ timeoutMs: 5 });
    const verdict = await exchange.requestApproval(request());
    expect(verdict).toEqual({ approved: false, timedOut: true, params: request() });
    expect(exchange.pendingApprovalIds()).toEqual([]);
  });

  test("late settle after timeout is dropped as stale", async () => {
    const exchange = new ApprovalExchange({ timeoutMs: 5 });
    await exchange.requestApproval(request());
    expect(exchange.settle("approval-1", true)).toBe(false);
  });

  test("decided stages never re-park", async () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    const pending = exchange.requestApproval(request());
    exchange.settle("approval-1", true);
    await pending;
    exchange.markDecided("approval-1", "req-1");
    const replay = exchange.requestApproval(request());
    await expect(replay).resolves.toEqual({ alreadyDecided: true, params: request() });
    expect(exchange.pendingApprovalIds()).toEqual([]);
  });

  test("malformed requests are refused without parking", async () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    await expect(exchange.requestApproval({} as ApprovalRequestParams)).rejects.toThrow("unroutable-approval-request");
    expect(exchange.pendingApprovalIds()).toEqual([]);
  });

  test("wire object requirement ids park under a canonical stage key", async () => {
    // The MSP wire sends currentRequirementId as { approvalId, sourceIndex },
    // never a string: a real approval/request must park, not drop.
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    const wire = request({
      currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
      availableChoices: [{ choiceId: "allow-once", decision: "approve", label: "Allow once", scope: "once" }],
    });
    let settled = false;
    const pending = exchange.requestApproval(wire);
    void pending.then(() => { settled = true; });
    expect(exchange.pendingApprovalIds()).toEqual(["approval-1"]);
    expect(settled).toBe(false);
    const described = exchange.describePending();
    expect(described).toHaveLength(1);
    expect(described[0]?.requirementId).toBe("approval-1:0");
    expect(described[0]?.choices).toEqual([{ choiceId: "allow-once", label: "Allow once", scope: "once" }]);
    expect(exchange.settle("approval-1", true)).toBe(true);
    const verdict = await pending;
    expect(verdict).toMatchObject({ approved: true });
    expect(settled).toBe(true);
  });

  test("distinct wire stages park alongside each other", async () => {
    const exchange = new ApprovalExchange({ timeoutMs: 50 });
    const first = exchange.requestApproval(request({
      currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
    }));
    const second = exchange.requestApproval(request({
      currentRequirementId: { approvalId: "approval-1", sourceIndex: 1 },
    }));
    expect(second).not.toBe(first);
    // describePending reports the latest stage per approval.
    expect(exchange.describePending().map((entry) => entry.requirementId))
      .toEqual(["approval-1:1"]);
    exchange.settle("approval-1", true);
    await first;
    await second;
  });
});
