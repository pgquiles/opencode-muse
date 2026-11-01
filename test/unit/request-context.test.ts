import { describe, expect, test } from "bun:test";
import {
  MUSE_CONTEXT_HEADERS,
  addRequestContextHeaders,
  readRequestContext,
} from "../../src/model/context.js";
import { openCodeModelId } from "../../src/catalog.js";
import type { MuseModelSelection } from "../../src/types.js";

const modelId = openCodeModelId("tbh", "muse-wonder-1.0");
const selection: MuseModelSelection = {
  providerId: "meta",
  profileId: "tbh",
  modelId: "muse-wonder-1.0",
  isActive: false,
  isDefault: true,
  defaultReasoningEffort: "high",
  variantsKnown: true,
  variants: ["minimal", "high", "max"],
};
const index = new Map([[modelId, selection]]);

describe("request context", () => {
  test("context.stampsNamespacedHeadersAndResolvesProfileFromCatalog", () => {
    const headers: Record<string, string> = { authorization: "untouched" };
    const request = {
      sessionID: "ses_one",
      kind: "primary",
      model: { id: modelId, providerID: "muse", variant: "max" },
      headers,
    };

    expect(addRequestContextHeaders(headers, request, "/workspace/project")).toBe(true);
    expect(headers.authorization).toBe("untouched");
    const context = readRequestContext({ headers }, index);
    expect(context).toMatchObject({
      sessionID: "ses_one",
      directory: "/workspace/project",
      kind: "primary",
      modelID: modelId,
      providerID: "muse",
      variant: "max",
      museSelection: { providerId: "meta", profileId: "tbh", modelId: "muse-wonder-1.0" },
      effort: "max",
    });
  });

  test("context.doesNotMutateHeadersForOtherProviders", () => {
    const headers: Record<string, string> = { "x-existing": "kept" };
    const handled = addRequestContextHeaders(headers, {
      sessionID: "ses_other",
      kind: "primary",
      model: { id: "model", providerID: "openai" },
      headers,
    }, "/workspace");

    expect(handled).toBe(false);
    expect(headers).toEqual({ "x-existing": "kept" });
  });

  test("context.returnsErrorsInsteadOfGuessingMissingMetadata", () => {
    const result = readRequestContext({ headers: undefined }, index);
    expect(result).toMatchObject({ type: "context-error", code: "missing", field: "headers" });
  });

  test("context.rejectsUnknownModelAndFallsBackOnUnadvertisedTier", () => {
    const unknownHeaders = {
      [MUSE_CONTEXT_HEADERS.sessionID]: "ses_one",
      [MUSE_CONTEXT_HEADERS.directory]: "/workspace",
      [MUSE_CONTEXT_HEADERS.kind]: "primary",
      [MUSE_CONTEXT_HEADERS.modelID]: "not-in-catalog",
      [MUSE_CONTEXT_HEADERS.providerID]: "muse",
    };
    expect(readRequestContext({ headers: unknownHeaders }, index)).toMatchObject({ code: "unknown-model" });

    const variantHeaders = { ...unknownHeaders, [MUSE_CONTEXT_HEADERS.modelID]: modelId, [MUSE_CONTEXT_HEADERS.variant]: "ultra" };
    const ultra = readRequestContext({ headers: variantHeaders }, index);
    expect(ultra).toMatchObject({ variant: "minimal", effort: "minimal" });
  });

  test("context.stillFailsClosedOnGenuinelyUnknownTierNames", () => {
    const headers = {
      [MUSE_CONTEXT_HEADERS.sessionID]: "ses_one",
      [MUSE_CONTEXT_HEADERS.directory]: "/workspace",
      [MUSE_CONTEXT_HEADERS.kind]: "primary",
      [MUSE_CONTEXT_HEADERS.modelID]: modelId,
      [MUSE_CONTEXT_HEADERS.providerID]: "muse",
      [MUSE_CONTEXT_HEADERS.variant]: "turbo",
    };
    expect(readRequestContext({ headers }, index)).toMatchObject({ code: "unsupported-variant" });
  });

  test("context.fallsBackToLowestOfferedTier", () => {
    const makeHeaders = (variant: string) => ({
      [MUSE_CONTEXT_HEADERS.sessionID]: "ses_one",
      [MUSE_CONTEXT_HEADERS.directory]: "/workspace",
      [MUSE_CONTEXT_HEADERS.kind]: "primary",
      [MUSE_CONTEXT_HEADERS.modelID]: modelId,
      [MUSE_CONTEXT_HEADERS.providerID]: "muse",
      [MUSE_CONTEXT_HEADERS.variant]: variant,
    });
    // "off" aliases "none"; this row offers no "none", so both land on minimal.
    expect(readRequestContext({ headers: makeHeaders("off") }, index)).toMatchObject({ variant: "minimal", effort: "minimal" });
    expect(readRequestContext({ headers: makeHeaders("none") }, index)).toMatchObject({ variant: "minimal", effort: "minimal" });
    // A default that names an unoffered tier falls back the same way.
    const highDefault: MuseModelSelection = { ...selection, defaultReasoningEffort: "xhigh" };
    const highIndex = new Map([[modelId, highDefault]]);
    expect(readRequestContext({ headers: makeHeaders("default") }, highIndex)).toMatchObject({ variant: "minimal", effort: "minimal" });
  });

  test("context.keepsOfferedNoneTierInsteadOfFallingBack", () => {
    const noneOffered: MuseModelSelection = { ...selection, variants: ["none", "minimal", "high", "max"] };
    const noneIndex = new Map([[modelId, noneOffered]]);
    const headers = {
      [MUSE_CONTEXT_HEADERS.sessionID]: "ses_one",
      [MUSE_CONTEXT_HEADERS.directory]: "/workspace",
      [MUSE_CONTEXT_HEADERS.kind]: "primary",
      [MUSE_CONTEXT_HEADERS.modelID]: modelId,
      [MUSE_CONTEXT_HEADERS.providerID]: "muse",
      [MUSE_CONTEXT_HEADERS.variant]: "off",
    };
    expect(readRequestContext({ headers }, noneIndex)).toMatchObject({ variant: "none", effort: "none" });
  });

  test("context.resolvesOpenCodeDefaultVariantToModelDefaultEffort", () => {
    const headers = {
      [MUSE_CONTEXT_HEADERS.sessionID]: "ses_default",
      [MUSE_CONTEXT_HEADERS.directory]: "/workspace",
      [MUSE_CONTEXT_HEADERS.kind]: "primary",
      [MUSE_CONTEXT_HEADERS.modelID]: modelId,
      [MUSE_CONTEXT_HEADERS.providerID]: "muse",
      [MUSE_CONTEXT_HEADERS.variant]: "default",
    };

    const context = readRequestContext({ headers }, index);
    expect(context).not.toMatchObject({ type: "context-error" });
    expect(context).toMatchObject({
      kind: "primary",
      variant: "high",
      effort: "high",
      museSelection: { modelId: "muse-wonder-1.0" },
    });
  });

  test("context.treatsDefaultVariantWithoutADeclaredDefaultAsUnspecifiedEffort", () => {
    // Ruling: OpenCode's "default" marker means the user chose no variant; when
    // the Muse row declares no defaultReasoningEffort, the turn runs on Muse's
    // own default effort instead of failing the OpenCode request loop.
    const noDefault: MuseModelSelection = { ...selection };
    delete (noDefault as { defaultReasoningEffort?: string }).defaultReasoningEffort;
    const centeredIndex = new Map([[modelId, noDefault]]);
    const headers = {
      [MUSE_CONTEXT_HEADERS.sessionID]: "ses_default",
      [MUSE_CONTEXT_HEADERS.directory]: "/workspace",
      [MUSE_CONTEXT_HEADERS.kind]: "primary",
      [MUSE_CONTEXT_HEADERS.modelID]: modelId,
      [MUSE_CONTEXT_HEADERS.providerID]: "muse",
      [MUSE_CONTEXT_HEADERS.variant]: "default",
    };

    const context = readRequestContext({ headers }, centeredIndex);
    expect(context).not.toMatchObject({ type: "context-error" });
    expect(context).toMatchObject({ kind: "primary" });
    expect((context as { variant?: string }).variant).toBeUndefined();
    expect((context as { effort?: string }).effort).toBeUndefined();
  });

  test("context.acceptsMetaRequestKindsAndIsolatesConcurrentSessions", () => {
    const makeHeaders = (sessionID: string, kind: string) => ({
      [MUSE_CONTEXT_HEADERS.sessionID]: sessionID,
      [MUSE_CONTEXT_HEADERS.directory]: `/workspace/${sessionID}`,
      [MUSE_CONTEXT_HEADERS.kind]: kind,
      [MUSE_CONTEXT_HEADERS.modelID]: modelId,
      [MUSE_CONTEXT_HEADERS.providerID]: "muse",
    });
    const first = readRequestContext({ headers: makeHeaders("ses_a", "title") }, index);
    const second = readRequestContext({ headers: makeHeaders("ses_b", "compaction") }, index);

    expect(first).toMatchObject({ sessionID: "ses_a", kind: "title" });
    expect(second).toMatchObject({ sessionID: "ses_b", kind: "compaction" });
  });

  test("context.contextFreeGenerateDoesNotAttachToALatestSession", () => {
    const result = readRequestContext({ headers: {} }, index);
    expect(result).toMatchObject({ type: "context-error", code: "missing" });
    expect(MUSE_CONTEXT_HEADERS.sessionID).toContain("x-opencode-muse-");
  });
});
