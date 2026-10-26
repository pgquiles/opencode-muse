import { describe, expect, test } from "bun:test";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
  extractApprovalResponses,
  extractTurnInput,
  fingerprintVisibleTranscript,
  latestUserText,
  validateModelOptions,
  type ContextFragment,
} from "../../src/model/prompt.js";
import { fingerprintTranscript } from "../../src/session/fingerprint.js";

const userText = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as const;
const assistantText = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as const;

describe("Muse prompt extraction", () => {
  test("prompt.sendsOnlyTheNewUserMessageInsteadOfReplayingHistory", async () => {
    const previous = [userText("old request"), assistantText("old response")] as unknown as LanguageModelV3Prompt;
    const current = [...previous, userText("new request")] as unknown as LanguageModelV3Prompt;
    const result = await extractTurnInput(current, fingerprintVisibleTranscript(previous), []);

    expect(result).toMatchObject({ ok: true, parts: [{ type: "text", text: "new request" }] });
    expect(result.ok && result.nextTranscriptFingerprints).toHaveLength(3);
  });

  test("prompt.firstUseWithAnExistingTranscriptSendsOnlyTheFinalUserTurn", async () => {
    const prompt = [userText("old prompt"), assistantText("old answer"), userText("current prompt")] as unknown as LanguageModelV3Prompt;
    const result = await extractTurnInput(prompt, [], []);

    expect(result).toMatchObject({ ok: true, parts: [{ type: "text", text: "current prompt" }] });
    expect(result.ok && result.nextTranscriptFingerprints).toHaveLength(3);
  });

  test("prompt.rejectsSameLengthHistoryEditsAsDivergence", async () => {
    const previous = [userText("before"), assistantText("response")] as unknown as LanguageModelV3Prompt;
    const changed = [userText("edited"), assistantText("response"), userText("new request")] as unknown as LanguageModelV3Prompt;
    const result = await extractTurnInput(changed, fingerprintVisibleTranscript(previous), []);
    expect(result).toMatchObject({ ok: false, error: { code: "transcript-diverged" } });
  });

  test("prompt.forwardsOnlyExplicitlyAllowedContextWithLabels", async () => {
    const prompt = [
      { role: "system", content: "volatile hidden system instructions" },
      userText("new request"),
    ] as unknown as LanguageModelV3Prompt;
    const context: ContextFragment[] = [{ label: "OpenCode agent instructions", text: "Use concise responses." }];
    const result = await extractTurnInput(prompt, [], context);

    expect(result).toMatchObject({
      ok: true,
      parts: [
        { type: "text", text: "[OpenCode agent instructions]\nUse concise responses." },
        { type: "text", text: "new request" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("volatile hidden system instructions");
  });

  test("prompt.doesNotStartATurnFromContextAlone", async () => {
    const prompt = [{ role: "user", content: [] }] as unknown as LanguageModelV3Prompt;
    const result = await extractTurnInput(prompt, [], [{ label: "Agent", text: "Use terse answers." }]);
    expect(result).toMatchObject({ ok: false, error: { code: "no-new-user-input" } });
  });

  test("prompt.mapsImageBytesAndVideoUploadPayloadsWithoutFetchingUrls", async () => {
    const prompt = [{
      role: "user",
      content: [
        { type: "file", mediaType: "image/png", data: Uint8Array.from([1, 2, 3]) },
        { type: "file", mediaType: "video/mp4", data: Uint8Array.from([4, 5, 6, 7]) },
      ],
    }] as unknown as LanguageModelV3Prompt;
    const result = await extractTurnInput(prompt, [], []);

    expect(result).toMatchObject({
      ok: true,
      parts: [
        { type: "image", mediaType: "image/png", base64Data: "AQID" },
        { type: "video", mediaType: "video/mp4", base64Data: "BAUGBw==", totalBytes: 4 },
      ],
    });
  });

  test("prompt.rejectsRemoteImageAudioPdfAndOversizeDataBeforeStartingATurn", async () => {
    const remote = [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: new URL("https://example.invalid/a.png") }] }] as unknown as LanguageModelV3Prompt;
    const audio = [{ role: "user", content: [{ type: "file", mediaType: "audio/wav", data: Uint8Array.from([1]) }] }] as unknown as LanguageModelV3Prompt;
    const pdf = [{ role: "user", content: [{ type: "file", mediaType: "application/pdf", data: Uint8Array.from([1]) }] }] as unknown as LanguageModelV3Prompt;
    const large = [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: new Uint8Array(9) }] }] as unknown as LanguageModelV3Prompt;

    expect(await extractTurnInput(remote, [], [], { maxMediaBytes: 8 })).toMatchObject({ ok: false, error: { code: "remote-media" } });
    expect(await extractTurnInput(audio, [], [])).toMatchObject({ ok: false, error: { code: "unsupported-media", mediaType: "audio/wav" } });
    expect(await extractTurnInput(pdf, [], [])).toMatchObject({ ok: false, error: { code: "unsupported-media", mediaType: "application/pdf" } });
    expect(await extractTurnInput(large, [], [], { maxMediaBytes: 8 })).toMatchObject({ ok: false, error: { code: "media-too-large" } });
  });

  test("prompt.preflightCancellationStopsBeforeReturningAnyTurnInput", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await extractTurnInput([userText("cancelled") ] as unknown as LanguageModelV3Prompt, [], [], {
      signal: controller.signal,
    } as never);
    expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
  });

  test("prompt.rejectsInvalidBase64AndDoesNotLeakPayloadInErrors", async () => {
    const prompt = [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: "not base64 secret" }] }] as unknown as LanguageModelV3Prompt;
    const result = await extractTurnInput(prompt, [], []);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-media" } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("prompt.errorsDoNotEchoMalformedMediaTypeStrings", async () => {
    const prompt = [{ role: "user", content: [{ type: "file", mediaType: "private-secret", data: Uint8Array.from([1]) }] }] as unknown as LanguageModelV3Prompt;
    const result = await extractTurnInput(prompt, [], []);
    expect(result).toMatchObject({ ok: false, error: { code: "unsupported-media", mediaType: "unknown" } });
    expect(JSON.stringify(result)).not.toContain("private-secret");
  });

  test("prompt.validatesResponseFormatAndRequiredOpenCodeToolOnly", async () => {
    expect(validateModelOptions({
      responseFormat: { type: "text" },
      tools: [{ type: "function", name: "shell", inputSchema: { type: "object", properties: {} } }],
      toolChoice: { type: "auto" },
      temperature: 0.2,
      maxOutputTokens: 64,
      stopSequences: ["DONE"],
    })).toMatchObject({
      ok: true,
      options: {
        toolsIgnored: true,
        ignoredOptions: ["maxOutputTokens", "temperature", "stopSequences"],
      },
    });
    expect(validateModelOptions({ responseFormat: { type: "json", schema: { type: "object" } } }))
      .toMatchObject({ ok: false, error: { code: "unsupported-response-format" } });
    expect(validateModelOptions({ toolChoice: { type: "tool", toolName: "shell" } }))
      .toMatchObject({ ok: false, error: { code: "required-opencode-tool" } });
  });

  test("prompt.fingerprintIncludesOrderedVisibleHistoryButNotSystemBoilerplate", async () => {
    const first = [{ role: "system", content: "one" }, userText("same"), assistantText("answer")] as unknown as LanguageModelV3Prompt;
    const second = [{ role: "system", content: "changed volatile text" }, userText("same"), assistantText("answer")] as unknown as LanguageModelV3Prompt;
    expect(fingerprintVisibleTranscript(first)).toEqual(fingerprintVisibleTranscript(second));
  });

  test("prompt.fingerprintNormalizesUnicodeAndLineEndings", async () => {
    const composed = [userText("café\nnext line")] as unknown as LanguageModelV3Prompt;
    const decomposed = [userText("cafe\u0301\r\nnext line")] as unknown as LanguageModelV3Prompt;
    expect(fingerprintVisibleTranscript(composed)).toEqual(fingerprintVisibleTranscript(decomposed));
  });

  test("prompt.fingerprintExcludesReasoningAndToolTraffic", async () => {
    const first = [{
      role: "assistant",
      content: [
        { type: "text", text: "visible answer" },
        { type: "reasoning", text: "private thought one" },
        { type: "tool-call", toolCallId: "call-1", toolName: "shell", input: { command: "one" } },
      ],
    }] as unknown as LanguageModelV3Prompt;
    const second = [{
      role: "assistant",
      content: [
        { type: "text", text: "visible answer" },
        { type: "reasoning", text: "private thought two" },
        { type: "tool-call", toolCallId: "call-2", toolName: "edit", input: { path: "two" } },
      ],
    }] as unknown as LanguageModelV3Prompt;
    expect(fingerprintVisibleTranscript(first)).toEqual(fingerprintVisibleTranscript(second));
  });

  test("prompt.andSessionRegistryShareOneVisibleTranscriptFingerprintAlgorithm", async () => {
    const prompt = [userText("same line\r\nnext line"), assistantText("answer")] as unknown as LanguageModelV3Prompt;
    expect(fingerprintVisibleTranscript(prompt)).toEqual(fingerprintTranscript(prompt));
  });

  test("prompt.extractsToolApprovalResponsesFromUserMessages", async () => {
    const prompt = [{
      role: "user",
      content: [
        { type: "tool-approval-response", approvalId: "approval-1", approved: true },
        { type: "text", text: "go on" },
      ],
    }] as unknown as LanguageModelV3Prompt;
    expect(extractApprovalResponses(prompt)).toEqual([{ approvalId: "approval-1", approved: true }]);
  });

  test("prompt.peekSlicesFreshTextLikeExtraction", () => {
    const previous = [userText("old request"), assistantText("old response")] as unknown as LanguageModelV3Prompt;
    const current = [...previous, userText("a")] as unknown as LanguageModelV3Prompt;
    expect(latestUserText(current, fingerprintVisibleTranscript(previous))).toBe("a");
  });

  test("prompt.peekTakesOnlyTheLastUserMessage", () => {
    // A parked turn never advances fingerprints, so its consumed input is
    // still "new" on the next prompt: the verdict must be the fresh reply,
    // not the stale text joined with it.
    const previous = [userText("fetch it")] as unknown as LanguageModelV3Prompt;
    const current = [...previous, userText("yes"), assistantText("fetching"), userText("B")] as unknown as LanguageModelV3Prompt;
    expect(latestUserText(current, fingerprintVisibleTranscript(previous))).toBe("B");
  });

  test("prompt.peekFallsBackToTheFinalUserTurnWithoutHistory", () => {
    const prompt = [userText("old prompt"), assistantText("old answer"), userText("approved")] as unknown as LanguageModelV3Prompt;
    expect(latestUserText(prompt, [])).toBe("approved");
  });

  test("prompt.peekReturnsEmptyWhenNothingNewWasSaid", () => {
    const previous = [userText("old request"), assistantText("old response")] as unknown as LanguageModelV3Prompt;
    expect(latestUserText(previous, fingerprintVisibleTranscript(previous))).toBe("");
    const diverged = [userText("edited"), assistantText("old response")] as unknown as LanguageModelV3Prompt;
    expect(latestUserText(diverged, fingerprintVisibleTranscript(previous))).toBe("");
  });

  test("prompt.peekSkipsNonTextParts", () => {
    const prompt = [{
      role: "user",
      content: [
        { type: "text", text: "  b  " },
        { type: "file", data: "aGVsbG8=", mediaType: "application/pdf" },
      ],
    }] as unknown as LanguageModelV3Prompt;
    expect(latestUserText(prompt, [])).toBe("b");
  });

  test("prompt.ignoresMalformedApprovalResponses", async () => {
    const prompt = [{
      role: "user",
      content: [
        { type: "tool-approval-response", approvalId: 42, approved: "yes" },
        { type: "tool-approval-response", approved: true },
        { type: "tool-call", toolCallId: "call-1", toolName: "shell", input: "{}" },
      ],
    }] as unknown as LanguageModelV3Prompt;
    expect(extractApprovalResponses(prompt)).toEqual([]);
  });
});
