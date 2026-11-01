import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoopbackMcpServer } from "../../src/mcp/loopback.js";

const servers: LoopbackMcpServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function clientFor(server: LoopbackMcpServer) {
  const client = new Client({ name: "loopback-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } });
  await client.connect(transport);
  return { client, transport };
}

const TOOLS = [{
  name: "opencode_write",
  description: "Write a file through OpenCode.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}];

describe("loopback MCP bridge", () => {
  test("loopbackMcp.servesToolsAndParksCallsUntilResolved", async () => {
    const parked: Array<{ callId: string; toolName: string; args: unknown }> = [];
    const server = new LoopbackMcpServer({
      sessionKey: "ses_loop_1",
      tools: TOOLS,
      onParked: (info) => { parked.push(info); },
    });
    servers.push(server);
    await server.listen();
    const { client, transport } = await clientFor(server);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["opencode_write"]);

      const delivered = client.callTool({ name: "opencode_write", arguments: { path: "a.txt" }, _meta: { callId: "call_1" } });
      for (let attempt = 0; attempt < 100 && parked.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(parked).toEqual([{ callId: "call_1", toolName: "opencode_write", args: { path: "a.txt" } }]);
      expect(server.pendingCount()).toBe(1);
      expect(server.resolve("call_1", { text: "written" })).toBe(true);
      const result = await delivered as { content: Array<{ text?: string }>; isError?: boolean };
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("written");
      expect(server.pendingCount()).toBe(0);
    } finally {
      await transport.close();
    }
  });

  test("loopbackMcp.rejectsUnknownCallsAndBadAuth", async () => {
    const server = new LoopbackMcpServer({ sessionKey: "ses_loop_2", tools: TOOLS });
    servers.push(server);
    await server.listen();

    expect(server.resolve("no-such-call", { text: "x" })).toBe(false);
    const bad = new Client({ name: "loopback-test", version: "0.0.0" });
    const badTransport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: "Bearer wrong" } },
    });
    await expect(bad.connect(badTransport)).rejects.toThrow();
    await badTransport.close().catch(() => {});

    const { client, transport } = await clientFor(server);
    try {
      await expect(client.callTool({ name: "no-such-tool", arguments: {} })).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });

  test("loopbackMcp.timeoutEvictsQueueAndSettlesId", async () => {
    const server = new LoopbackMcpServer({ sessionKey: "ses_loop_timeout", tools: TOOLS, toolTimeoutMs: 60 });
    servers.push(server);
    await server.listen();
    const { client, transport } = await clientFor(server);
    try {
      const delivered = client.callTool({ name: "opencode_write", arguments: { path: "slow.txt" }, _meta: { callId: "call_slow" } });
      delivered.catch(() => {});
      for (let attempt = 0; attempt < 200 && server.pendingCount() !== 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(server.pendingCount()).toBe(0);
      await expect(delivered).rejects.toThrow(/timed out/);
      // The corpse must never surface as a live call, and a late duplicate
      // must read as settled (skip), not unknown (throw).
      expect(server.takeParked()).toBeUndefined();
      expect(server.wasResolved("call_slow")).toBe(true);
      expect(server.resolve("call_slow", { text: "late" })).toBe(false);
    } finally {
      await transport.close();
    }
  });

  test("loopbackMcp.failEvictsQueueAndSettlesId", async () => {
    const server = new LoopbackMcpServer({ sessionKey: "ses_loop_fail", tools: TOOLS, onParked: () => {} });
    servers.push(server);
    await server.listen();
    const { client, transport } = await clientFor(server);
    try {
      const delivered = client.callTool({ name: "opencode_write", arguments: {}, _meta: { callId: "call_denied" } });
      delivered.catch(() => {});
      for (let attempt = 0; attempt < 100 && server.pendingCount() === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(server.fail("call_denied", "denied by test")).toBe(true);
      await expect(delivered).rejects.toThrow(/denied by test/);
      expect(server.takeParked()).toBeUndefined();
      expect(server.wasResolved("call_denied")).toBe(true);
    } finally {
      await transport.close();
    }
  });

  test("loopbackMcp.settledIdsStayBounded", async () => {
    const server = new LoopbackMcpServer({ sessionKey: "ses_loop_cap", tools: TOOLS, maxSettledIds: 10 });
    servers.push(server);
    await server.listen();
    const { client, transport } = await clientFor(server);
    try {
      const total = 12;
      const deliveries: Array<Promise<unknown>> = [];
      for (let i = 0; i < total; i += 1) {
        deliveries.push(client.callTool({ name: "opencode_write", arguments: { i }, _meta: { callId: `cap_${i}` } }).catch(() => {}));
      }
      for (let attempt = 0; attempt < 200 && server.pendingCount() < total; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(server.pendingCount()).toBe(total);
      for (let i = 0; i < total; i += 1) {
        expect(server.resolve(`cap_${i}`, { text: "ok" })).toBe(true);
      }
      await Promise.all(deliveries);
      expect(server.wasResolved(`cap_${total - 1}`)).toBe(true);
      expect(server.wasResolved("cap_0")).toBe(false);
      expect(server.wasResolved("cap_1")).toBe(false);
      expect(server.wasResolved("cap_2")).toBe(true);
    } finally {
      await transport.close();
    }
  });

  test("loopbackMcp.closeRejectsParkedCalls", async () => {
    const server = new LoopbackMcpServer({
      sessionKey: "ses_loop_3",
      tools: TOOLS,
      onParked: () => {},
    });
    servers.push(server);
    await server.listen();
    let settled = "pending";
    const { client, transport } = await clientFor(server);
    const delivered = client.callTool({ name: "opencode_write", arguments: {}, _meta: { callId: "call_9" } });
    delivered.then(
      () => { settled = "resolved"; },
      () => { settled = "rejected"; },
    );
    for (let attempt = 0; attempt < 100 && server.pendingCount() === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await server.close();
    await delivered.catch(() => {});
    await transport.close().catch(() => {});

    expect(settled).toBe("rejected");
    expect(server.pendingCount()).toBe(0);
  });
});
