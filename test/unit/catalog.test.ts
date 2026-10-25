import { describe, expect, test } from "bun:test";
import {
  CatalogCache,
  buildMuseModelIndex,
  buildOpenCodeCatalog,
  fallbackCatalog,
  openCodeModelId,
  type MuseCatalogSnapshot,
} from "../../src/catalog.js";

function catalog(overrides: Partial<MuseCatalogSnapshot> = {}): MuseCatalogSnapshot {
  return {
    providerId: "meta",
    profileId: "tbh",
    source: "providerCatalog",
    models: [
      {
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
      },
      {
        providerId: "meta",
        profileId: "tbh",
        modelId: "muse-spark-1.2",
        displayLabel: "Muse Spark 1.2",
        contextLimit: 1_007_997,
        outputLimit: 128_000,
        releaseDate: "2026-08-05",
        isActive: true,
        isDefault: false,
        defaultReasoningEffort: "high",
        variants: ["minimal", "low", "medium", "high", "xhigh"],
        reasoningEffortVariants: [{ tier: "xhigh", description: "Deep reasoning" }],
        cost: null,
      },
    ],
    ...overrides,
  };
}

describe("Muse model catalog", () => {
  test("catalog.mapsProfileModelLabelLimitsReleaseAndKnownEfforts", () => {
    const museCatalog = catalog();
    const models = buildOpenCodeCatalog(museCatalog);
    const wonder = models.find((model) => model.modelID === "muse-wonder-1.0")!;
    const index = buildMuseModelIndex(museCatalog);

    expect(wonder).toMatchObject({
      id: openCodeModelId("tbh", "muse-wonder-1.0"),
      providerID: "muse",
      modelID: "muse-wonder-1.0",
      name: "Muse Wonder 1.0",
      enabled: true,
      status: "active",
      limit: { context: 1_007_997, output: 128_000 },
      time: { released: Date.parse("2026-10-12") },
    });
    expect(wonder.variants.map((variant) => variant.id) as string[]).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(index.get(wonder.id)).toMatchObject({
      providerId: "meta",
      profileId: "tbh",
      modelId: "muse-wonder-1.0",
      isDefault: true,
      isActive: false,
      defaultReasoningEffort: "high",
      variantsKnown: true,
    });
  });

  test("catalog.keepsSessionActiveAndCatalogDefaultInTheSelectionIndex", () => {
    const museCatalog = catalog();
    const index = buildMuseModelIndex(museCatalog);
    const activeId = openCodeModelId("tbh", "muse-spark-1.2");
    expect(index.get(activeId)).toMatchObject({ isActive: true, isDefault: false, variantsKnown: true });
  });

  test("catalog.unknownEffortsDoNotCreateRunnableVariantOptions", () => {
    const museCatalog = catalog({
      models: [{
        providerId: "meta",
        profileId: null,
        modelId: "unknown-effort-model",
        displayLabel: "Unknown effort model",
        contextLimit: 32_000,
        outputLimit: 2_000,
        releaseDate: null,
        isActive: false,
        isDefault: false,
        variants: "unknown",
        cost: null,
      }],
    });
    const models = buildOpenCodeCatalog(museCatalog);
    const index = buildMuseModelIndex(museCatalog);

    expect(models[0]?.variants).toEqual([]);
    expect(index.get(models[0]!.id)?.variantsKnown).toBe(false);
  });

  test("catalog.keepsTheDisplayLabelFreeOfEffortSuffixes", () => {
    const models = buildOpenCodeCatalog(catalog());

    expect(models.map((model) => model.name)).toEqual(["Muse Wonder 1.0", "Muse Spark 1.2"]);
  });

  test("catalog.missingLimitsDisableTheModelInsteadOfInventingLimits", () => {
    const museCatalog = catalog({
      models: [{
        providerId: "meta",
        profileId: null,
        modelId: "unknown-limits-model",
        displayLabel: "Unknown limits model",
        contextLimit: null,
        outputLimit: null,
        releaseDate: null,
        isActive: false,
        isDefault: false,
        variants: "unknown",
        cost: null,
      }],
    });
    const model = buildOpenCodeCatalog(museCatalog)[0]!;

    expect(model.enabled).toBe(false);
    expect(model.limit).toEqual({ context: 1, output: 1 });
    expect(model.name).toContain("limits unavailable");
  });

  test("catalog.emptyOrFakeCatalogRetainsAnExplainedNonRunnableFallback", () => {
    for (const museCatalog of [catalog({ models: [] }), catalog({ source: "fakeCatalog", models: [] })]) {
      const models = buildOpenCodeCatalog(museCatalog);
      expect(models).toEqual(fallbackCatalog);
      expect(models.every((model) => model.enabled === false)).toBe(true);
      expect(models[0]?.name.toLowerCase()).toContain("muse login");
    }
  });

  test("catalog.refreshReplacesCacheBeforeProviderReload", async () => {
    const cache = new CatalogCache();
    let modelsSeenByReload: string[] = [];

    const refreshed = await cache.refresh(async () => catalog(), async () => {
      modelsSeenByReload = cache.models.map((model) => model.modelID);
    });

    expect(refreshed).toBe(true);
    expect(modelsSeenByReload).toContain("muse-wonder-1.0");
    expect(cache.hasLiveCatalog).toBe(true);
  });

  test("catalog.refreshFailurePreservesTheLastGoodCatalogAndDoesNotReload", async () => {
    const cache = new CatalogCache();
    await cache.refresh(async () => catalog(), async () => {});
    const previous = cache.models;
    let reloads = 0;

    const refreshed = await cache.refresh(async () => { throw new Error("no catalog"); }, async () => { reloads += 1; });

    expect(refreshed).toBe(false);
    expect(cache.models).toBe(previous);
    expect(reloads).toBe(0);
  });

  test("catalog.providerReloadFailureRestoresTheLastGoodSnapshot", async () => {
    const cache = new CatalogCache();
    await cache.refresh(async () => catalog(), async () => {});
    const previous = cache.models;
    const changed = catalog({ models: [
      { ...catalog().models[0]!, modelId: "new-model", displayLabel: "New model" },
    ] });

    const refreshed = await cache.refresh(async () => changed, async () => { throw new Error("reload failed"); });

    expect(refreshed).toBe(false);
    expect(cache.models).toBe(previous);
    expect(cache.models.some((model) => model.modelID === "new-model")).toBe(false);
  });
});
