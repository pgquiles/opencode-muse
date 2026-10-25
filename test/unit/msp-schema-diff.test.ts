import { describe, expect, test } from "bun:test";
import {
  CURATED_METHODS,
  CURATED_NOTIFICATIONS,
  CURATED_REQUESTS,
  classifySnapshots,
  collectRefs,
  snapshotExport,
  type SchemaExport,
  type SchemaSnapshot,
} from "../../src/msp/schema-diff.js";

function makeExport(overrides: {
  methods?: Record<string, unknown>;
  notifications?: Record<string, unknown>;
  defs?: Record<string, unknown>;
  fingerprint?: string;
  schemaVersion?: number;
} = {}): SchemaExport {
  return {
    manifest: {
      fingerprint: overrides.fingerprint ?? "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schemaVersion: overrides.schemaVersion ?? 1,
      experimental: false,
    },
    schema: {
      methods: overrides.methods ?? { "model/list": { type: "object" }, "turn/start": { type: "object" } },
      requests: {},
      notifications: overrides.notifications ?? { "turn/completed": { type: "object" } },
      errors: [],
      capabilities: {},
      $defs: overrides.defs ?? {},
    },
  };
}

function snap(exp: SchemaExport, version: string): SchemaSnapshot {
  return snapshotExport(version, "test provenance", exp);
}

describe("schemaDiff.curatedSurface", () => {
  test("pins the protocol methods the bridge actually calls", () => {
    for (const method of ["model/list", "session/start", "session/resume", "session/setModel", "turn/start", "turn/interrupt", "turn/unqueue", "media/upload", "view/subscribe", "view/page"]) {
      expect(CURATED_METHODS).toContain(method);
    }
  });

  test("pins the notifications the bridge actually consumes", () => {
    for (const notification of ["item/started", "item/delta", "item/completed", "turn/completed", "turn/foregroundCompleted", "turn/retracted", "turn/unqueued", "session/tokenUsage", "view/gap"]) {
      expect(CURATED_NOTIFICATIONS).toContain(notification);
    }
  });

  test("pins the server requests the bridge parks for a verdict", () => {
    expect(CURATED_REQUESTS).toContain("approval/request");
    expect(CURATED_REQUESTS).toContain("userInput/request");
  });
});

describe("schemaDiff.classifySnapshots", () => {
  test("identical snapshots pass with no findings", () => {
    const oldSnap = snap(makeExport(), "1.4.12");
    const result = classifySnapshots(oldSnap, snap(makeExport(), "1.4.13"));
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test("added methods anywhere pass with a note", () => {
    const oldSnap = snap(makeExport(), "1.4.12");
    const next = snap(makeExport({ methods: { "model/list": { type: "object" }, "turn/start": { type: "object" }, "shiny/new": { type: "object" } } }), "1.4.13");
    const result = classifySnapshots(oldSnap, next);
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.severity === "note" && f.detail.includes("shiny/new"))).toBe(true);
  });

  test("removed curated method fails closed", () => {
    const oldSnap = snap(makeExport(), "1.4.12");
    const next = snap(makeExport({ methods: { "model/list": { type: "object" } } }), "1.4.13");
    const result = classifySnapshots(oldSnap, next);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.severity === "breaking" && f.detail.includes("turn/start"))).toBe(true);
  });

  test("removed non-curated method passes with a note", () => {
    const oldSnap = snap(makeExport({ methods: { "model/list": { type: "object" }, "turn/start": { type: "object" }, "legacy/unused": { type: "object" } } }), "1.4.12");
    const next = snap(makeExport(), "1.4.13");
    const result = classifySnapshots(oldSnap, next);
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.severity === "note" && f.detail.includes("legacy/unused"))).toBe(true);
  });

  test("changed curated member shape fails closed", () => {
    const oldSnap = snap(makeExport(), "1.4.12");
    const next = snap(makeExport({ methods: { "model/list": { type: "object" }, "turn/start": { type: "object", required: ["commandId", "sessionId", "brandNewRequired"] } } }), "1.4.13");
    const result = classifySnapshots(oldSnap, next);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.severity === "breaking" && f.detail.includes("turn/start"))).toBe(true);
  });

  test("changed non-curated member shape passes with a note", () => {
    const oldSnap = snap(makeExport({ methods: { "model/list": { type: "object" }, "turn/start": { type: "object" }, "legacy/unused": { v: 1 } } }), "1.4.12");
    const next = snap(makeExport({ methods: { "model/list": { type: "object" }, "turn/start": { type: "object" }, "legacy/unused": { v: 2 } } }), "1.4.13");
    const result = classifySnapshots(oldSnap, next);
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.severity === "note" && f.detail.includes("legacy/unused"))).toBe(true);
  });

  test("envelope version change fails closed", () => {
    const oldSnap = snap(makeExport(), "1.4.12");
    const next = snap(makeExport({ schemaVersion: 2 }), "1.4.13");
    const result = classifySnapshots(oldSnap, next);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.severity === "breaking" && f.detail.includes("2"))).toBe(true);
  });

  test("snapshots without member digests fall back to set-level comparison", () => {
    const oldSnap = snap(makeExport(), "1.4.12");
    const thin = { ...oldSnap, member_digests: undefined, defs_digests: undefined } as unknown as SchemaSnapshot;
    const result = classifySnapshots(thin, snap(makeExport(), "1.4.13"));
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.detail.includes("member-level"))).toBe(true);
  });

  test("malformed snapshots throw instead of passing", () => {
    const good = snap(makeExport(), "1.4.13");
    expect(() => classifySnapshots({} as SchemaSnapshot, good)).toThrow();
    expect(() => classifySnapshots(good, { ...good, surface: undefined } as unknown as SchemaSnapshot)).toThrow();
  });

  test("def with only added optional properties passes with a note", () => {
    const item = { type: "object", properties: { itemId: { type: "string" } }, required: ["itemId"] };
    const oldSnap = snap(makeExport({ defs: { Item: item } }), "1.4.12");
    const next = snap(makeExport({
      defs: { Item: { type: "object", properties: { itemId: { type: "string" }, replayHint: { type: "string" } }, required: ["itemId"] } },
    }), "1.4.13");
    const result = classifySnapshots(oldSnap, next);
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.severity === "note" && f.detail.includes("Item"))).toBe(true);
  });

  test("def with a new required field fails closed", () => {
    const item = { type: "object", properties: { itemId: { type: "string" } }, required: ["itemId"] };
    const oldSnap = snap(makeExport({ defs: { Item: item } }), "1.4.12");
    const next = snap(makeExport({
      defs: { Item: { type: "object", properties: { itemId: { type: "string" }, owner: { type: "string" } }, required: ["itemId", "owner"] } },
    }), "1.4.13");
    const result = classifySnapshots(oldSnap, next);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.severity === "breaking" && f.detail.includes("Item"))).toBe(true);
  });

  test("removed def passes with a note when reachability is unknown", () => {
    const oldSnap = snap(makeExport({ defs: { Old: { type: "string" } } }), "1.4.12");
    const next = snap(makeExport({ defs: {} }), "1.4.13");
    const result = classifySnapshots(oldSnap, next);
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.severity === "note" && f.detail.includes("Old"))).toBe(true);
  });

  test("collectRefs follows transitive refs from curated members", () => {
    const members = { "turn/start": { params: { $ref: "#/$defs/TurnParams" } } };
    const defs = {
      TurnParams: { properties: { input: { $ref: "#/$defs/TurnInput" } } },
      TurnInput: { type: "string" },
      Unrelated: { type: "string" },
    };
    expect(collectRefs(members, defs)).toEqual(new Set(["TurnParams", "TurnInput"]));
  });

  test("changed def unreachable from curated surface passes with a note", () => {
    const oldSnap = snap(makeExport({
      methods: { "turn/start": { params: { $ref: "#/$defs/TurnParams" } } },
      defs: {
        TurnParams: { type: "object", properties: {}, required: [] },
        Far: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      },
    }), "1.4.12");
    const nextExp = makeExport({
      methods: { "turn/start": { params: { $ref: "#/$defs/TurnParams" } } },
      defs: {
        TurnParams: { type: "object", properties: {}, required: [] },
        Far: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
      },
    });
    const next = snap(nextExp, "1.4.13");
    const newBodies = {
      members: nextExp.schema.methods as Record<string, unknown>,
      defs: nextExp.schema.$defs as Record<string, unknown>,
    };
    const result = classifySnapshots(oldSnap, next, { newBodies });
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.severity === "note" && f.detail.includes("Far"))).toBe(true);
  });

  test("removed def referenced from curated surface fails closed with bodies", () => {
    const oldSnap = snap(makeExport({
      methods: { "turn/start": { params: { $ref: "#/$defs/TurnParams" } } },
      defs: { TurnParams: { type: "object" } },
    }), "1.4.12");
    const nextExp = makeExport({
      methods: { "turn/start": { params: { $ref: "#/$defs/TurnParams" } } },
      defs: {},
    });
    const next = snap(nextExp, "1.4.13");
    const newBodies = {
      members: nextExp.schema.methods as Record<string, unknown>,
      defs: nextExp.schema.$defs as Record<string, unknown>,
    };
    const result = classifySnapshots(oldSnap, next, { newBodies });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.severity === "breaking" && f.detail.includes("TurnParams"))).toBe(true);
  });
});
