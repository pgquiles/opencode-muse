import type { Plugin, Provider } from "@opencode/plugin";
import { MspHost } from "./msp/host.js";
import {
  CatalogCache,
  MUSE_PROVIDER_ID,
  type MuseCatalogSnapshot,
} from "./catalog.js";
import { addRequestContextHeaders } from "./model/context.js";
import { createMuseLanguageModel } from "./model/language-model.js";
import { MuseSessionManager } from "./session/manager.js";
import { SessionRegistry } from "./session/registry.js";
import { WorkspaceLock } from "./session/workspace-lock.js";
import { MuseBridgeError } from "./errors.js";
import { makeCompactionDigest, makeLocalTitle } from "./model/meta.js";
import { fingerprintCompactionOutput } from "./session/fingerprint.js";
import { extractAllowedAgentContext } from "./model/agent-context.js";

type ProviderEditor = Parameters<Parameters<Plugin.Context["provider"]["transform"]>[0]>[0];

export type MuseProviderContext = Pick<Plugin.Context, "provider" | "session" | "aisdk"> & {
  location: Pick<Plugin.Context["location"], "directory">;
};

export interface ProviderPluginDependencies {
  fetchCatalog?: (directory: string) => Promise<MuseCatalogSnapshot>;
  createSessionManager?: () => MuseSessionManager;
  /** Bounds how long setup waits for the live catalog before falling back. Defaults to 15s. */
  setupRefreshTimeoutMs?: number;
}

/** Upper bound on delaying provider readiness for live catalog discovery. */
export const SETUP_REFRESH_TIMEOUT_MS = 15_000;

export interface MuseProviderRuntime {
  catalog: CatalogCache;
  refreshTask: Promise<boolean>;
  sessions: MuseSessionManager;
  dispose(): Promise<void>;
}

function providerInfo(moduleUrl: string): Provider.Info {
  return {
    id: MUSE_PROVIDER_ID,
    name: "Muse Code",
    activation: "enabled",
    package: `aisdk:${moduleUrl}`,
    settings: {},
  } as unknown as Provider.Info;
}

async function fetchMuseCatalog(directory: string): Promise<MuseCatalogSnapshot> {
  const host = await MspHost.start({
    args: ["serve", "--provider", "meta", "--disable-shell", "--disable-write"],
    cwd: directory,
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    shutdownTimeoutMs: 5_000,
  });
  try {
    return await host.request<MuseCatalogSnapshot>("model/list");
  } finally {
    await host.close();
  }
}

/** Register the disabled offline row first, then refresh only from a live MSP provider catalog. */
export async function createProviderPlugin(
  ctx: MuseProviderContext,
  moduleUrl: string,
  dependencies: ProviderPluginDependencies = {},
): Promise<MuseProviderRuntime> {
  const catalog = new CatalogCache();
  const stateDirectory = SessionRegistry.resolveStateDirectory();
  const sessions = dependencies.createSessionManager?.() ?? new MuseSessionManager({
      stateDirectory,
      registry: new SessionRegistry({ stateDirectory }),
      workspaceLock: new WorkspaceLock({ stateDirectory }),
    });
  const registration = await ctx.provider.transform((providers: ProviderEditor) => {
    providers.add({ info: providerInfo(moduleUrl), models: catalog.models });
  });
  let sessionHookRegistration: Awaited<ReturnType<Plugin.Context["session"]["hook"]>> | undefined;
  let languageHookRegistration: Awaited<ReturnType<Plugin.Context["aisdk"]["hook"]>> | undefined;
  const localMetaRegistrations: Array<Awaited<ReturnType<Plugin.Context["session"]["hook"]>>> = [];
  try {
    sessionHookRegistration = await ctx.session.hook("model.request", async (request) => {
      addRequestContextHeaders(request.headers, request, ctx.location.directory);
    }, { providerID: MUSE_PROVIDER_ID });
    localMetaRegistrations.push(await ctx.session.hook("context", async (input) => {
      sessions.setContextForSession(input.sessionID, extractAllowedAgentContext(input.agent, input.system));
    }, { providerID: MUSE_PROVIDER_ID }));
    languageHookRegistration = await ctx.aisdk.hook("language", async (input) => {
      if (input.model.providerID !== MUSE_PROVIDER_ID) return;
      const selection = catalog.selectionIndex.get(input.model.id);
      if (!selection) {
        throw new MuseBridgeError("MUSE_UNSUPPORTED_REQUEST", "Muse model selection is unavailable; refresh the provider catalog", false);
      }
      input.language = createMuseLanguageModel({
        selectionIndex: catalog.selectionIndex,
        resolveSession: (context) => sessions.resolveSession(context),
        settleApprovalResponses: (sessionID, responses) => sessions.settleApprovalResponses(sessionID, responses),
        hasParkedApprovals: (sessionID) => sessions.hasParkedApprovals(sessionID),
        disarmParkedJoin: (sessionID) => sessions.disarmParkedJoin(sessionID),
      }, input.model.modelID);
    }, { providerID: MUSE_PROVIDER_ID });
    localMetaRegistrations.push(await ctx.session.hook("title", async (input) => {
      input.result = makeLocalTitle(input.messages);
    }, { providerID: MUSE_PROVIDER_ID }));
    localMetaRegistrations.push(await ctx.session.hook("compaction", async (input) => {
      const summary = makeCompactionDigest(
        input.messages,
        typeof input.options.maxOutputTokens === "number" ? input.options.maxOutputTokens : undefined,
      );
      await sessions.recordCompactionCandidate(input.sessionID, fingerprintCompactionOutput(summary));
      input.result = { summary };
    }, { providerID: MUSE_PROVIDER_ID }));
  } catch (error) {
    await sessions.close();
    await registration.dispose();
    // The session hook may have been registered before the language hook failed.
    await sessionHookRegistration?.dispose();
    await Promise.all(localMetaRegistrations.map((hook) => hook.dispose()));
    throw error;
  }

  let disposed = false;
  const refreshTask = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
    if (disposed) return false;
    return catalog.refresh(
      () => (dependencies.fetchCatalog ?? fetchMuseCatalog)(ctx.location.directory),
      async () => {
        if (!disposed) await ctx.provider.reload();
      },
    );
  });

  // Wait for live discovery (bounded) so consumers never see the pre-refresh
  // fallback. On timeout or failure the disabled placeholder stays in place
  // and a late refresh still replaces it via provider.reload().
  const refreshTimeoutMs = dependencies.setupRefreshTimeoutMs ?? SETUP_REFRESH_TIMEOUT_MS;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      refreshTask.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        refreshTimer = setTimeout(() => resolve(false), refreshTimeoutMs);
      }),
    ]);
  } finally {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  }

  return {
    catalog,
    refreshTask,
    sessions,
    async dispose() {
      disposed = true;
      await refreshTask;
      await Promise.all([
        registration.dispose(),
        sessionHookRegistration?.dispose(),
        languageHookRegistration?.dispose(),
        ...localMetaRegistrations.map((hook) => hook.dispose()),
        sessions.close(),
      ]);
    },
  };
}
