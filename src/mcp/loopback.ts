import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface LoopbackToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ParkedCall {
  callId: string;
  toolName: string;
  args: unknown;
}

export interface LoopbackMcpOptions {
  sessionKey: string;
  tools: LoopbackToolDefinition[];
  onParked?: (call: ParkedCall) => void;
  toolTimeoutMs?: number;
  /** Bound on settled ids remembered for duplicate suppression (default 1000). */
  maxSettledIds?: number;
}

/**
 * Upper bound on settled call ids remembered for duplicate suppression.
 * Sessions never park this many calls; the cap only bites in a runaway, and
 * insertion order makes the trim first-in-first-out.
 */
const MAX_SETTLED_CALL_IDS = 1000;

/**
 * OpenCode tools as an in-process loopback MCP server (streamable HTTP,
 * Pi's parked-call shape). One instance per Muse session: its own path and
 * Bearer [REDACTED] A tool call's HTTP request stays open until the bridge resolves
 * the parked call with the OpenCode tool result, so the server never times
 * requests out; Muse's own tool timeout is configured in the session's
 * bridge-authored settings. Closing the server rejects every parked call —
 * a dead bridge never leaves Muse waiting silently.
 */
export class LoopbackMcpServer {
  readonly token: string;
  private readonly sessionKey: string;
  private address = "";
  private tools: LoopbackToolDefinition[];
  private readonly onParked?: (call: ParkedCall) => void;
  private readonly toolTimeoutMs: number;
  private readonly pending = new Map<string, {
    resolve: (text: string) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly parkedQueue: ParkedCall[] = [];
  private readonly parkedWaiters = new Set<(call: ParkedCall) => void>();
  private readonly maxSettledIds: number;
  /**
   * Settled ids: resolved, timed out, failed, or torn down. A late duplicate
   * (slow tool result, history resend) reads as settled and is skipped;
   * only an id never parked reads as unknown. Survives across turns because
   * retained history resends old results; bounded FIFO so a session cannot
   * grow it without limit.
   */
  private readonly resolvedIds = new Set<string>();
  private server?: Server;
  private listening?: Promise<number>;
  private readonly inflight = new Set<Promise<void>>();
  private closed = false;

  constructor(options: LoopbackMcpOptions) {
    this.sessionKey = options.sessionKey;
    this.tools = options.tools.map((tool) => ({ ...tool }));
    this.onParked = options.onParked;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 10 * 60 * 1000;
    this.maxSettledIds = options.maxSettledIds ?? MAX_SETTLED_CALL_IDS;
    this.token = randomBytes(24).toString("hex");
  }

  get url(): string {
    return this.address;
  }

  private path(): string {
    return `/mcp/${this.sessionKey}`;
  }

  async listen(): Promise<number> {
    if (this.listening) {
      return this.listening;
    }
    this.listening = new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => void this.handle(request, response));
      server.requestTimeout = 0;
      server.timeout = 0;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        this.server = server;
        this.address = `http://127.0.0.1:${(server.address() as { port: number }).port}${this.path()}`;
        resolve((server.address() as { port: number }).port);
      });
    });
    return this.listening;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** Replace the served tool list (synced from OpenCode's forwarded tools). */
  setTools(tools: LoopbackToolDefinition[]): void {
    this.tools = tools.map((tool) => ({ ...tool }));
  }

  /** Next queued parked call, if any. */
  takeParked(): ParkedCall | undefined {
    return this.parkedQueue.shift();
  }

  /**
   * Wait for the next parked call without removing it; the consumer still
   * takes it. A synchronously queued call resolves immediately.
   */
  watchParked(): { wait: Promise<ParkedCall>; cancel(): void } {
    const queued = this.parkedQueue[0];
    if (queued) return { wait: Promise.resolve(queued), cancel: () => {} };
    let cancel = () => {};
    const wait = new Promise<ParkedCall>((resolve) => {
      const notify = (call: ParkedCall) => {
        this.parkedWaiters.delete(notify);
        resolve(call);
      };
      this.parkedWaiters.add(notify);
      cancel = () => {
        this.parkedWaiters.delete(notify);
      };
    });
    return { wait, cancel };
  }

  has(callId: string): boolean {
    return this.pending.has(callId);
  }

  wasResolved(callId: string): boolean {
    return this.resolvedIds.has(callId);
  }

  resolve(callId: string, result: { text: string }): boolean {
    const parked = this.pending.get(callId);
    if (!parked) return false;
    this.pending.delete(callId);
    clearTimeout(parked.timer);
    this.rememberSettled(callId);
    parked.resolve(result.text);
    return true;
  }

  fail(callId: string, message: string): boolean {
    const parked = this.pending.get(callId);
    if (!parked) return false;
    this.pending.delete(callId);
    clearTimeout(parked.timer);
    this.evictQueued(callId);
    this.rememberSettled(callId);
    parked.reject(new Error(message));
    return true;
  }

  /**
   * Drop a queued entry that will never be consumed (timeout, failure):
   * leaving the corpse would surface it later as a live tool call for an
   * id the bridge no longer holds.
   */
  private evictQueued(callId: string): void {
    const index = this.parkedQueue.findIndex((parked) => parked.callId === callId);
    if (index >= 0) this.parkedQueue.splice(index, 1);
  }

  private rememberSettled(callId: string): void {
    if (this.resolvedIds.has(callId)) return;
    while (this.resolvedIds.size >= this.maxSettledIds) {
      const oldest = this.resolvedIds.values().next().value;
      if (oldest === undefined) break;
      this.resolvedIds.delete(oldest);
    }
    this.resolvedIds.add(callId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.parkedQueue.length = 0;
    this.parkedWaiters.clear();
    for (const [callId, parked] of this.pending) {
      this.pending.delete(callId);
      clearTimeout(parked.timer);
      this.rememberSettled(callId);
      parked.reject(new Error("Loopback MCP server closed with the call still parked."));
    }
    // Let rejected calls answer their HTTP requests before tearing down:
    // destroying the socket first would leave MCP clients hanging.
    const inflight = [...this.inflight];
    if (inflight.length > 0) {
      await Promise.race([
        Promise.allSettled(inflight),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    if (!server) return;
    // Destroy remaining connections: a parked tool call holds its HTTP
    // request open, and server.close would wait for it forever.
    try {
      server.closeAllConnections?.();
    } catch {
      // Best effort; the close below still runs.
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const task = this.handleInner(request, response);
    this.inflight.add(task);
    try {
      await task;
    } finally {
      this.inflight.delete(task);
    }
  }

  private async handleInner(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if ((request.url ?? "").split("?")[0] !== this.path()) {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        response.writeHead(401).end();
        return;
      }
      let raw = "";
      request.setEncoding("utf8");
      for await (const chunk of request) raw += chunk;
      const server = new McpServer({ name: "opencode-muse-loopback", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: this.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: { type: "object", ...(tool.inputSchema as object ?? {}) },
        })) as never,
      }));
      server.setRequestHandler(CallToolRequestSchema, async (call) => {
        const params = call.params as { name?: unknown; arguments?: unknown; _meta?: { callId?: unknown } };
        const toolName = typeof params.name === "string" ? params.name : "";
        if (!this.tools.some((tool) => tool.name === toolName)) {
          throw new Error(`Unknown loopback tool: ${toolName || "(missing)"}`);
        }
        const callId = typeof params._meta?.callId === "string" && params._meta.callId.length > 0
          ? params._meta.callId
          : null;
        if (callId === null || this.pending.has(callId)) {
          throw new Error("Loopback call needs a fresh client call id.");
        }
        if (this.closed) throw new Error("Loopback MCP server is closed.");
        const text = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(callId);
            this.evictQueued(callId);
            this.rememberSettled(callId);
            reject(new Error(`Loopback tool call ${callId} timed out waiting for the OpenCode result.`));
          }, this.toolTimeoutMs);
          timer.unref?.();
          this.pending.set(callId, { resolve, reject, timer });
          const parked: ParkedCall = { callId, toolName, args: params.arguments ?? {} };
          this.parkedQueue.push(parked);
          for (const notify of [...this.parkedWaiters]) {
            try {
              notify(parked);
            } catch {
              // A throwing waiter must not break the parked call.
            }
          }
          this.parkedWaiters.clear();
          try {
            this.onParked?.(parked);
          } catch {
            // A throwing observer must not break the parked call.
          }
        });
        return { content: [{ type: "text", text }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  }
}
