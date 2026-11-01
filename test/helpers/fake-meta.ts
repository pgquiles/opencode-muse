// A loopback Meta Responses endpoint for driving a real `muse serve`
// offline: it records every request body and answers each from a script.
// Pattern precedent: pi-muse-subscription test/fake-meta.ts (#42). No live
// calls, no credentials; the harness points muse at this server through the
// settings overlay's endpoint_transport.
import { createServer, type Server } from "node:http";

export type Json = Record<string, any>;
export type Responder = (body: Json) => string | Promise<string>;

const sse = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const frame = (status: string, extra: Json = {}) => ({ id: "resp_fake", object: "response", model: "muse-spark-1.3", status, output: [], ...extra });
const usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 7, total_tokens: 127 };

export interface Reply {
  reasoning?: string[];
  text?: string;
  calls?: { name: string; args: Json; id: string }[];
}

/** One model response as a Responses API event stream. */
export function reply(r: Reply): string {
  let seq = 1;
  const out: string[] = [sse({ type: "response.created", sequence_number: seq++, response: frame("in_progress") })];
  const items: Json[] = [];
  let index = 0;
  if (r.reasoning) {
    const id = "rs_fake";
    const item = { type: "reasoning", id, summary: r.reasoning.map((text) => ({ type: "summary_text", text })) };
    out.push(sse({ type: "response.output_item.added", sequence_number: seq++, output_index: index, item: { type: "reasoning", id, summary: [] } }));
    r.reasoning.forEach((text, k) => {
      out.push(sse({ type: "response.reasoning_summary_part.added", sequence_number: seq++, item_id: id, output_index: index, summary_index: k, part: { type: "summary_text", text: "" } }));
      out.push(sse({ type: "response.reasoning_summary_text.delta", sequence_number: seq++, item_id: id, output_index: index, summary_index: k, delta: text }));
      out.push(sse({ type: "response.reasoning_summary_text.done", sequence_number: seq++, item_id: id, output_index: index, summary_index: k, text }));
      out.push(sse({ type: "response.reasoning_summary_part.done", sequence_number: seq++, item_id: id, output_index: index, summary_index: k, part: { type: "summary_text", text } }));
    });
    out.push(sse({ type: "response.output_item.done", sequence_number: seq++, output_index: index, item }));
    items.push(item);
    index++;
  }
  if (r.text !== undefined) {
    const id = `msg_${index}`;
    const item = { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text: r.text, annotations: [] }] };
    out.push(sse({ type: "response.output_item.added", sequence_number: seq++, output_index: index, item: { ...item, status: "in_progress", content: [] } }));
    out.push(sse({ type: "response.content_part.added", sequence_number: seq++, item_id: id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    for (const piece of r.text.match(/.{1,8}/gs) ?? []) out.push(sse({ type: "response.output_text.delta", sequence_number: seq++, item_id: id, output_index: index, content_index: 0, delta: piece }));
    out.push(sse({ type: "response.output_text.done", sequence_number: seq++, item_id: id, output_index: index, content_index: 0, text: r.text }));
    out.push(sse({ type: "response.content_part.done", sequence_number: seq++, item_id: id, output_index: index, content_index: 0, part: { type: "output_text", text: r.text, annotations: [] } }));
    out.push(sse({ type: "response.output_item.done", sequence_number: seq++, item_id: id, output_index: index, item }));
    items.push(item);
    index++;
  }
  for (const c of r.calls ?? []) {
    const item = { type: "function_call", id: `fc_${c.id}`, call_id: c.id, name: c.name, arguments: JSON.stringify(c.args), status: "completed" };
    out.push(sse({ type: "response.output_item.added", sequence_number: seq++, output_index: index, item: { ...item, arguments: "", status: "in_progress" } }));
    out.push(sse({ type: "response.function_call_arguments.delta", sequence_number: seq++, item_index: index, output_index: index, item_id: item.id, delta: item.arguments }));
    out.push(sse({ type: "response.function_call_arguments.done", sequence_number: seq++, output_index: index, item_id: item.id, arguments: item.arguments }));
    out.push(sse({ type: "response.output_item.done", sequence_number: seq++, output_index: index, item }));
    items.push(item);
    index++;
  }
  out.push(sse({ type: "response.completed", sequence_number: seq++, response: frame("completed", { output: items, usage }) }));
  return out.join("");
}

export class FakeMeta {
  readonly bodies: Json[] = [];
  private script: Responder[] = [];
  private server?: Server;
  baseUrl = "";

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      if (req.method === "GET" && req.url?.endsWith("/muse-code/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: ["muse-spark-1.3", "muse-wonder-1.0"].map((id) => ({ id, object: "model", metadata: { "muse-code": { release_date: "2026-01-01", is_hidden: false, limit: { context: 1_000_000, output: 4096 } } } })) }));
        return;
      }
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        let body: Json;
        try {
          body = JSON.parse(raw);
        } catch {
          body = { raw };
        }
        this.bodies.push(body);
        const next = this.script.shift() ?? (() => reply({ text: "done" }));
        const text = await next(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(text);
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }

  queue(...responders: Responder[]): void {
    this.script.push(...responders);
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }
}

/** The texts of a request's input items with the given role. */
export function roleTexts(body: Json, role: string): string[] {
  return (body.input ?? [])
    .filter((i: Json) => i.role === role)
    .map((i: Json) => (typeof i.content === "string" ? i.content : (i.content ?? []).map((p: Json) => p.text ?? "").join("")));
}

/** The tool names a request offers, namespaced tools flattened to `ns/name`. */
export function toolNames(body: Json): string[] {
  return (body.tools ?? []).flatMap((t: Json) => (t.type === "namespace" ? (t.tools ?? []).map((x: Json) => `${t.name}/${x.name}`) : [t.name ?? t.type]));
}
