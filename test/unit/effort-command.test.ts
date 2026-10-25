import { describe, expect, test } from "bun:test";
import { createEffortCommandHandler } from "../../src/session/effort-command.js";

function handler() {
  const pins = new Map<string, string>();
  const command = createEffortCommandHandler({
    setEffortPin: (sessionID: string, variant: string) => { pins.set(sessionID, variant); },
  });
  return { execute: command.execute, pins };
}

function invocation(prompt: unknown) {
  return { sessionID: "ses_oc_1", prompt, delivery: "none" } as unknown as Parameters<ReturnType<typeof createEffortCommandHandler>["execute"]>[0];
}

describe("effort command", () => {
  test("effortCommand.pinsMinimalWhenBare", async () => {
    const { execute, pins } = handler();

    await execute(invocation(""));
    await execute(invocation("   "));

    expect(pins.get("ses_oc_1")).toBe("minimal");
  });

  test("effortCommand.pinsTheRequestedTier", async () => {
    const { execute, pins } = handler();

    await execute(invocation(" High "));

    expect(pins.get("ses_oc_1")).toBe("high");
  });

  test("effortCommand.rejectsUnknownTiersWithoutPinning", async () => {
    const { execute, pins } = handler();

    await expect(execute(invocation("ultra"))).rejects.toThrow(/minimal, low, medium, high, xhigh, max/);
    await expect(execute(invocation("default"))).rejects.toThrow(/minimal/);
    expect(pins.has("ses_oc_1")).toBe(false);
  });

  test("effortCommand.treatsNonTextInputAsBare", async () => {
    const { execute, pins } = handler();

    await execute(invocation(undefined));

    expect(pins.get("ses_oc_1")).toBe("minimal");
  });
});
