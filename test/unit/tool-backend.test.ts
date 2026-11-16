import { describe, expect, test } from "bun:test";
import { MuseInvalidConfigError } from "../../src/errors.js";
import {
  TOOL_BACKEND_ENV,
  checkOpencodeBackendCliSupport,
  resolveToolBackend,
} from "../../src/msp/tool-backend.js";

const FINGERPRINT_1_4_14 = "sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6";
const FINGERPRINT_1_4_20 = "sha256:283b1b125dcc9172928fb5d6711a92a353796d030a7c186988ed527a13cf07f0";

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

describe("opencodeBackendCliSupport", () => {
  test("cliSupport.admitsVerifiedFingerprint", () => {
    expect(() => checkOpencodeBackendCliSupport(FINGERPRINT_1_4_14)).not.toThrow();
  });

  test("cliSupport.rejectsUnverifiedFingerprint", () => {
    let error: unknown;
    try {
      checkOpencodeBackendCliSupport(FINGERPRINT_1_4_20);
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(MuseInvalidConfigError);
    expect(String((error as Error).message)).toContain("opencode tool backend");
    expect(String((error as Error).message)).toContain(FINGERPRINT_1_4_20);
    expect(String((error as Error).message)).toContain("issues/58");
  });

  test("cliSupport.rejectsMissingOrMalformedFingerprint", () => {
    for (const raw of [undefined, null, "", 42, {}]) {
      let error: unknown;
      try {
        checkOpencodeBackendCliSupport(raw);
      } catch (reason) {
        error = reason;
      }
      expect(error).toBeInstanceOf(MuseInvalidConfigError);
    }
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
