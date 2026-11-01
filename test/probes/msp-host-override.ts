// Offline host-override probe (#42): drives a real `muse serve` with an
// isolated HOME, a private XDG config (prompt/toolset override), and a fake
// Meta endpoint. Zero live calls, no credentials, no real-config access.
// Checks: (1) prompt/toolset override, one request per turn; (2) rawLog
// all-calls + parked turn; (3) resume; (4) fork at an explicit cut point.
// Usage: bun test/probes/msp-host-override.ts [--muse-bin PATH]
// Exits 0 with a JSON summary on stdout, 1 with {ok:false,...} on failure.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMspConnection } from "@muse-code/sdk";
import { museChildEnv } from "../../src/msp/contributor.js";
import { FakeMeta, reply, roleTexts, toolNames, type Json } from "../helpers/fake-meta.js";
import { startMcpStub } from "./mcp-stub.js";

const SYSTEM = "You are the host-override probe agent.";
const MODEL = "muse-spark-1.3";

type Params = Record<string, unknown>;
interface Event {
  method: string;
  params: Params;
}

function fail(check: string, message: string): never {
  throw new Error(`[${check}] ${message}`);
}

function assert(cond: unknown, check: string, message: string): void {
  if (!cond) fail(check, message);
}

function makeCollector() {
  const events: Event[] = [];
  let lastCursor: string | undefined;
  return {
    events,
    push(method: string, params: Params) {
      events.push({ method, params });
      if (typeof params.viewCursor === "string") lastCursor = params.viewCursor;
    },
    get cursor() {
      return lastCursor;
    },
    async waitFor(predicate: (e: Event) => boolean, fromIndex: number, timeoutMs: number, what: string): Promise<Event> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.slice(fromIndex).find(predicate);
        if (found) return found;
        if (Date.now() > deadline) fail("wait", `timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}

function outputsOf(body: Json): Array<[string, string]> {
  return (body.input ?? []).filter((i: Json) => i.type === "function_call_output").map((i: Json) => [i.call_id, typeof i.output === "string" ? i.output : JSON.stringify(i.output)]);
}

async function main(): Promise<void> {
  const museBinFlag = process.argv.indexOf("--muse-bin");
  const museBin = museBinFlag >= 0 ? process.argv[museBinFlag + 1] : "muse";
  const museVersion = execFileSync(museBin, ["--version"], { encoding: "utf8" }).trim();

  const root = mkdtempSync(join(tmpdir(), "muse-host-override-"));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const home = join(root, "home");
    // The host config dir must contain BOTH settings.json (below) and the
    // auth.json written above: without auth.json in the private dir, muse
    // ignores the endpoint overlay and fails with authRequired
    // (bisected 2026-11-01). The auth file is probe-authored fake content,
    // never a real credential.
    const cwd = join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "--quiet", "-b", "main", cwd]);
    execFileSync("git", ["-C", cwd, "config", "user.name", "Muse Probe"]);
    execFileSync("git", ["-C", cwd, "config", "user.email", "muse-probe@example.invalid"]);
    writeFileSync(join(cwd, "README.md"), "Temporary host-override probe workspace.\n");
    execFileSync("git", ["-C", cwd, "add", "README.md"]);
    execFileSync("git", ["-C", cwd, "commit", "--quiet", "-m", "probe workspace"]);

    const fake = new FakeMeta();
    await fake.start();

    const xdg = join(root, "xdg");
    const museDir = join(xdg, "muse");
    mkdirSync(museDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(museDir, "auth.json"), JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "unused" } } }), { mode: 0o600 });

    const listEnv = museChildEnv({
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(root, "xdg"),
      TBH_CREDENTIAL_BACKEND: "file",
      TBH_DISABLE_TELEMETRY: "1",
    });
    let skillsOff: Record<string, Record<string, "off">> = {};
    try {
      const stdout = execFileSync(museBin, ["skills", "list", "--json"], { encoding: "utf8", env: listEnv, timeout: 30_000, maxBuffer: 16 << 20 });
      const parsed = JSON.parse(stdout);
      const rows: Array<{ scope?: string; path?: string }> = Array.isArray(parsed) ? parsed : (parsed.skills ?? []);
      for (const row of rows) if (row.scope && row.path) (skillsOff[row.scope] ??= {})[row.path] = "off";
    } catch { skillsOff = {}; }
    const callsDir = join(root, "mcp-calls");
    const token = randomBytes(24).toString("hex");
    const stub = await startMcpStub(callsDir, token);

    mkdirSync(join(xdg, "muse"), { recursive: true, mode: 0o700 });
    writeFileSync(join(xdg, "muse", "settings.json"), JSON.stringify({
      schema_version: 1,
      run: {
        system_prompt: SYSTEM,
        toolset: ["mcp__probe__*"],
        workflow_trigger_mode: "off",
        context_usage_message_enabled: false,
        context_slimming: { meta_context_note_enabled: false, session_identity_enabled: false },
      },
      runtime_capabilities: Object.fromEntries(
        ["goal-reminder", "verify-reminder", "skill-reminder", "todo-reminder", "memory", "scope-reminder"]
          .map((r) => [`plugin:tbh-reminders:reminder:${r}`, { enabled: false }]),
      ),
      skills: { activation: skillsOff },
      context: { foreign_personal_rules: false, foreign_personal_skills: false },
      context_compaction: { soft_threshold: 0.99, hard_threshold: 0.995 },
      mcp_servers: {
        probe: {
          transport: "streamable_http",
          url: `${stub.url}`,
          headers: { Authorization: `Bearer ${token}` },
          mode: "required",
          tool_timeout_sec: 7 * 24 * 3600,
          startup_timeout_sec: 30,
        },
      },
      endpoint_transport: { base_url: fake.baseUrl, auth: "bearer" },
    }), { mode: 0o600 });

    const childEnv = museChildEnv({
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      TBH_CREDENTIAL_BACKEND: "file",
      TBH_DISABLE_TELEMETRY: "1",
    });

    const decided = new Set<string>();
    async function openHost() {
      const collector = makeCollector();
      const handshake = spawnMspConnection({
        command: museBin,
        args: ["serve", "--contributor-mode", "off", "--disable-request-user-input"],
        cwd,
        env: childEnv,
        onStderr: () => {},
      });
      handshake.onNotification((n) => {
        collector.push(n.method, (n.params ?? {}) as Params);
        const p = (n.params ?? {}) as Params;
        if (n.method === "approval/requested" && typeof p.approvalId === "string") void approve(connection, p);
      });
      handshake.onServerRequest(async (r) => {
        if (r.method === "approval/request") void approve(connection, (r.params ?? {}) as Params);
        return {};
      });
      const spawned = await handshake.initialize({
        clientInfo: { name: "opencode_muse_probe", version: "0.0.0" },
        capabilities: { experimentalApi: true, requestedCapabilities: ["rawLog"] },
      });
      const connection = spawned.connection;
      return { spawned, connection, collector };
    }

    async function approve(connection: { command(m: string, p: Params): Promise<unknown> }, p: Params): Promise<void> {
      const approvalId = p.approvalId as string | undefined;
      if (!approvalId || decided.has(approvalId)) return;
      const choices = (p.availableChoices ?? []) as Array<{ choiceId?: string; decision?: string }>;
      const choice = choices.find((c) => c.decision === "approved") ?? choices.find((c) => typeof c.decision === "string" && c.decision.startsWith("approved"));
      if (!choice?.choiceId) return;
      decided.add(approvalId);
      try {
        await connection.command("approval/decide", {
          sessionId: (p.sessionId as string) ?? "",
          approvalId,
          choiceId: choice.choiceId,
          requirementId: p.currentRequirementId,
        });
      } catch { /* probe auto-approval is best-effort */ }
    }

    async function startSession(connection: { command(m: string, p: Params): Promise<any> }): Promise<string> {
      const result = await connection.command("session/start", { workspaceRoot: cwd, modelId: MODEL, approvalMode: "allowAll" });
      const sessionId = result?.session?.sessionId;
      assert(typeof sessionId === "string", "override", "session/start returned no session id");
      return sessionId;
    }

    async function runTurn(
      connection: { command(m: string, p: Params): Promise<any> },
      collector: ReturnType<typeof makeCollector>,
      sessionId: string,
      text: string,
    ): Promise<{ turnId: string; fromIndex: number }> {
      const fromIndex = collector.events.length;
      const ack = await connection.command("turn/start", { sessionId, input: [{ type: "text", text }], reasoningEffort: "low" });
      assert(typeof ack?.turnId === "string", "turn", "turn/start returned no turn id");
      const completed = await collector.waitFor(
        (e) => e.method === "turn/completed" && (e.params.turnId === ack.turnId || (e.params.item as { turnId?: string } | undefined)?.turnId === ack.turnId),
        fromIndex,
        90_000,
        "turn/completed",
      );
      assert(completed.params.terminal === "completed", "turn", `turn ended ${completed.params.terminal} ${JSON.stringify({ error: completed.params.error, reason: completed.params.reason }).slice(0, 500)}`);
      return { turnId: ack.turnId as string, fromIndex };
    }

    // Checks 1+2 share one session: override on the first turn, rawLog on the second.
    let sessionId = "";
    let secondTurnId = "";
    {
      const host = await openHost();
      try {
        assert(host.spawned.initializeResult.grantedCapabilities.includes("rawLog"), "rawLog", "rawLog capability not granted");
        sessionId = await startSession(host.connection);
        // Check 1: prompt/toolset override, one request per turn.
        fake.queue(() => reply({ text: "hello from muse" }));
        {
          const before = fake.bodies.length;
          await runTurn(host.connection, host.collector, sessionId, "first");
          assert(fake.bodies.length - before === 1, "override", `expected 1 model request, saw ${fake.bodies.length - before}`);
          const body = fake.bodies[before]!;
          assert(body.instructions === SYSTEM, "override", "model instructions are not the host prompt");
          assert(JSON.stringify(toolNames(body).sort()) === JSON.stringify(["mcp__probe/bash", "mcp__probe/read"]), "override", `unexpected toolset ${JSON.stringify(toolNames(body))}`);
          const developer = roleTexts(body, "developer").join("\n");
          assert(developer.length < 4000, "override", `developer context too large (${developer.length} chars)`);
          assert(!developer.includes("skill-catalog"), "override", "Muse skill catalog leaked into context");
        }
        // Check 2: rawLog all-calls + parked turn.
        const streams = (await host.connection.command("log/streams", { sessionId })) as any;
        const stream = (streams.streams ?? []).map((s: any) => s.stream).find((s: any) => s?.kind === "session") ?? { kind: "session", id: sessionId };
        await host.connection.command("log/subscribe", { sessionId, stream });
        fake.queue(
          () => reply({ reasoning: ["Plan: read both."], text: "Reading.", calls: [{ name: "mcp__probe.read", args: { path: "a.txt" }, id: "call_a" }, { name: "mcp__probe.bash", args: { command: "ls" }, id: "call_b" }] }),
          () => reply({ text: "both read" }),
        );
        const before = fake.bodies.length;
        const fromIndex = host.collector.events.length;
        const ack = (await host.connection.command("turn/start", { sessionId, input: [{ type: "text", text: "second" }], reasoningEffort: "low" })) as any;
        secondTurnId = ack.turnId;
        const toolCalls = await host.collector.waitFor(
          (e) => e.method === "log/record" && (e.params.record as any)?.payload?.event?.kind === "assistant_tool_calls_committed",
          fromIndex,
          90_000,
          "assistant_tool_calls_committed",
        );
        const committed = ((toolCalls.params.record as any).payload.event.tool_calls ?? []).map((c: any) => String(c.call_id)).sort();
        assert(JSON.stringify(committed) === JSON.stringify(["call_a", "call_b"]), "rawLog", `expected both calls up front, saw ${JSON.stringify(committed)}`);
        await new Promise((r) => setTimeout(r, 10_000));
        const parkedTerminal = host.collector.events.slice(fromIndex).find((e) => e.method === "turn/completed");
        assert(!parkedTerminal, "rawLog", "turn completed while tool calls were still parked");
        appendFileSync(join(callsDir, "calls.jsonl"), "");
        writeFileSync(join(callsDir, "call_a.json"), JSON.stringify({ text: "A CONTENTS" }));
        writeFileSync(join(callsDir, "call_b.json"), JSON.stringify({ text: "x y" }));
        const completed = await host.collector.waitFor(
          (e) => e.method === "turn/completed" && e.params.turnId === secondTurnId,
          fromIndex,
          120_000,
          "turn/completed after release",
        );
        assert(completed.params.terminal === "completed", "rawLog", `turn ended ${completed.params.terminal}`);
        assert(fake.bodies.length - before === 2, "rawLog", `expected continuation request, saw ${fake.bodies.length - before - 1} extra`);
        const continued = outputsOf(fake.bodies[before + 1]!);
        assert(JSON.stringify(continued) === JSON.stringify([["call_a", "A CONTENTS"], ["call_b", "x y"]]), "rawLog", `tool results not delivered: ${JSON.stringify(continued)}`);
      } finally {
        await host.spawned.close().catch(() => {});
        await host.spawned.exited.catch(() => {});
      }
    }

    // Check 3: resume continues from Muse's own record.
    {
      const host = await openHost();
      try {
        const resumed = (await host.connection.command("session/resume", { sessionId, excludeItems: true })) as any;
        assert(typeof resumed?.session?.sessionId === "string", "resume", "session/resume returned no session");
        fake.queue(() => reply({ text: "three" }));
        await runTurn(host.connection, host.collector, sessionId, "third");
        const users = roleTexts(fake.bodies[fake.bodies.length - 1]!, "user");
        assert(JSON.stringify(users) === JSON.stringify(["first", "second", "third"]), "resume", `history not replayed from Muse record: ${JSON.stringify(users)}`);
      } finally {
        await host.spawned.close().catch(() => {});
        await host.spawned.exited.catch(() => {});
      }
    }

    // Check 4: fork at the completed tool turn branches cleanly.
    {
      const host = await openHost();
      try {
        const forked = (await host.connection.command("session/fork", { sessionId, cutPoint: { lastTurnId: secondTurnId }, excludeItems: true })) as any;
        const forkId = forked?.session?.sessionId;
        assert(typeof forkId === "string" && forkId !== sessionId, "fork", "session/fork did not branch");
        fake.queue(() => reply({ text: "branched" }));
        await runTurn(host.connection, host.collector, forkId, "other second");
        const users = roleTexts(fake.bodies[fake.bodies.length - 1]!, "user");
        assert(JSON.stringify(users) === JSON.stringify(["first", "second", "other second"]), "fork", `fork did not branch cleanly: ${JSON.stringify(users)}`);
      } finally {
        await host.spawned.close().catch(() => {});
        await host.spawned.exited.catch(() => {});
      }
    }

    await stub.close();
    await fake.close();
    console.log(JSON.stringify({
      ok: true,
      museVersion,
      checks: { override: true, rawLog: true, resume: true, fork: true },
    }));
  } finally {
    cleanup();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    process.exit(1);
  },
);
