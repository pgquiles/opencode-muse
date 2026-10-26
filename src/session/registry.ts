import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, win32 } from "node:path";
import {
  RegistryCorruptError,
  RegistryStorageError,
  RegistryValidationError,
  RegistryWorkspaceMismatchError,
} from "../errors.js";

const REGISTRY_VERSION = 1;
const MAX_ENTRY_BYTES = 1_048_576;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_V7_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@+_-]{1,512}$/;
const METHOD_PATTERN = /^[a-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)+$/;
const MAX_PATH_SYMLINKS = 40;

export interface PendingCommandRecord {
  method: string;
  fingerprint: string;
}

export interface SessionRegistryEntry {
  openCodeSessionId: string;
  museSessionId: string;
  hostId: string;
  workspaceFingerprint: string;
  providerId?: string;
  modelId?: string;
  profileId?: string;
  viewCursor?: string;
  activeTurnId?: string;
  transcriptFingerprints: string[];
  compactionFingerprints: string[];
  pendingCommands: Record<string, PendingCommandRecord>;
  updatedAt: number;
}

export type SessionRegistryEntryInput = Omit<SessionRegistryEntry, "updatedAt">;

export interface ResolveStateDirectoryOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform | "win32";
}

export interface SessionRegistryOptions extends ResolveStateDirectoryOptions {
  stateDirectory?: string;
  now?: () => number;
}

/** Resolve existing path components while retaining a normalized not-yet-created suffix. */
function canonicalPath(path: string, platform: NodeJS.Platform | "win32"): string {
  const pathApi = platform === "win32" ? win32 : posix;
  if (platform !== process.platform) return pathApi.resolve(path);

  const absolute = pathApi.resolve(path);
  const root = pathApi.parse(absolute).root;
  let current = root;
  let remaining = absolute.slice(root.length).split(pathApi.sep).filter(Boolean);
  let followedSymlinks = 0;

  while (remaining.length > 0) {
    const [component, ...rest] = remaining;
    const candidate = pathApi.join(current, component!);
    let stats;
    try {
      stats = lstatSync(candidate);
    } catch (error) {
      // A missing component ends filesystem traversal; normalize the remaining suffix lexically.
      if (isMissingFile(error)) return pathApi.resolve(current, ...remaining);
      throw new RegistryValidationError();
    }

    if (stats.isSymbolicLink()) {
      followedSymlinks += 1;
      if (followedSymlinks > MAX_PATH_SYMLINKS) throw new RegistryValidationError();
      let target: string;
      try {
        target = readlinkSync(candidate);
      } catch {
        throw new RegistryValidationError();
      }
      const absoluteTarget = pathApi.isAbsolute(target)
        ? pathApi.resolve(target)
        : pathApi.resolve(current, target);
      const targetRoot = pathApi.parse(absoluteTarget).root;
      current = targetRoot;
      remaining = [
        ...absoluteTarget.slice(targetRoot.length).split(pathApi.sep).filter(Boolean),
        ...rest,
      ];
      continue;
    }

    try {
      current = realpathSync(candidate);
    } catch {
      throw new RegistryValidationError();
    }
    remaining = rest;
  }

  return pathApi.resolve(current);
}

/** Refuse a caller-selected state root inside Muse's CLI-owned config directory. */
export function assertSafeStateDirectory(path: string, options: ResolveStateDirectoryOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const pathApi = windows ? win32 : posix;
  const configuredHome = env.XDG_CONFIG_HOME;
  const configHome = requiredString(configuredHome) && pathApi.isAbsolute(configuredHome)
    ? configuredHome
    : pathApi.join(homeDirectory, ".config");
  const museConfigDirectory = canonicalPath(pathApi.join(configHome, "muse"), platform);
  const canonicalStateDirectory = canonicalPath(path, platform);
  const relativePath = pathApi.relative(museConfigDirectory, canonicalStateDirectory);
  const outsideMuseConfig = relativePath === ".."
    || relativePath.startsWith(`..${pathApi.sep}`)
    || pathApi.isAbsolute(relativePath);
  if (!outsideMuseConfig) throw new RegistryValidationError();
  return canonicalStateDirectory;
}

interface RegistryEnvelope {
  version: number;
  entry: SessionRegistryEntry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new RegistryValidationError();
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validHashList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && HASH_PATTERN.test(item));
}

function normalizeEntry(input: unknown, now: () => number): SessionRegistryEntry {
  if (!isRecord(input)) throw new RegistryValidationError();
  assertOnlyKeys(input, [
    "openCodeSessionId", "museSessionId", "hostId", "workspaceFingerprint", "providerId", "modelId", "profileId",
    "viewCursor", "activeTurnId", "transcriptFingerprints", "compactionFingerprints", "pendingCommands", "updatedAt",
  ]);
  if (
    typeof input.openCodeSessionId !== "string"
    || !IDENTIFIER_PATTERN.test(input.openCodeSessionId)
    || typeof input.museSessionId !== "string"
    || !IDENTIFIER_PATTERN.test(input.museSessionId)
    || typeof input.hostId !== "string"
    || !IDENTIFIER_PATTERN.test(input.hostId)
    || typeof input.workspaceFingerprint !== "string"
    || !HASH_PATTERN.test(input.workspaceFingerprint)
    || !validHashList(input.transcriptFingerprints)
    || !validHashList(input.compactionFingerprints)
    || !isRecord(input.pendingCommands)
  ) throw new RegistryValidationError();

  for (const optional of ["providerId", "modelId", "profileId", "viewCursor", "activeTurnId"] as const) {
    if (input[optional] !== undefined && !requiredString(input[optional])) throw new RegistryValidationError();
  }
  if (input.updatedAt !== undefined && (typeof input.updatedAt !== "number" || !Number.isFinite(input.updatedAt))) {
    throw new RegistryValidationError();
  }

  const pendingCommands: Record<string, PendingCommandRecord> = Object.create(null) as Record<string, PendingCommandRecord>;
  for (const [commandId, raw] of Object.entries(input.pendingCommands)) {
    if (!UUID_V7_PATTERN.test(commandId) || !isRecord(raw)) throw new RegistryValidationError();
    assertOnlyKeys(raw, ["method", "fingerprint"]);
    if (typeof raw.method !== "string" || !METHOD_PATTERN.test(raw.method)
      || typeof raw.fingerprint !== "string" || !HASH_PATTERN.test(raw.fingerprint)) {
      throw new RegistryValidationError();
    }
    pendingCommands[commandId] = { method: raw.method, fingerprint: raw.fingerprint };
  }

  return {
    openCodeSessionId: input.openCodeSessionId,
    museSessionId: input.museSessionId,
    hostId: input.hostId,
    workspaceFingerprint: input.workspaceFingerprint,
    ...(input.providerId !== undefined ? { providerId: input.providerId as string } : {}),
    ...(input.modelId !== undefined ? { modelId: input.modelId as string } : {}),
    ...(input.profileId !== undefined ? { profileId: input.profileId as string } : {}),
    ...(input.viewCursor !== undefined ? { viewCursor: input.viewCursor as string } : {}),
    ...(input.activeTurnId !== undefined ? { activeTurnId: input.activeTurnId as string } : {}),
    transcriptFingerprints: [...input.transcriptFingerprints],
    compactionFingerprints: [...input.compactionFingerprints],
    pendingCommands,
    updatedAt: (input.updatedAt as number | undefined) ?? now(),
  };
}

function sessionFileName(openCodeSessionId: string): string {
  return `${createHash("sha256").update(openCodeSessionId).digest("hex")}.json`;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Some platforms do not permit fsync on a directory handle.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export class SessionRegistry {
  private readonly directory: string;
  private readonly now: () => number;

  constructor(options: SessionRegistryOptions = {}) {
    const stateDirectory = assertSafeStateDirectory(
      options.stateDirectory ?? SessionRegistry.resolveStateDirectory(options),
      options,
    );
    this.directory = join(stateDirectory, "sessions");
    this.now = options.now ?? Date.now;
  }

  static resolveStateDirectory(options: ResolveStateDirectoryOptions = {}): string {
    const env = options.env ?? process.env;
    const homeDirectory = options.homeDirectory ?? homedir();
    const platform = options.platform ?? process.platform;
    let stateDirectory: string;
    if (platform === "win32") {
      const base = env.LOCALAPPDATA;
      stateDirectory = joinWin32(requiredString(base) && win32.isAbsolute(base) ? base : win32.join(homeDirectory, "AppData", "Local"), "opencode-muse");
    } else {
      const dataHome = env.XDG_DATA_HOME;
      const base = requiredString(dataHome) && isAbsolute(dataHome) ? dataHome : join(homeDirectory, ".local", "share");
      stateDirectory = join(base, "opencode-muse");
    }
    return assertSafeStateDirectory(stateDirectory, options);
  }

  async get(openCodeSessionId: string, workspaceFingerprint: string): Promise<SessionRegistryEntry | undefined> {
    this.assertLookup(openCodeSessionId, workspaceFingerprint);
    const entry = await this.readEntry(openCodeSessionId);
    if (entry && entry.workspaceFingerprint !== workspaceFingerprint) throw new RegistryWorkspaceMismatchError();
    return entry;
  }

  async getForOpenCodeSession(openCodeSessionId: string): Promise<SessionRegistryEntry | undefined> {
    if (!IDENTIFIER_PATTERN.test(openCodeSessionId)) throw new RegistryValidationError();
    return this.readEntry(openCodeSessionId);
  }

  async recordCompactionCandidate(openCodeSessionId: string, fingerprint: string): Promise<void> {
    if (!IDENTIFIER_PATTERN.test(openCodeSessionId) || !HASH_PATTERN.test(fingerprint)) throw new RegistryValidationError();
    const entry = await this.readEntry(openCodeSessionId);
    if (!entry) return;
    this.write({ ...entry, compactionFingerprints: [fingerprint], updatedAt: this.now() });
  }

  async clearCompactionCandidate(openCodeSessionId: string, fingerprint: string): Promise<void> {
    if (!IDENTIFIER_PATTERN.test(openCodeSessionId) || !HASH_PATTERN.test(fingerprint)) throw new RegistryValidationError();
    const entry = await this.readEntry(openCodeSessionId);
    if (!entry || !entry.compactionFingerprints.includes(fingerprint)) return;
    this.write({
      ...entry,
      compactionFingerprints: entry.compactionFingerprints.filter((candidate) => candidate !== fingerprint),
      updatedAt: this.now(),
    });
  }

  private async readEntry(openCodeSessionId: string): Promise<SessionRegistryEntry | undefined> {
    const path = this.entryPath(openCodeSessionId);
    if (!existsSync(path)) return undefined;
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new RegistryStorageError();
    }
    if (stat.size > MAX_ENTRY_BYTES) return this.quarantine(path);

    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new RegistryStorageError();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      return this.quarantine(path);
    }

    try {
      if (!isRecord(parsed)) throw new RegistryValidationError();
      assertOnlyKeys(parsed, ["version", "entry"]);
      if (parsed.version !== REGISTRY_VERSION) throw new RegistryValidationError();
      if (!isRecord(parsed.entry) || typeof parsed.entry.updatedAt !== "number" || !Number.isFinite(parsed.entry.updatedAt)) {
        throw new RegistryValidationError();
      }
      const entry = normalizeEntry(parsed.entry, this.now);
      if (entry.openCodeSessionId !== openCodeSessionId) throw new RegistryValidationError();
      return entry;
    } catch (error) {
      return this.quarantine(path);
    }
  }

  async put(input: SessionRegistryEntryInput): Promise<SessionRegistryEntry> {
    if (isRecord(input) && Object.hasOwn(input, "updatedAt")) throw new RegistryValidationError();
    const entry = normalizeEntry(input, this.now);
    const previous = await this.get(entry.openCodeSessionId, entry.workspaceFingerprint);
    if (previous && previous.workspaceFingerprint !== entry.workspaceFingerprint) {
      throw new RegistryWorkspaceMismatchError();
    }
    this.write(entry);
    return entry;
  }

  async updateCursor(openCodeSessionId: string, workspaceFingerprint: string, viewCursor: string): Promise<void> {
    if (!requiredString(viewCursor)) throw new RegistryValidationError();
    const entry = await this.requireEntry(openCodeSessionId, workspaceFingerprint);
    this.write({ ...entry, viewCursor, updatedAt: this.now() });
  }

  async recordPendingCommand(
    openCodeSessionId: string,
    workspaceFingerprint: string,
    pending: { commandId: string; method: string; fingerprint: string },
  ): Promise<void> {
    if (!UUID_V7_PATTERN.test(pending.commandId) || !METHOD_PATTERN.test(pending.method) || !HASH_PATTERN.test(pending.fingerprint)) {
      throw new RegistryValidationError();
    }
    const entry = await this.requireEntry(openCodeSessionId, workspaceFingerprint);
    this.write({
      ...entry,
      pendingCommands: { ...entry.pendingCommands, [pending.commandId]: { method: pending.method, fingerprint: pending.fingerprint } },
      updatedAt: this.now(),
    });
  }

  async clearPendingCommand(openCodeSessionId: string, workspaceFingerprint: string, commandId: string): Promise<void> {
    const entry = await this.requireEntry(openCodeSessionId, workspaceFingerprint);
    if (!(commandId in entry.pendingCommands)) return;
    const pendingCommands = { ...entry.pendingCommands };
    delete pendingCommands[commandId];
    this.write({ ...entry, pendingCommands, updatedAt: this.now() });
  }

  /**
   * Drop the whole entry: the stuck turn is abandoned and the Muse linkage
   * with it, so the next resolve starts a fresh session. A missing entry is
   * already the desired end state.
   */
  async deleteEntry(openCodeSessionId: string, workspaceFingerprint: string): Promise<void> {
    const entry = await this.get(openCodeSessionId, workspaceFingerprint);
    if (!entry) return;
    try {
      unlinkSync(this.entryPath(openCodeSessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RegistryStorageError();
    }
  }

  private async requireEntry(openCodeSessionId: string, workspaceFingerprint: string): Promise<SessionRegistryEntry> {
    const entry = await this.get(openCodeSessionId, workspaceFingerprint);
    if (!entry) throw new RegistryValidationError();
    return entry;
  }

  private assertLookup(openCodeSessionId: string, workspaceFingerprint: string): void {
    if (!requiredString(openCodeSessionId) || !HASH_PATTERN.test(workspaceFingerprint)) throw new RegistryValidationError();
  }

  private entryPath(openCodeSessionId: string): string {
    return join(this.directory, sessionFileName(openCodeSessionId));
  }

  private write(entry: SessionRegistryEntry): void {
    try {
      ensurePrivateDirectory(dirname(this.directory));
      ensurePrivateDirectory(this.directory);
    } catch {
      throw new RegistryStorageError();
    }
    const path = this.entryPath(entry.openCodeSessionId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ version: REGISTRY_VERSION, entry })}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
      chmodSync(path, 0o600);
      syncDirectory(this.directory);
    } catch {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* preserve the original storage failure */ }
      }
      try { unlinkSync(temporary); } catch { /* best-effort temp cleanup */ }
      throw new RegistryStorageError();
    }
  }

  private quarantine(path: string): undefined {
    try {
      const quarantinePath = `${path}.corrupt-${this.now()}-${randomUUID()}`;
      renameSync(path, quarantinePath);
      chmodSync(quarantinePath, 0o600);
      syncDirectory(this.directory);
    } catch {
      throw new RegistryCorruptError();
    }
    return undefined;
  }
}

function joinWin32(base: string, child: string): string {
  return win32.join(base, child);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
