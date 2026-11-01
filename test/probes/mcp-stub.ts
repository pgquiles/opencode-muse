// Minimal stateless streamable-HTTP MCP server for the host-override probe
// (#42). It serves two tools (read, bash) so `run.toolset` has something to
// select, parks each tools/call until the probe driver writes the result
// file, then returns it. Coordination: startMcpStub(callsDir, token) returns
// the server URL; the stub appends each call to calls.jsonl and polls for
// <callId>.json (120s cap). Settings shape mirrors pi-muse-subscription's
// proven streamable_http host config. Nothing here is product code.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

export type Json = Record<string, any>;

const TOOLS = [
  { name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "bash", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];

function frame(v: unknown): string {
  return `data: ${JSON.stringify(v)}\n\n`;
}

export interface McpStub {
  url: string;
  close(): Promise<void>;
}

export async function startMcpStub(callsDir: string, token: string): Promise<McpStub> {
  mkdirSync(callsDir, { recursive: true });
  const logPath = join(callsDir, "calls.jsonl");

  async function handleCall(id: unknown, params: any): Promise<Json> {
    const metaCallId = params?._meta?.callId;
    const callId = typeof metaCallId === "string" && metaCallId.length > 0 ? metaCallId : `nocall-${Date.now()}`;
    appendFileSync(logPath, JSON.stringify({ callId, name: params?.name, arguments: params?.arguments ?? {} }) + "\n");
    const resultPath = join(callsDir, `${callId}.json`);
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (existsSync(resultPath)) {
        try {
          const result = JSON.parse(readFileSync(resultPath, "utf8"));
          return { content: [{ type: "text", text: result.text ?? "(no output)" }] };
        } catch {
          throw new Error("stub: unreadable result file");
        }
      }
      if (Date.now() > deadline) throw new Error("stub: result file never arrived");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function route(message: any): Promise<Json | undefined> {
    if (message.id === undefined || message.id === null) return undefined; // notification
    const { id, method, params } = message;
    switch (method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "probe-stub", version: "0.0.0" } } };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call":
        try {
          return { jsonrpc: "2.0", id, result: await handleCall(id, params) };
        } catch (e) {
          return { jsonrpc: "2.0", id, error: { code: -32603, message: String((e as Error)?.message ?? e) } };
        }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `stub: unsupported method ${method}` } };
    }
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on("error", () => {});
    res.on("error", () => {});
    req.socket.on("error", () => {});
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    let raw = "";
    if (process.env.MCP_STUB_VERBOSE) process.stderr.write(`[mcp-stub] ${req.method} ${req.url}\n`);
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let messages: any[];
      try {
        const parsed = JSON.parse(raw || "null");
        messages = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        res.writeHead(400).end();
        return;
      }
      const responses: Json[] = [];
      for (const m of messages) {
        const r = await route(m);
        if (r !== undefined) responses.push(r);
      }
      if (responses.length === 0) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(responses.map(frame).join(""));
    });
  });
  server.on("error", (e) => process.stderr.write(`[mcp-stub] server error: ${String((e as Error)?.message ?? e)}\n`));
  server.on("clientError", (_e, socket) => { try { socket.destroy(); } catch {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  writeFileSync(join(callsDir, "ready"), "ready\n");
  return {
    url,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
