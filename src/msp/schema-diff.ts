import { createHash } from "node:crypto";

/**
 * Offline schema-evolution check for policy #21.
 *
 * Compares MSP stable-schema snapshots and classifies the delta on the
 * protocol surfaces this plugin actually uses. Additive growth passes with
 * notes; removals, new required fields, dropped properties, or envelope
 * version bumps on the curated surface fail closed for human review.
 *
 * Failing closed on uncertainty is deliberate: a false positive costs a
 * human classification pass, while a false negative ships against a
 * contract the bridge was never tested with.
 */

export const SCHEMA_SECTIONS = ["methods", "requests", "notifications", "errors", "capabilities"] as const;
export type SchemaSection = (typeof SCHEMA_SECTIONS)[number];

/** Methods the bridge sends. Each name verified at a call site in src (manager, provider, language-model). */
export const CURATED_METHODS: readonly string[] = [
  "model/list", // src/provider.ts catalog fetch
  "session/start", // src/session/manager.ts resolveSession
  "session/resume", // src/session/manager.ts restart recovery
  "session/setModel", // src/session/manager.ts + src/model/language-model.ts selection routing
  "turn/start", // src/model/language-model.ts agent turns
  "turn/interrupt", // src/model/language-model.ts abort path
  "turn/unqueue", // src/model/language-model.ts abort path
  "media/upload", // src/model/language-model.ts video uploads
  "view/subscribe", // src/msp/host.ts cursor replay via MspClient
  "view/page", // src/model/language-model.ts view/gap recovery
  "userInput/answer", // src/msp/host.ts answers conversational verdicts
  "userInput/cancel", // src/msp/host.ts fails conversational verdicts closed
];

/**
 * Server-to-client requests the bridge parks for a conversational verdict
 * instead of failing with method-not-found (no fabricated answers).
 */
export const CURATED_REQUESTS: readonly string[] = [
  "approval/request", // src/msp/host.ts parks for a conversational verdict
  "userInput/request", // src/msp/host.ts parks for a conversational verdict
];

/** Notifications the bridge consumes in src/model/stream.ts and src/model/language-model.ts. */
export const CURATED_NOTIFICATIONS: readonly string[] = [
  "item/started",
  "item/delta",
  "item/completed",
  "turn/completed",
  "turn/foregroundCompleted",
  "turn/retracted",
  "turn/unqueued",
  "session/tokenUsage",
  "view/gap",
];

export interface SchemaExportManifest {
  fingerprint: string;
  schemaVersion: number;
  experimental: boolean;
}

export interface SchemaExport {
  manifest: SchemaExportManifest;
  schema: Record<string, unknown>;
}

export interface DefRecord {
  digest: string;
  required: string[] | null;
  props: string[] | null;
}

export interface SchemaSnapshot {
  cli_version: string;
  fingerprint: string;
  schema_version: number | null;
  experimental?: boolean;
  provenance?: string;
  surface: Record<SchemaSection, string[] | null>;
  member_digests?: Record<string, Record<string, string>>;
  defs?: Record<string, DefRecord>;
  /** Legacy v1 field: whole-section $defs digest only. Superseded by defs. */
  defs_digests?: Record<string, string>;
  sections_digest: Record<string, string>;
}

export type FindingSeverity = "breaking" | "note";

export interface DiffFinding {
  severity: FindingSeverity;
  kind: string;
  detail: string;
}

export interface Classification {
  ok: boolean;
  findings: DiffFinding[];
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

function sha256Hex(canonicalJson: string): string {
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === "string")) return null;
  return [...value].sort();
}

/** Stable name for one section member, or null when it cannot be named. */
function memberName(section: SchemaSection, entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    if (section === "errors" && typeof record.kind === "string") return record.kind;
    if (typeof record.name === "string") return record.name;
  }
  return null;
}

function sectionEntries(section: SchemaSection, schema: Record<string, unknown>): Array<{ name: string; digest: string }> | null {
  const raw = schema[section];
  const entries: Array<{ name: string; digest: string }> = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const name = memberName(section, entry);
      if (name === null) return null;
      entries.push({ name, digest: sha256Hex(canonical(entry)) });
    }
    return entries;
  }
  if (raw !== null && typeof raw === "object") {
    if (section === "capabilities") {
      const record = raw as Record<string, unknown>;
      const grantable = record.grantable;
      if (!Array.isArray(grantable)) return null;
      for (const entry of grantable) {
        const name = memberName(section, entry);
        if (name === null) return null;
        entries.push({ name, digest: sha256Hex(canonical(entry)) });
      }
      return entries;
    }
    for (const [name, body] of Object.entries(raw as Record<string, unknown>)) {
      entries.push({ name, digest: sha256Hex(canonical(body)) });
    }
    return entries;
  }
  return null;
}

function defRecord(body: unknown): DefRecord | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const properties = record.properties;
  return {
    digest: sha256Hex(canonical(body)),
    required: stringArray(record.required),
    props: properties !== null && typeof properties === "object" && !Array.isArray(properties)
      ? Object.keys(properties).sort()
      : null,
  };
}

/** Builds the ledger snapshot for one offline CLI schema export. */
export function snapshotExport(cliVersion: string, provenance: string, exp: SchemaExport): SchemaSnapshot {
  if (typeof exp?.manifest?.fingerprint !== "string" || typeof exp?.manifest?.schemaVersion !== "number") {
    throw new Error("schema-diff: export manifest must carry a fingerprint string and numeric schemaVersion");
  }
  if (exp.schema === null || typeof exp.schema !== "object" || Array.isArray(exp.schema)) {
    throw new Error("schema-diff: export schema must be an object");
  }
  const surface = {} as Record<SchemaSection, string[] | null>;
  const member_digests: Record<string, Record<string, string>> = {};
  const sections_digest: Record<string, string> = {};
  for (const section of SCHEMA_SECTIONS) {
    const entries = sectionEntries(section, exp.schema);
    surface[section] = entries === null ? null : entries.map((e) => e.name).sort();
    if (entries !== null && (section === "methods" || section === "requests" || section === "notifications")) {
      member_digests[section] = Object.fromEntries(entries.map((e) => [e.name, e.digest]));
    }
    sections_digest[section] = sha256Hex(canonical(exp.schema[section] ?? null));
  }
  const rawDefs = exp.schema.$defs;
  if (rawDefs === null || typeof rawDefs !== "object" || Array.isArray(rawDefs)) {
    throw new Error("schema-diff: export schema must carry a $defs object");
  }
  const defs: Record<string, DefRecord> = {};
  for (const [name, body] of Object.entries(rawDefs as Record<string, unknown>)) {
    const record = defRecord(body);
    if (record === null) throw new Error(`schema-diff: $defs member is not an object: ${name}`);
    defs[name] = record;
  }
  sections_digest.$defs = sha256Hex(canonical(exp.schema.$defs));
  return {
    cli_version: cliVersion,
    fingerprint: exp.manifest.fingerprint,
    schema_version: exp.manifest.schemaVersion,
    experimental: exp.manifest.experimental,
    provenance,
    surface,
    member_digests,
    defs,
    sections_digest,
  };
}

/** Collects `#/$defs/<Name>` targets reachable from roots over new-side bodies. */
export function collectRefs(roots: Record<string, unknown>, defs: Record<string, unknown>): Set<string> {
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(value);
      if (match && !seen.has(match[1]!)) {
        seen.add(match[1]!);
        const body = (defs as Record<string, unknown>)[match[1]!];
        if (body !== undefined) visit(body);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) visit(v);
    }
  };
  for (const root of Object.values(roots)) visit(root);
  return seen;
}

function curatedFor(section: SchemaSection): ReadonlySet<string> {
  if (section === "methods") return new Set(CURATED_METHODS);
  if (section === "requests") return new Set(CURATED_REQUESTS);
  if (section === "notifications") return new Set(CURATED_NOTIFICATIONS);
  return new Set();
}

function requireSurface(snap: SchemaSnapshot, which: "old" | "new"): void {
  if (snap === null || typeof snap !== "object") throw new Error(`schema-diff: ${which} snapshot is not an object`);
  const surface = (snap as SchemaSnapshot).surface;
  if (surface === null || typeof surface !== "object" || Array.isArray(surface)) {
    throw new Error(`schema-diff: ${which} snapshot has no surface record`);
  }
  for (const section of SCHEMA_SECTIONS) {
    const value = (surface as Record<string, unknown>)[section];
    if (!Array.isArray(value) && value !== null) {
      throw new Error(`schema-diff: ${which} snapshot surface.${section} is malformed`);
    }
  }
}

export interface ClassifyOptions {
  /**
   * New-side bodies for reachability attribution: { members: name->body, defs: name->body }.
   * When absent (snapshot-vs-snapshot), changed/removed defs fall back to conservative rules.
   */
  newBodies?: { members: Record<string, unknown>; defs: Record<string, unknown> };
}

/** Classifies old-vs-new snapshots. Breaking findings fail closed for human review. */
export function classifySnapshots(oldSnap: SchemaSnapshot, newSnap: SchemaSnapshot, options: ClassifyOptions = {}): Classification {
  requireSurface(oldSnap, "old");
  requireSurface(newSnap, "new");
  const findings: DiffFinding[] = [];
  if (oldSnap.schema_version === null || oldSnap.schema_version === undefined ||
      newSnap.schema_version === null || newSnap.schema_version === undefined) {
    throw new Error("schema-diff: both snapshots must carry a schema_version");
  }
  if (oldSnap.schema_version !== newSnap.schema_version) {
    findings.push({
      severity: "breaking",
      kind: "envelope-version-changed",
      detail: `envelope schema version ${String(oldSnap.schema_version)} -> ${String(newSnap.schema_version)}`,
    });
  }
  const oldMembers = oldSnap.member_digests;
  const newMembers = newSnap.member_digests;
  const memberLevel = oldMembers !== undefined && oldMembers !== null && newMembers !== undefined && newMembers !== null;
  if (!memberLevel) {
    findings.push({
      severity: "note",
      kind: "member-level-unavailable",
      detail: "member-level digests absent on one side; falling back to set-level comparison",
    });
  }
  for (const section of SCHEMA_SECTIONS) {
    const oldNames = new Set(oldSnap.surface[section] ?? []);
    const newNames = new Set(newSnap.surface[section] ?? []);
    const curated = curatedFor(section);
    for (const name of [...newNames].filter((n) => !oldNames.has(n)).sort()) {
      findings.push({ severity: "note", kind: `${section}-added`, detail: `${section} added: ${name}` });
    }
    for (const name of [...oldNames].filter((n) => !newNames.has(n)).sort()) {
      if (curated.has(name)) {
        findings.push({ severity: "breaking", kind: `${section}-removed`, detail: `${section} removed curated member: ${name}` });
      } else {
        findings.push({ severity: "note", kind: `${section}-removed`, detail: `${section} removed non-curated member: ${name}` });
      }
    }
    if (memberLevel && (section === "methods" || section === "requests" || section === "notifications")) {
      const oldMap = oldMembers?.[section] ?? {};
      const newMap = newMembers?.[section] ?? {};
      for (const name of [...oldNames].filter((n) => newNames.has(n)).sort()) {
        if (oldMap[name] !== newMap[name]) {
          if (curated.has(name)) {
            findings.push({ severity: "breaking", kind: `${section}-changed`, detail: `${section} changed curated member shape: ${name}` });
          } else {
            findings.push({ severity: "note", kind: `${section}-changed`, detail: `${section} changed non-curated member shape: ${name}` });
          }
        }
      }
    }
  }
  // Reachability over new-side bodies scopes nested def changes to what the bridge can observe.
  let reachable: Set<string> | null = null;
  if (options.newBodies) {
    const roots: Record<string, unknown> = {};
    for (const name of [...CURATED_METHODS, ...CURATED_REQUESTS, ...CURATED_NOTIFICATIONS]) {
      if (options.newBodies.members[name] !== undefined) roots[name] = options.newBodies.members[name];
    }
    reachable = collectRefs(roots, options.newBodies.defs);
  }
  const oldDefs = oldSnap.defs ?? {};
  const newDefs = newSnap.defs ?? {};
  const defsDetailed = oldSnap.defs !== undefined && newSnap.defs !== undefined;
  if (!defsDetailed) {
    findings.push({
      severity: "note",
      kind: "defs-unavailable",
      detail: "per-def records absent on one side; nested changes covered only by member shapes where available",
    });
  } else {
    const names = new Set([...Object.keys(oldDefs), ...Object.keys(newDefs)]);
    for (const name of [...names].sort()) {
      const oldDef = oldDefs[name];
      const newDef = newDefs[name];
      if (!oldDef) {
        findings.push({ severity: "note", kind: "def-added", detail: `$defs added: ${name}` });
        continue;
      }
      if (!newDef) {
        if (reachable !== null && reachable.has(name)) {
          findings.push({ severity: "breaking", kind: "def-removed", detail: `$defs removed reachable def: ${name}` });
        } else {
          findings.push({ severity: "note", kind: "def-removed", detail: `$defs removed: ${name}${reachable === null ? " (reachability unknown: snapshot-vs-snapshot)" : " (unreachable from curated surface)"}` });
        }
        continue;
      }
      if (oldDef.digest === newDef.digest) continue;
      const requiredAdded = (newDef.required ?? []).filter((r) => !(oldDef.required ?? []).includes(r));
      const propsRemoved = (oldDef.props ?? []).filter((p) => !(newDef.props ?? []).includes(p));
      const breakingShape = requiredAdded.length > 0 || propsRemoved.length > 0;
      const isReachable = reachable === null ? null : reachable.has(name);
      if (breakingShape && (isReachable === null || isReachable)) {
        findings.push({
          severity: "breaking",
          kind: "def-changed",
          detail: `$defs changed${isReachable === null ? " (reachability unknown: snapshot-vs-snapshot)" : " (reachable from curated surface)"}: ${name}` +
            `${requiredAdded.length > 0 ? ` required+${requiredAdded.join(",")}` : ""}${propsRemoved.length > 0 ? ` props-${propsRemoved.join(",")}` : ""}`,
        });
      } else {
        findings.push({
          severity: "note",
          kind: "def-changed",
          detail: `$defs changed: ${name} (additive or unreachable: breaking only if a curated member shape changed, reported above)`,
        });
      }
    }
  }
  return { ok: !findings.some((f) => f.severity === "breaking"), findings };
}
