import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../../src/session/registry.js";
import { WorkspaceLock } from "../../src/session/workspace-lock.js";
import { MuseSessionManager } from "../../src/session/manager.js";
import { MspCommandRejectedError } from "../../src/errors.js";
import type { RequestContext } from "../../src/types.js";
import {
  composeWorktreeNotices,
  countSharedSessions,
  findOwnWorktree,
  isWorktreeUnsupportedRejection,
  purgeWorktreeIfEmpty,
  resolveStagingRoot,
  type WorktreeVcs,
} from "../../src/msp/worktree.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-muse-worktree-"));
  roots.push(path);
  return path;
}

function context(sessionID: string, directory: string): RequestContext {
  return {
    sessionID,
    directory,
    kind: "primary",
    modelID: "muse-profile-tbh-model-wonder",
    providerID: "muse",
    museSelection: {
      providerId: "meta",
      profileId: "tbh",
      modelId: "wonder",
      isActive: false,
      isDefault: true,
      defaultReasoningEffort: "high",
      variantsKnown: true,
      variants: ["high"],
    },
  };
}

interface FakeHost {
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  failWorktreeWith?: string;
  listEntries?: Array<{ path: string; branch?: string; isMain?: boolean; sessionIds?: string[] }>;
}

function fakeVcs(overrides: Partial<WorktreeVcs> = {}): WorktreeVcs & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    async baseCommit() { return "base-sha"; },
    async isEmptyForPurge() { return true; },
    async remove(path: string) { removed.push(path); },
    ...overrides,
  };
}

function managerAt(root: string, fake: FakeHost, experimentalApi: boolean | undefined, vcs: WorktreeVcs) {
  const calls = fake.calls;
  let id = 0;
  const manager = new MuseSessionManager({
    stateDirectory: root,
    registry: new SessionRegistry({ stateDirectory: root }),
    workspaceLock: new WorkspaceLock({ stateDirectory: root }),
    contributorMode: "on",
    worktreeVcs: vcs,
    async createHost() {
      return {
        initializeResult: experimentalApi === undefined ? { sessionDurability: "durable" } : { sessionDurability: "durable", experimentalApi },
        mintCommandId: () => `018f4f17-9c2a-7c1a-a0fd-67a19db5d1${String(id++).padStart(2, "0")}`,
        approvals: { pendingApprovalIds: () => [] },
        userInput: {},
        async command(method: string, params: Record<string, unknown>) {
          calls.push({ method, params });
          if (method === "session/start") {
            if ((params as { worktree?: unknown }).worktree && fake.failWorktreeWith) {
              throw new MspCommandRejectedError(method, -32029, fake.failWorktreeWith);
            }
            const n = calls.filter((c) => c.method === "session/start").length;
            return { session: { sessionId: `ses_muse_${n}`, activeTurnId: null }, viewCursor: "head-1" };
          }
          return {};
        },
        async request(method: string, params: Record<string, unknown>) {
          calls.push({ method, params });
          if (method === "worktree/list") return { worktrees: fake.listEntries ?? [] };
          return {};
        },
        subscribe() { return { async *[Symbol.asyncIterator]() {} }; },
        async close() {},
      } as never;
    },
  });
  return { manager, calls };
}

describe("post-v1 worktree sessions (#34)", () => {
  test("worktree.experimentalStartCreatesAndBindsManagedWorktree", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const fake: FakeHost = {
      calls: [],
      listEntries: [
        { path: "/other/checkout", sessionIds: ["ses_other"] },
        { path: "/wt/ses_muse_1", branch: "muse/session-ses_muse_1", isMain: false, sessionIds: ["ses_muse_1"] },
      ],
    };
    const { manager, calls } = managerAt(root, fake, true, fakeVcs());
    const session = await manager.resolveSession(context("ses_oc_1", directory));

    const starts = calls.filter((c) => c.method === "session/start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.params).toMatchObject({ worktree: { mode: "create" } });
    expect(session.worktree?.path).toBe("/wt/ses_muse_1");
    expect(session.worktree?.branch).toBe("muse/session-ses_muse_1");
    expect(session.sessionNotices?.join("\n")).toContain("/wt/ses_muse_1");
    await manager.close();
  });

  test("worktree.untrustedWorkspaceFallsBackWithNotice", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const fake: FakeHost = { calls: [], failWorktreeWith: "workspaceNotTrusted", listEntries: [] };
    const { manager, calls } = managerAt(root, fake, true, fakeVcs());
    const session = await manager.resolveSession(context("ses_oc_1", directory));

    const starts = calls.filter((c) => c.method === "session/start");
    expect(starts).toHaveLength(2);
    expect(starts[1]!.params).not.toHaveProperty("worktree");
    // The fallback is a new command, never an id reuse with changed payload.
    expect(starts[1]!.params.commandId).not.toBe(starts[0]!.params.commandId);
    expect(session.worktree).toBeUndefined();
    expect(session.sessionNotices?.join("\n")).toContain("single-writer lock");
    await manager.close();
  });

  test("worktree.unexpectedRejectionThrowsWithoutRetry", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const fake: FakeHost = { calls: [], failWorktreeWith: "invalidParams" };
    const { manager, calls } = managerAt(root, fake, true, fakeVcs());
    await expect(manager.resolveSession(context("ses_oc_1", directory))).rejects.toThrow();
    expect(calls.filter((c) => c.method === "session/start")).toHaveLength(1);
    await manager.close();
  });

  test("worktree.stableHandshakeKeepsPlainStart", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const fake: FakeHost = { calls: [], listEntries: [] };
    const { manager, calls } = managerAt(root, fake, undefined, fakeVcs());
    const session = await manager.resolveSession(context("ses_oc_1", directory));

    const starts = calls.filter((c) => c.method === "session/start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.params).not.toHaveProperty("worktree");
    expect(calls.some((c) => c.method === "worktree/list")).toBe(false);
    expect(session.worktree).toBeUndefined();
    expect(session.sessionNotices ?? []).toEqual([]);
    await manager.close();
  });

  test("worktree.closePurgesEmptyAndKeepsDirty", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const vcs = fakeVcs();
    const fake: FakeHost = {
      calls: [],
      listEntries: [{ path: "/wt/empty", branch: "b-empty", sessionIds: ["ses_muse_1"] }],
    };
    const { manager } = managerAt(root, fake, true, vcs);
    await manager.resolveSession(context("ses_oc_1", directory));
    await manager.close();
    expect(vcs.removed).toEqual(["/wt/empty"]);
  });

  test("worktree.closeKeepsDirtyWorktree", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const vcs = fakeVcs({ isEmptyForPurge: async () => false });
    const fake: FakeHost = {
      calls: [],
      listEntries: [{ path: "/wt/dirty", branch: "b-dirty", sessionIds: ["ses_muse_1"] }],
    };
    const { manager } = managerAt(root, fake, true, vcs);
    await manager.resolveSession(context("ses_oc_1", directory));
    await manager.close();
    expect(vcs.removed).toEqual([]);
  });

  test("worktree.closeToleratesVcsFailure", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const vcs = fakeVcs({ remove: async () => { throw new Error("git gone"); } });
    const fake: FakeHost = {
      calls: [],
      listEntries: [{ path: "/wt/x", branch: "b-x", sessionIds: ["ses_muse_1"] }],
    };
    const { manager } = managerAt(root, fake, true, vcs);
    await manager.resolveSession(context("ses_oc_1", directory));
    await manager.close();
  });

  test("worktree.helpersComposeLabelsAndParseDefensively", () => {
    expect(resolveStagingRoot("/wt/a", "/ws")).toBe("/wt/a");
    expect(resolveStagingRoot(undefined, "/ws")).toBe("/ws");
    expect(findOwnWorktree({ worktrees: [{ path: "/wt/a", branch: "b", sessionIds: ["s1"] }] }, "s1")).toEqual({ path: "/wt/a", branch: "b" });
    expect(findOwnWorktree({}, "s1")).toBeUndefined();
    expect(findOwnWorktree({ worktrees: "nope" }, "s1")).toBeUndefined();
    expect(countSharedSessions({ worktrees: [{ path: "/ws", sessionIds: ["s0", "s1"] }] }, "/ws", "s1")).toBe(1);
    expect(countSharedSessions({}, "/ws", "s1")).toBe(0);
    expect(isWorktreeUnsupportedRejection(new MspCommandRejectedError("session/start", -32029, "workspaceNotTrusted"))).toBe(true);
    expect(isWorktreeUnsupportedRejection(new MspCommandRejectedError("session/start", -32602, "invalidParams"))).toBe(false);
    expect(isWorktreeUnsupportedRejection(new Error("boom"))).toBe(false);
    const redirect = composeWorktreeNotices({ workspaceRoot: "/ws", worktree: { path: "/wt/a", branch: "b" }, sharedOthers: 2 });
    expect(redirect.join("\n")).toContain("2 other live session(s)");
    const fallback = composeWorktreeNotices({ workspaceRoot: "/ws", fallbackReason: "workspaceNotTrusted" });
    expect(fallback.join("\n")).toContain("single-writer lock");
  });

  test("worktree.purgeSkipsWithoutPathAndKeepsOnDoubt", async () => {
    expect(await purgeWorktreeIfEmpty(fakeVcs(), undefined)).toBe("skipped");
    expect(await purgeWorktreeIfEmpty(fakeVcs(), { path: "/wt/a" })).toBe("skipped");
    const failing = fakeVcs({ isEmptyForPurge: async () => { throw new Error("git gone"); } });
    expect(await purgeWorktreeIfEmpty(failing, { path: "/wt/a", branch: "b", baseSha: "s" })).toBe("kept");
  });
});
