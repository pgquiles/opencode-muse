import { describe, expect, test } from "bun:test";
import { EFFORT_VARIANTS, explicitVariant, parseEffortVariant } from "../../src/model/effort.js";

describe("effort variants", () => {
  test("effort.advertisesExactlyTheSixConcreteTiers", () => {
    expect([...EFFORT_VARIANTS]).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  test("effort.parsesTheSixTiersCaseInsensitively", () => {
    expect(parseEffortVariant("High")).toBe("high");
    expect(parseEffortVariant("  xhigh\t")).toBe("xhigh");
    expect(parseEffortVariant("MINIMAL")).toBe("minimal");
  });

  test("effort.rejectsUnknownTiersAndNonText", () => {
    expect(parseEffortVariant("default")).toBeNull();
    expect(parseEffortVariant("ultra")).toBeNull();
    expect(parseEffortVariant("")).toBeNull();
    expect(parseEffortVariant(undefined)).toBeNull();
    expect(parseEffortVariant(42)).toBeNull();
  });

  test("effort.readsOnlyExplicitHeaderVariants", () => {
    expect(explicitVariant(undefined)).toBeUndefined();
    expect(explicitVariant({})).toBeUndefined();
    expect(explicitVariant({ "x-opencode-muse-variant": "default" })).toBeUndefined();
    expect(explicitVariant({ "x-opencode-muse-variant": "high" })).toBe("high");
  });
});
