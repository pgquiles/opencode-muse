import { describe, expect, test } from "bun:test";
import { createProviderPlugin } from "../../src/provider.js";
import { createMuse } from "../../src/index.js";
import type { MuseCatalogSnapshot } from "../../src/catalog.js";
import { fingerprintCompactionOutput } from "../../src/session/fingerprint.js";

function liveCatalog(): MuseCatalogSnapshot {
  return {
    providerId: "meta",
    profileId: "tbh",
    source: "providerCatalog",
    models: [{
      providerId: "meta",
      profileId: "tbh",
      modelId: "muse-wonder-1.0",
      displayLabel: "Muse Wonder 1.0",
      contextLimit: 1_007_997,
      outputLimit: 128_000,
      releaseDate: "2026-10-12",
      isActive: false,
      isDefault: true,
      defaultReasoningEffort: "high",
      variants: ["minimal", "low", "medium", "high", "xhigh", "max"],
      reasoningEffortVariants: [],
      cost: null,
    }],
  };
}

function fakeContext() {
  let transform: ((editor: { add(input: { info: Record<string, unknown>; models: readonly Record<string, unknown>[] }): void }) => void) | undefined;
  const registrations: Array<{ info: Record<string, unknown>; models: readonly Record<string, unknown>[] }> = [];
  const sessionHooks: Array<{ name: string; callback: (input: any) => void; options?: unknown }> = [];
  const aisdkHooks: Array<{ name: string; callback: (input: any) => void; options?: unknown }> = [];
  let reloads = 0;
  return {
    context: {
      location: { directory: "/tmp/opencode/muse-plugin-test" },
      session: {
        async hook(name: string, callback: (input: any) => void, options?: unknown) {
          sessionHooks.push({ name, callback, options });
          return { dispose: async () => {} };
        },
      },
      aisdk: {
        async hook(name: string, callback: (input: any) => void, options?: unknown) {
          aisdkHooks.push({ name, callback, options });
          return { dispose: async () => {} };
        },
      },
      provider: {
        async transform(callback: typeof transform extends undefined ? never : NonNullable<typeof transform>) {
          transform = callback as typeof transform;
          callback({ add: (input) => { registrations.push(input); } });
          return { dispose: async () => {} };
        },
        async reload() {
          reloads += 1;
          transform?.({ add: (input) => { registrations.push(input); } });
        },
      },
    },
    registrations,
    sessionHooks,
    aisdkHooks,
    get reloads() { return reloads; },
  };
}

describe("Muse OpenCode provider registration", () => {
  test("provider.registersAisdkFileFactoryAndRefreshesAfterCacheUpdate", async () => {
    const fake = fakeContext();
    const runtime = await createProviderPlugin(fake.context as never, "file:///plugin/dist/index.js", {
      fetchCatalog: async () => liveCatalog(),
    });
    await runtime.refreshTask;

    expect(fake.registrations[0]?.info).toMatchObject({
      id: "muse",
      name: "Muse Code",
      package: "aisdk:file:///plugin/dist/index.js",
    });
    expect(fake.registrations[0]?.models[0]?.enabled).toBe(false);
    expect(fake.reloads).toBe(1);
    expect(fake.registrations.at(-1)?.models[0]?.id).toContain("muse-wonder-1.0");
    expect(runtime.catalog.hasLiveCatalog).toBe(true);
    await runtime.dispose();
  });

  test("provider.keepsTheFallbackWhenMuseDiscoveryFails", async () => {
    const fake = fakeContext();
    const runtime = await createProviderPlugin(fake.context as never, "file:///plugin/dist/index.js", {
      fetchCatalog: async () => { throw new Error("discovery failure"); },
    });
    await runtime.refreshTask;

    expect(fake.reloads).toBe(0);
    expect(fake.registrations[0]?.models[0]).toMatchObject({ enabled: false });
    expect(runtime.catalog.hasLiveCatalog).toBe(false);
    await runtime.dispose();
  });

  test("provider.stampsPerCallContextHeadersThroughTheSessionHook", async () => {
    const fake = fakeContext();
    const runtime = await createProviderPlugin(fake.context as never, "file:///plugin/dist/index.js", {
      fetchCatalog: async () => liveCatalog(),
    });
    await runtime.refreshTask;
    const hook = fake.sessionHooks.find((candidate) => candidate.name === "model.request");
    expect(hook?.options).toEqual({ providerID: "muse" });
    const request = {
      sessionID: "ses_plugin_test",
      kind: "primary",
      model: { id: "muse-profile-tbh-model-muse-wonder-1.0", providerID: "muse", variant: "high" },
      headers: { "x-existing": "kept" },
    };
    hook?.callback(request);
    expect(request.headers).toMatchObject({
      "x-existing": "kept",
      "x-opencode-muse-session-id": "ses_plugin_test",
      "x-opencode-muse-directory": "/tmp/opencode/muse-plugin-test",
      "x-opencode-muse-kind": "primary",
      "x-opencode-muse-model-id": "muse-profile-tbh-model-muse-wonder-1.0",
      "x-opencode-muse-provider-id": "muse",
      "x-opencode-muse-variant": "high",
    });
    await runtime.dispose();
  });

  test("provider.installsMuseLanguageModelHookUsingTheSelectedCatalogRow", async () => {
    const fake = fakeContext();
    const runtime = await createProviderPlugin(fake.context as never, "file:///plugin/dist/index.js", {
      fetchCatalog: async () => liveCatalog(),
    });
    await runtime.refreshTask;
    const hook = fake.aisdkHooks.find((candidate) => candidate.name === "language");
    expect(hook?.options).toEqual({ providerID: "muse" });
    const input: { model: { id: string; modelID: string; providerID: string }; language?: { provider: string; modelId: string; doGenerate?: unknown } } = {
      model: { id: "muse-profile-tbh-model-muse-wonder-1.0", modelID: "muse-wonder-1.0", providerID: "muse" },
    };

    hook?.callback(input);

    expect(input.language).toMatchObject({ provider: "muse", modelId: "muse-wonder-1.0" });
    expect(typeof input.language?.doGenerate).toBe("function");
    await runtime.dispose();
  });

  test("provider.handlesTitleAndCompactionLocallyAndPersistsOnlyTheSummaryHash", async () => {
    const fake = fakeContext();
    const candidates: Array<{ sessionID: string; fingerprint: string }> = [];
    let fakeManagerClosed = false;
    const runtime = await createProviderPlugin(fake.context as never, "file:///plugin/dist/index.js", {
      fetchCatalog: async () => liveCatalog(),
      createSessionManager: () => ({
        setContextForSession() {},
        async resolveSession() { throw new Error("local meta request must not resolve Muse session"); },
        async recordCompactionCandidate(sessionID: string, fingerprint: string) { candidates.push({ sessionID, fingerprint }); },
        async close() { fakeManagerClosed = true; },
      } as never),
    });
    await runtime.refreshTask;
    const title = fake.sessionHooks.find((candidate) => candidate.name === "title");
    const compaction = fake.sessionHooks.find((candidate) => candidate.name === "compaction");
    expect(title).toBeDefined();
    expect(compaction).toBeDefined();

    const titleInput: Record<string, any> = {
      sessionID: "ses_local_meta",
      model: { providerID: "muse", id: "muse-model" },
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "Fix the broken login." }] }],
      options: {},
    };
    await title?.callback(titleInput);
    expect(titleInput.result).toBe("Fix the broken login.");

    const compactInput: Record<string, any> = {
      sessionID: "ses_local_meta",
      model: { providerID: "muse", id: "muse-model" },
      system: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Initial request" }] },
        { role: "assistant", content: [{ type: "text", text: "Completed answer" }] },
      ],
      options: { maxOutputTokens: 300 },
    };
    await compaction?.callback(compactInput);
    expect(compactInput.result.summary).toContain("Initial request");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sessionID: "ses_local_meta" });
    expect(candidates[0]?.fingerprint).toBe(fingerprintCompactionOutput(compactInput.result.summary));
    expect(candidates[0]?.fingerprint).not.toContain(compactInput.result.summary);
    await runtime.dispose();
    expect(fakeManagerClosed).toBe(true);
  });

  test("providerCapturesOnlyAllowlistedAgentContextBeforeModelRequest", async () => {
    const fake = fakeContext();
    const observed: Array<{ sessionID: string; result: unknown }> = [];
    const runtime = await createProviderPlugin(fake.context as never, "file:///plugin/dist/index.js", {
      fetchCatalog: async () => liveCatalog(),
      createSessionManager: () => ({
        setContextForSession(sessionID: string, result: unknown) { observed.push({ sessionID, result }); },
        async resolveSession() { throw new Error("the context hook alone must not start a turn"); },
        async recordCompactionCandidate() {},
        async close() {},
      } as never),
    });
    await runtime.refreshTask;
    const hook = fake.sessionHooks.find((candidate) => candidate.name === "context");
    expect(hook?.options).toEqual({ providerID: "muse" });
    hook?.callback({
      sessionID: "ses_context_hook",
      agent: "security-reviewer",
      system: [
        { type: "text", text: "Check for data leaks and cite exact files." },
        { type: "text", text: "# Your Model\nprovider details" },
        { type: "text", text: "# Code Mode\n## Available tools\n- shell" },
      ],
      messages: [],
      options: {},
      tools: {},
      model: { id: "model", providerID: "muse" },
    });

    expect(observed).toEqual([{
      sessionID: "ses_context_hook",
      result: {
        supported: true,
        fragments: [{ label: "OpenCode agent instructions", text: "Check for data leaks and cite exact files." }],
      },
    }]);
    await runtime.dispose();
  });

  test("provider.createMuseProvidesANamedLanguageHookDriftDiagnostic", () => {
    const provider = createMuse();
    expect(() => provider.languageModel("setup-required")).toThrow(/opencode-muse: language hook did not engage/);
  });

  test("provider.setupWaitsForCatalogDiscoveryBeforeReturning", async () => {
    const fake = fakeContext();
    const runtime = await createProviderPlugin(fake.context as never, "file:///plugin/dist/index.js", {
      fetchCatalog: async () => liveCatalog(),
    });

    expect(runtime.catalog.hasLiveCatalog).toBe(true);
    expect(fake.reloads).toBe(1);
    expect(fake.registrations.at(-1)?.models[0]?.id).toContain("muse-wonder-1.0");
    await runtime.dispose();
  });

  test("provider.setupReturnsAfterABoundedWaitWhenDiscoveryStalls", async () => {
    const fake = fakeContext();
    let finishFetch!: (value: MuseCatalogSnapshot) => void;
    const setup = createProviderPlugin(fake.context as never, "file:///plugin/dist/index.js", {
      fetchCatalog: () => new Promise((resolve) => { finishFetch = resolve; }),
      setupRefreshTimeoutMs: 30,
    });
    const started = Date.now();
    const runtime = await setup;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(2000);
    expect(runtime.catalog.hasLiveCatalog).toBe(false);
    finishFetch(liveCatalog());
    await runtime.refreshTask;
    expect(runtime.catalog.hasLiveCatalog).toBe(true);
    expect(fake.reloads).toBe(1);
    await runtime.dispose();
  });
});
