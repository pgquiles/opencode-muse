import { describe, expect, test } from "bun:test";
import { MuseInvalidConfigError } from "../../src/errors.js";
import {
  TOOL_BACKEND_ENV,
  resolveToolBackend,
} from "../../src/msp/tool-backend.js";

describe("toolBackend option", () => {
  test("toolBackend.defaultsToMuseWhenUnset", () => {
    expect(resolveToolBackend(undefined)).toBe("muse");
  });

  test("toolBackend.acceptsBothBackendsCaseInsensitively", () => {
    expect(resolveToolBackend("muse")).toBe("muse");
    expect(resolveToolBackend("opencode")).toBe("opencode");
    expect(resolveToolBackend(" OpenCode ")).toBe("opencode");
  });

  test("toolBackend.rejectsAnythingElse", () => {
    for (const raw of ["both", "", "Muse,opencode", "true", "1"]) {
      let error: unknown;
      try {
        resolveToolBackend(raw);
      } catch (reason) {
        error = reason;
      }
      expect(error).toBeInstanceOf(MuseInvalidConfigError);
    }
  });

  test("toolBackend.envNameIsNamespaced", () => {
    expect(TOOL_BACKEND_ENV).toBe("OPENCODE_MUSE_TOOL_BACKEND");
  });
});

describe("tool-result extraction", () => {
  test("toolResults.collectsMatchingToolResults", async () => {
    const { extractToolResults } = await import("../../src/model/prompt.js");
    const prompt = [
      { role: "user", content: [{ type: "text", text: "write it" }] },
      { role: "assistant", content: [{ type: "text", text: "working" }] },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "mc_1", output: { type: "text", text: "written" } },
          { type: "tool-result", toolCallId: "mc_2", output: "plain" },
        ],
      },
    ];

    expect(extractToolResults(prompt)).toEqual([
      { toolCallId: "mc_1", outputText: "written" },
      { toolCallId: "mc_2", outputText: "plain" },
    ]);
  });

  test("toolResults.ignoresNonToolMessagesAndMalformedResults", async () => {
    const { extractToolResults } = await import("../../src/model/prompt.js");
    const prompt = [
      { role: "user", content: [{ type: "text", text: "write it" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "mc_1", toolName: "w", input: "{}" }] },
      { role: "tool", content: [{ type: "tool-result", output: { type: "text", text: "no id" } }] },
      { role: "tool", content: "not-parts" },
    ];

    expect(extractToolResults(prompt)).toEqual([]);
  });
});
