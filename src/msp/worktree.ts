import { execFile } from "node:child_process";
import { MspCommandRejectedError } from "../errors.js";

/**
 * Post-v1 parallel writers (#34). Each OpenCode session starts its Muse
 * session on a server-managed worktree instead of sharing the checkout;
 * the human merges through normal source control. Untrusted workspaces
 * and missing experimental surface fall back to the single-writer lock
 * with a conversational notice — never a failure.
 */

export type WorktreeStart = { mode: "create"; baseRef?: string } | { mode: "existing"; path: string };

export interface ManagedWorktree {
  path?: string;
  branch?: string;
  baseSha?: string;
}

/** Rejection kinds that mean "no worktree path", never a defect. */
const WORKTREE_FALLBACK_KINDS = new Set(["experimentalRequired", "capabilityRequired", "workspaceNotTrusted"]);

const FALLBACK_PHRASES: Record<string, string> = {
  experimentalRequired: "this host does not serve the experimental worktree surface",
  capabilityRequired: "the worktree capability was not granted",
  workspaceNotTrusted: "this workspace is not trusted",
};

export function isWorktreeUnsupportedRejection(error: unknown): boolean {
  return error instanceof MspCommandRejectedError && WORKTREE_FALLBACK_KINDS.has(error.mspKind);
}

export function fallbackPhrase(kind: string): string {
  return FALLBACK_PHRASES[kind] ?? "worktrees are unavailable";
}

export interface WorktreeListEntry {
  path?: unknown;
  branch?: unknown;
  sessionIds?: unknown;
}

function entryList(value: unknown): WorktreeListEntry[] {
  if (typeof value !== "object" || value === null) return [];
  const worktrees = (value as { worktrees?: unknown }).worktrees;
  if (!Array.isArray(worktrees)) return [];
  return worktrees.filter((entry): entry is WorktreeListEntry => typeof entry === "object" && entry !== null);
}

function sessionIdsOf(entry: WorktreeListEntry): string[] {
  if (!Array.isArray(entry.sessionIds)) return [];
  return entry.sessionIds.filter((id): id is string => typeof id === "string");
}

/** The caller's own worktree, matched by live session id. */
export function findOwnWorktree(listResult: unknown, sessionId: string): { path: string; branch?: string } | undefined {
  for (const entry of entryList(listResult)) {
    if (typeof entry.path !== "string") continue;
    if (!sessionIdsOf(entry).includes(sessionId)) continue;
    return { path: entry.path, branch: typeof entry.branch === "string" ? entry.branch : undefined };
  }
  return undefined;
}

/** Other live sessions bound to the user's checkout (redirect signal). */
export function countSharedSessions(listResult: unknown, workspaceRoot: string, ownSessionId: string): number {
  let count = 0;
  for (const entry of entryList(listResult)) {
    if (entry.path !== workspaceRoot) continue;
    for (const id of sessionIdsOf(entry)) {
      if (id !== ownSessionId) count += 1;
    }
  }
  return count;
}

export interface WorktreeNotices {
  workspaceRoot: string;
  worktree?: { path?: string; branch?: string };
  fallbackReason?: string;
  sharedOthers?: number;
}

/** Bridge-authored, labeled, first-turn-only. Never smuggled prose. */
export function composeWorktreeNotices(notices: WorktreeNotices): string[] {
  const lines: string[] = [];
  if (notices.worktree?.path) {
    lines.push(
      `[Muse session workspace: ${notices.worktree.path}` +
        (notices.worktree.branch ? ` (worktree, branch ${notices.worktree.branch})` : " (worktree)") +
        `, branched from ${notices.workspaceRoot}. Merge back through normal source control; this bridge never auto-merges.]`,
    );
  }
  if ((notices.sharedOthers ?? 0) > 0 && notices.worktree?.path) {
    lines.push(
      `[${notices.sharedOthers} other live session(s) share ${notices.workspaceRoot}; ` +
        `this session works on ${notices.worktree.path} instead.]`,
    );
  }
  if (notices.fallbackReason) {
    lines.push(
      `[Per-session worktrees unavailable (${fallbackPhrase(notices.fallbackReason)}); ` +
        `sharing this checkout under the single-writer lock. To enable worktrees, trust this workspace in Muse.]`,
    );
  }
  return lines;
}

/** PDF staging (#33) follows the session onto its worktree. */
export function resolveStagingRoot(worktreePath: string | undefined, directory: string): string {
  return worktreePath ?? directory;
}

/** First-turn-only emission gate: labels ride once, never replayed. */
export function pendingFirstTurnNotices(
  sessionNotices: readonly string[] | undefined,
  previousTranscriptFingerprints: readonly string[],
  compacted: boolean,
): string[] {
  if (!sessionNotices?.length || compacted || previousTranscriptFingerprints.length > 0) return [];
  return [...sessionNotices];
}

export interface WorktreeVcs {
  baseCommit(workspaceRoot: string): Promise<string | undefined>;
  isEmptyForPurge(path: string, branch: string, baseCommit: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export const defaultWorktreeVcs: WorktreeVcs = {
  async baseCommit(workspaceRoot: string): Promise<string | undefined> {
    try {
      return (await runGit(["rev-parse", "HEAD"], workspaceRoot)).trim() || undefined;
    } catch {
      return undefined;
    }
  },
  async isEmptyForPurge(path: string, branch: string, baseCommit: string): Promise<boolean> {
    try {
      if ((await runGit(["status", "--porcelain"], path)).trim() !== "") return false;
      return (await runGit(["rev-parse", "--verify", branch], path)).trim() === baseCommit;
    } catch {
      return false;
    }
  },
  async remove(path: string): Promise<void> {
    await runGit(["worktree", "remove", "--force", path], path);
    await runGit(["worktree", "prune"], path).catch(() => {});
  },
};

/**
 * Purge-only-provably-empty orphans (decision 2): anything missing,
 * dirty, diverged, or failing the check is kept. Never throws —
 * the shutdown path must not fail because cleanup did.
 */
export async function purgeWorktreeIfEmpty(
  vcs: WorktreeVcs,
  worktree: ManagedWorktree | undefined,
): Promise<"purged" | "kept" | "skipped"> {
  if (!worktree?.path || !worktree.branch || !worktree.baseSha) return "skipped";
  try {
    if (!(await vcs.isEmptyForPurge(worktree.path, worktree.branch, worktree.baseSha))) return "kept";
    await vcs.remove(worktree.path);
    return "purged";
  } catch {
    return "kept";
  }
}
