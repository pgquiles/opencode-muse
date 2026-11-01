import type { MuseModelSelection, RequestContext, ContextError, MuseRequestKind } from "../types.js";

export const MUSE_CONTEXT_HEADERS = Object.freeze({
  sessionID: "x-opencode-muse-session-id",
  directory: "x-opencode-muse-directory",
  kind: "x-opencode-muse-kind",
  modelID: "x-opencode-muse-model-id",
  providerID: "x-opencode-muse-provider-id",
  variant: "x-opencode-muse-variant",
});

const REQUEST_KINDS = new Set<MuseRequestKind>(["primary", "title", "compaction", "generate"]);

/**
 * Closed reasoning-tier vocabulary in ascending order (MSP `ReasoningEffort`
 * enum order). A requested tier the model does not offer resolves to the
 * lowest tier it does (#45); names outside this vocabulary still fail closed.
 */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** OpenCode-side alias for "no reasoning", matching Pi's thinking-level map. */
const EFFORT_OFF_ALIAS = "off";

export interface ModelRequestHookInput {
  sessionID: string;
  kind: string;
  model: {
    id: string;
    providerID: string;
    variant?: string;
  };
  headers: Record<string, string>;
}

export interface LanguageModelCallContext {
  headers?: Record<string, string | undefined>;
}

function readHeader(
  headers: Record<string, string | undefined> | undefined,
  target: string,
): string | undefined {
  if (!headers) return undefined;
  const direct = headers[target];
  if (typeof direct === "string") return direct;
  const normalized = target.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized && typeof value === "string") return value;
  }
  return undefined;
}

function contextError(code: ContextError["code"], field: string): ContextError {
  return { type: "context-error", code, field };
}

/** Stamp per-call metadata into headers proven to survive model.request → V3 call options. */
export function addRequestContextHeaders(
  headers: Record<string, string>,
  request: ModelRequestHookInput,
  directory: string,
): boolean {
  if (request.model.providerID !== "muse") return false;
  headers[MUSE_CONTEXT_HEADERS.sessionID] = request.sessionID;
  headers[MUSE_CONTEXT_HEADERS.directory] = directory;
  headers[MUSE_CONTEXT_HEADERS.kind] = request.kind;
  headers[MUSE_CONTEXT_HEADERS.modelID] = request.model.id;
  headers[MUSE_CONTEXT_HEADERS.providerID] = request.model.providerID;
  if (request.model.variant) headers[MUSE_CONTEXT_HEADERS.variant] = request.model.variant;
  else delete headers[MUSE_CONTEXT_HEADERS.variant];
  return true;
}

/** Decode only the namespaced, per-call carrier; never guess from global request state. */
export function readRequestContext(
  callOptions: LanguageModelCallContext,
  selectionIndex: ReadonlyMap<string, MuseModelSelection>,
): RequestContext | ContextError {
  const headers = callOptions.headers;
  if (!headers) return contextError("missing", "headers");

  const sessionID = readHeader(headers, MUSE_CONTEXT_HEADERS.sessionID);
  if (!sessionID) return contextError("missing", "sessionID");
  const directory = readHeader(headers, MUSE_CONTEXT_HEADERS.directory);
  if (!directory) return contextError("missing", "directory");
  const kind = readHeader(headers, MUSE_CONTEXT_HEADERS.kind);
  if (!kind) return contextError("missing", "kind");
  if (!REQUEST_KINDS.has(kind as MuseRequestKind)) return contextError("invalid", "kind");
  const modelID = readHeader(headers, MUSE_CONTEXT_HEADERS.modelID);
  if (!modelID) return contextError("missing", "modelID");
  const providerID = readHeader(headers, MUSE_CONTEXT_HEADERS.providerID);
  if (!providerID) return contextError("missing", "providerID");
  if (providerID !== "muse") return contextError("invalid", "providerID");

  const museSelection = selectionIndex.get(modelID);
  if (!museSelection) return contextError("unknown-model", "modelID");
  const rawVariant = readHeader(headers, MUSE_CONTEXT_HEADERS.variant);
  const variant = rawVariant || undefined;
  // OpenCode's default agent sends the synthetic "default" variant when the user
  // did not choose one; resolve it to the catalog row's default reasoning effort.
  const requestedVariant = variant === "default"
    ? (museSelection.defaultReasoningEffort ?? undefined)
    : variant;
  // "off" aliases "none"; everything else must name a real tier.
  const requestedTier = requestedVariant === EFFORT_OFF_ALIAS ? "none" : requestedVariant;
  let resolvedVariant = requestedTier;
  if (requestedTier !== undefined) {
    if (!EFFORT_ORDER.includes(requestedTier)) return contextError("unsupported-variant", "variant");
    if (!museSelection.variantsKnown) return contextError("unsupported-variant", "variant");
    if (!museSelection.variants.includes(requestedTier)) {
      // Known tier the model does not offer: run at the lowest tier it does.
      // Silent by decision (Pi parity); unknown-tier failures stay loud.
      const offered = museSelection.variants
        .filter((tier) => EFFORT_ORDER.includes(tier))
        .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
      if (offered.length === 0) return contextError("unsupported-variant", "variant");
      resolvedVariant = offered[0];
    }
  }

  return {
    sessionID,
    directory,
    kind: kind as MuseRequestKind,
    modelID,
    providerID,
    ...(resolvedVariant ? { variant: resolvedVariant, effort: resolvedVariant } : {}),
    museSelection,
  };
}
