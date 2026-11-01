import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMspConnection, readSessionDurability, type Connection } from "@muse-code/sdk";

type ProbeEvent = { method: string; params: Record<string, unknown> };

const provider = process.env.MUSE_PROBE_PROVIDER ?? "echo";
const modelId = process.env.MUSE_PROBE_MODEL;
const homeParent = process.env.MUSE_PROBE_HOME_PARENT ?? tmpdir();
if (provider === "echo") mkdirSync(homeParent, { recursive: true });
const isolatedHome = provider === "echo" ? mkdtempSync(join(homeParent, "opencode-muse-probe-home-")) : undefined;
const workspaceRoot = process.env.MUSE_PROBE_WORKSPACE ?? (isolatedHome ? join(isolatedHome, "workspace") : "/tmp/opencode/muse-lifecycle-probe");
const runId = (process.env.MUSE_PROBE_RUN_ID ?? new Date().toISOString())
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
const runName = `opencode-muse-probe-${runId}`;
const facts: Record<string, unknown> = { provider, modelId: modelId ?? null, workspaceRootHash: hash(workspaceRoot) };
mkdirSync(workspaceRoot, { recursive: true });
if (isolatedHome) {
  mkdirSync(join(isolatedHome, ".config"), { recursive: true });
  mkdirSync(join(isolatedHome, ".local", "share"), { recursive: true });
  mkdirSync(join(isolatedHome, "tmp"), { recursive: true });
}
if (!existsSync(join(workspaceRoot, ".git"))) {
  writeFileSync(join(workspaceRoot, "README.md"), "Temporary Muse lifecycle probe workspace.\n");
  execFileSync("git", ["init", "--quiet", "-b", "main", workspaceRoot]);
  execFileSync("git", ["-C", workspaceRoot, "config", "user.name", "Muse Probe"]);
  execFileSync("git", ["-C", workspaceRoot, "config", "user.email", "muse-probe@example.invalid"]);
  execFileSync("git", ["-C", workspaceRoot, "add", "README.md"]);
  execFileSync("git", ["-C", workspaceRoot, "commit", "--quiet", "-m", "probe workspace"]);
}
const gitDir = execFileSync("git", ["-C", workspaceRoot, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
const branchRef = execFileSync("git", ["-C", workspaceRoot, "rev-parse", "--git-path", "refs/heads/main"], { encoding: "utf8" }).trim();
const birthtimeAvailable = (path: string) => {
  try {
    return statSync(path).birthtimeMs > 0;
  } catch {
    return false;
  }
};
facts.workspaceBirthTimeAvailable = birthtimeAvailable(workspaceRoot);
facts.gitDirBirthTimeAvailable = birthtimeAvailable(gitDir);
facts.branchRefBirthTimeAvailable = birthtimeAvailable(branchRef.startsWith("/") ? branchRef : join(workspaceRoot, branchRef));

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function record(value: unknown): void {
  console.log(JSON.stringify(value));
}

function collectNotifications(connection: Connection) {
  const events: ProbeEvent[] = [];
  const waiters: Array<{
    afterIndex: number;
    predicate: (event: ProbeEvent) => boolean;
    resolve: (event: ProbeEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  connection.onNotification((notification: { method: string; params?: Record<string, unknown> }) => {
    const event = { method: notification.method, params: notification.params ?? {} };
    events.push(event);
    for (const waiter of [...waiters]) {
      if (events.length - 1 < waiter.afterIndex) continue;
      if (!waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });

  return {
    events,
    waitFor(predicate: (event: ProbeEvent) => boolean, afterIndex = 0, timeoutMs = 90_000): Promise<ProbeEvent> {
      const existing = events.slice(afterIndex).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          afterIndex,
          predicate,
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("Timed out waiting for the expected MSP notification"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

function eventSummary(event: ProbeEvent) {
  const params = event.params;
  const usage = params.usage as Record<string, unknown> | undefined;
  const item = typeof params.item === "object" && params.item !== null
    ? params.item as { kind?: string; status?: string; turnId?: string | null }
    : undefined;
  const eventTurnId = typeof params.turnId === "string" ? params.turnId : item?.turnId;
  const delta = typeof params.delta === "string" ? params.delta : undefined;
  return {
    method: event.method,
    sessionIdHash: typeof params.sessionId === "string" ? hash(params.sessionId) : null,
    turnIdHash: typeof eventTurnId === "string" ? hash(eventTurnId) : null,
    itemKind: item?.kind ?? null,
    itemStatus: item?.status ?? null,
    deltaField: typeof params.field === "string" ? params.field : null,
    deltaUtf8Bytes: delta === undefined ? null : Buffer.byteLength(delta, "utf8"),
    terminal: typeof params.terminal === "string" ? params.terminal : null,
    usage: usage
      ? Object.fromEntries(Object.entries(usage).filter(([, count]) => typeof count === "number"))
      : null,
    viewCursorHash: typeof params.viewCursor === "string" ? hash(params.viewCursor) : null,
  };
}

function belongsToTurn(event: ProbeEvent, sessionId: string, turnId: string): boolean {
  if (event.params.sessionId !== sessionId) return false;
  if (event.params.turnId === turnId) return true;
  const item = event.params.item as { turnId?: string | null } | undefined;
  return item?.turnId === turnId;
}

async function probeSessionRename(connection: Connection, sessionId: string, name: string): Promise<string> {
  try {
    await connection.command("session/rename", { sessionId, name });
    return "renamed";
  } catch (error) {
    const failure = error as { code?: number; message?: string };
    if (failure.code === -32603 && failure.message?.includes("session naming is unavailable")) {
      return "runtime-unavailable";
    }
    // Muse CLI 1.4.14 reports unavailable rename as -32030 commandRejected.
    if (failure.code === -32030) {
      return "runtime-unavailable";
    }
    throw error;
  }
}

let stage = "initialization";

async function connect() {
  const handshake = spawnMspConnection({
    command: process.env.MUSE_BIN ?? "muse",
    args: ["serve", "--provider", provider, "--trust-workspace", "--disable-shell", "--disable-write", ...(modelId ? ["--model", modelId] : [])],
    cwd: workspaceRoot,
    env: isolatedHome
      ? {
          PATH: process.env.PATH ?? "",
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
          TMPDIR: join(isolatedHome, "tmp"),
          LANG: process.env.LANG ?? "C.UTF-8",
        }
      : undefined,
    shutdownTimeoutMs: 5_000,
  });
  stage = "msp-handshake";
  try {
    return await handshake.initialize({
      clientInfo: { name: "opencode_muse_lifecycle_probe", version: "0.1.0" },
      capabilities: { requestedCapabilities: ["sessionRename"] },
    });
  } catch (error) {
    await handshake.close();
    throw error;
  }
}

let spawned: Awaited<ReturnType<typeof connect>> | undefined;
let resumed: Awaited<ReturnType<typeof connect>> | undefined;

try {
  stage = "connect";
  spawned = await connect();
  const connection = spawned.connection;
  const notifications = collectNotifications(connection);
  const durability = readSessionDurability(spawned.initializeResult);
  const schemaFingerprint = spawned.initializeResult.schema.fingerprint;
  facts.durability = durability.kind;
  facts.schemaFingerprint = schemaFingerprint;
  facts.museHomeIsIsolated = isolatedHome
    ? spawned.initializeResult.museHome.startsWith(isolatedHome)
    : false;
  facts.sessionRenameGranted = spawned.initializeResult.grantedCapabilities.includes("sessionRename");
  stage = "session-start";
  const start = await connection.command("session/start", {
    workspaceRoot,
    approvalMode: "onRequest",
    ...(modelId ? { modelId } : {}),
    ...(provider === "meta" ? { providerId: "meta" } : {}),
  });
  const sessionId = String((start.session as { sessionId: string }).sessionId);
  const startCursor = String(start.viewCursor);
  facts.sessionIdHash = hash(sessionId);
  facts.startCursorHash = hash(startCursor);
  const sessionRenameGranted = spawned.initializeResult.grantedCapabilities.includes("sessionRename");
  if (durability.kind === "durable" && sessionRenameGranted) {
    stage = "session-rename";
    facts.sessionRename = await probeSessionRename(connection, sessionId, runName);
  } else {
    facts.sessionRename = sessionRenameGranted ? "ephemeral-host" : "capability-not-granted";
  }

  const turnParams = {
    sessionId,
    input: [{ type: "text", text: "Probe: reply exactly LIFECYCLE_OK and do not use tools." }],
    displayText: "opencode-muse lifecycle probe",
  };
  stage = "turn-start-first";
  const commandId = connection.mintCommandId();
  const turnEventStart = notifications.events.length;
  const firstAck = await connection.request("turn/start", { ...turnParams, commandId });
  const turnId = String(firstAck.turnId);
  stage = "turn-start-replay-same-id";
  const replayAck = await connection.request("turn/start", { ...turnParams, commandId });
  const sameCommandSameTurn = String(replayAck.turnId) === turnId;
  stage = "wait-turn-completed";
  const terminal = await notifications.waitFor((event) =>
    event.method === "turn/completed" && event.params.sessionId === sessionId && event.params.turnId === turnId,
  turnEventStart,
  );
  if (durability.kind === "durable" && sessionRenameGranted) {
    stage = "session-rename-after-turn";
    facts.sessionRenameAfterTurn = await probeSessionRename(connection, sessionId, runName);
  }

  const originalTurnEvents = notifications.events
    .filter((event) => belongsToTurn(event, sessionId, turnId))
    .map(eventSummary);
  const turnStartCount = notifications.events.filter((event) =>
    event.method === "turn/started" && event.params.sessionId === sessionId && event.params.turnId === turnId,
  ).length;

  // session/start auto-subscribes at its returned view head. Explicit
  // view/subscribe is only used after detaching, to replay an older cursor.
  stage = "view-unsubscribe-resubscribe";
  await connection.request("view/unsubscribe", { sessionId });
  const subscribeReplayStart = notifications.events.length;
  await connection.request("view/subscribe", { sessionId, after: startCursor });
  const replayedTerminal = await notifications.waitFor((event) =>
    event.method === "turn/completed" && event.params.sessionId === sessionId && event.params.turnId === turnId,
  subscribeReplayStart,
  );
  const subscribeReplayTerminalCount = notifications.events.slice(subscribeReplayStart).filter((event) =>
    event.method === "turn/completed" && event.params.sessionId === sessionId && event.params.turnId === turnId,
  ).length;

  const result: Record<string, unknown> = {
    status: "MSP_LIFECYCLE_PROBED",
    ...facts,
    startDisposition: firstAck.disposition,
    duplicateCommandSameTurn: sameCommandSameTurn,
    turnStartCount,
    turnEvents: originalTurnEvents,
    terminal: eventSummary(terminal),
    subscribeReplayTerminal: eventSummary(replayedTerminal),
    subscribeReplayTerminalCount,
  };

  if (durability.kind === "durable") {
    stage = "session-rename-for-resume";
    if (sessionRenameGranted) facts.sessionRename = await probeSessionRename(connection, sessionId, runName);
    stage = "session-fork";
    try {
      const fork = await connection.command("session/fork", {
        sessionId,
        cutPoint: { lastTurnId: turnId },
      });
      const forkSessionId = String((fork.session as { sessionId: string }).sessionId);
      result.forkRename = sessionRenameGranted
        ? await probeSessionRename(connection, forkSessionId, `${runName} fork`)
        : "capability-not-granted";
      result.forkSessionIdHash = hash(forkSessionId);
      result.forkCutExplicit = (fork.session as { forkedFrom?: { cutExplicit?: boolean } }).forkedFrom?.cutExplicit ?? null;
    } catch (error) {
      const failure = error as { code?: number; kind?: string; message?: string };
      result.fork = {
        status: "unavailable",
        code: failure.code ?? null,
        kind: failure.kind ?? null,
        reason: failure.message?.includes("file birth time is unavailable")
          ? "file-birth-time-unavailable"
          : "unclassified-msp-error",
      };
    }

    stage = "close-first-host";
    await spawned.close();
    spawned = undefined;
    stage = "resume-host";
    resumed = await connect();
    const resumeNotifications = collectNotifications(resumed.connection);
    stage = "session-resume";
    const resume = await resumed.connection.command("session/resume", { sessionId, cursor: startCursor });
    await resumed.connection.request("view/unsubscribe", { sessionId });
    const resumeReplayStart = resumeNotifications.events.length;
    await resumed.connection.request("view/subscribe", { sessionId, after: startCursor });
    const resumedTerminal = await resumeNotifications.waitFor((event) =>
      event.method === "turn/completed" && event.params.sessionId === sessionId && event.params.turnId === turnId,
      resumeReplayStart,
    );
    const resumedTerminalCount = resumeNotifications.events.slice(resumeReplayStart).filter((event) =>
      event.method === "turn/completed" && event.params.sessionId === sessionId && event.params.turnId === turnId,
    ).length;
    result.resumedSessionMatches = (resume.session as { sessionId?: string }).sessionId === sessionId;
    result.resumedTerminal = eventSummary(resumedTerminal);
    result.resumedTerminalCount = resumedTerminalCount;
    result.sessionNames = result.forkRename === "renamed" ? [runName, `${runName} fork`] : null;
  } else {
    result.resumeAndForkSkipped = "session durability is not durable; do not attempt reattach or fork recovery";
  }

  stage = "complete";
  record(result);
} catch (error) {
  const failure = error as { name?: string; code?: number; kind?: string; retryable?: boolean };
  record({
    status: "MSP_LIFECYCLE_FAILED",
    stage,
    ...facts,
    failure: {
      name: failure.name ?? "Error",
      code: failure.code ?? null,
      kind: failure.kind ?? null,
      retryable: failure.retryable ?? null,
      safeMessage: provider === "echo" && ["session-rename", "session-fork", "session-resume"].includes(stage)
        ? String(error).slice(0, 240)
        : null,
    },
  });
  process.exitCode = 1;
} finally {
  if (resumed !== undefined) await resumed.close();
  if (spawned !== undefined) await spawned.close();
  if (isolatedHome !== undefined && process.env.MUSE_PROBE_KEEP_HOME !== "1") {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}
