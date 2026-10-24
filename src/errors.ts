export type MuseBridgeErrorCode =
  | "MUSE_HOST_START_FAILED"
  | "MUSE_STARTUP_TIMEOUT"
  | "MUSE_COMMAND_TIMEOUT"
  | "MUSE_REQUEST_TIMEOUT"
  | "MUSE_COMMAND_REJECTED"
  | "MUSE_PROTOCOL_ERROR"
  | "MUSE_TRANSPORT_ERROR"
  | "MUSE_HOST_CLOSED"
  | "MUSE_REGISTRY_ERROR"
  | "MUSE_REGISTRY_STORAGE_ERROR"
  | "MUSE_WORKSPACE_BUSY"
  | "MUSE_WORKSPACE_LOCK_CORRUPT"
  | "MUSE_TURN_FAILED"
  | "MUSE_TURN_UNQUEUED"
  | "MUSE_UNSUPPORTED_REQUEST"
  | "MUSE_UNSUPPORTED_INPUT"
  | "MUSE_RECOVERY_CHOICE_REQUIRED"
  | "MUSE_TRANSCRIPT_DIVERGED"
  | "MUSE_APPROVAL_PENDING";

/** Safe plugin error: never attach raw CLI stderr, MSP text, prompts, or payloads. */
export class MuseBridgeError extends Error {
  constructor(
    readonly code: MuseBridgeErrorCode,
    message: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "MuseBridgeError";
  }
}

export class MspStartupTimeoutError extends MuseBridgeError {
  constructor(readonly timeoutMs: number) {
    super("MUSE_STARTUP_TIMEOUT", `Muse host did not initialize within ${timeoutMs}ms`, true);
    this.name = "MspStartupTimeoutError";
  }
}

export class MspCommandTimeoutError extends MuseBridgeError {
  readonly outcomeMayBeUnknown = true;

  constructor(readonly method: string, readonly timeoutMs: number) {
    super("MUSE_COMMAND_TIMEOUT", `Muse command ${method} timed out; its outcome may be unknown`, false);
    this.name = "MspCommandTimeoutError";
  }
}

export class MspRequestTimeoutError extends MuseBridgeError {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super("MUSE_REQUEST_TIMEOUT", `Muse request ${method} timed out`, true);
    this.name = "MspRequestTimeoutError";
  }
}

export class MspCommandRejectedError extends MuseBridgeError {
  constructor(
    readonly method: string,
    readonly mspCode: number,
    readonly mspKind: string,
    retryable?: boolean,
  ) {
    super("MUSE_COMMAND_REJECTED", `Muse rejected command ${method} (${mspKind}, ${mspCode})`, retryable);
    this.name = "MspCommandRejectedError";
  }
}

export class MspProtocolError extends MuseBridgeError {
  constructor(readonly method?: string) {
    super("MUSE_PROTOCOL_ERROR", method ? `Muse protocol error during ${method}` : "Muse protocol error", false);
    this.name = "MspProtocolError";
  }
}

export class MspTransportError extends MuseBridgeError {
  constructor(readonly method?: string) {
    super("MUSE_TRANSPORT_ERROR", method ? `Muse transport failed during ${method}` : "Muse transport failed", true);
    this.name = "MspTransportError";
  }
}

export class MspHostClosedError extends MuseBridgeError {
  constructor() {
    super("MUSE_HOST_CLOSED", "Muse host is closed", false);
    this.name = "MspHostClosedError";
  }
}

export class MspHostStartError extends MuseBridgeError {
  constructor(readonly reason: "spawn-failed" | "host-exited" | "initialize-rejected" | "unknown") {
    super("MUSE_HOST_START_FAILED", `Muse host failed to start (${reason})`, reason !== "initialize-rejected");
    this.name = "MspHostStartError";
  }
}

export class MspInitializeRejectedError extends MuseBridgeError {
  constructor(readonly mspCode: number, readonly mspKind: string) {
    super("MUSE_HOST_START_FAILED", `Muse rejected initialization (${mspKind}, ${mspCode})`, false);
    this.name = "MspInitializeRejectedError";
  }
}

export class MspSchemaMismatchError extends MuseBridgeError {
  constructor(readonly pinned: string, readonly served: string) {
    super("MUSE_HOST_START_FAILED", "Muse host schema fingerprint does not match the pinned MSP schema", false);
    this.name = "MspSchemaMismatchError";
  }
}

export class RegistryValidationError extends MuseBridgeError {
  constructor() {
    super("MUSE_REGISTRY_ERROR", "Muse session registry entry is invalid or contains unsupported fields", false);
    this.name = "RegistryValidationError";
  }
}

export class RegistryCorruptError extends MuseBridgeError {
  constructor() {
    super("MUSE_REGISTRY_ERROR", "Muse session registry entry is corrupt and could not be quarantined safely", false);
    this.name = "RegistryCorruptError";
  }
}

export class RegistryStorageError extends MuseBridgeError {
  constructor() {
    super("MUSE_REGISTRY_STORAGE_ERROR", "Muse session registry storage operation failed", true);
    this.name = "RegistryStorageError";
  }
}

export class RegistryWorkspaceMismatchError extends MuseBridgeError {
  constructor() {
    super("MUSE_REGISTRY_ERROR", "OpenCode session is already bound to a different workspace", false);
    this.name = "RegistryWorkspaceMismatchError";
  }
}

export class WorkspaceBusyError extends MuseBridgeError {
  constructor() {
    super("MUSE_WORKSPACE_BUSY", "Another OpenCode session currently owns this workspace", true);
    this.name = "WorkspaceBusyError";
  }
}

export class WorkspaceLockCorruptError extends MuseBridgeError {
  constructor() {
    super("MUSE_WORKSPACE_LOCK_CORRUPT", "Workspace lock is corrupt; refusing to assume it is stale", false);
    this.name = "WorkspaceLockCorruptError";
  }
}

export class MuseTurnFailedError extends MuseBridgeError {
  readonly turnErrorKind: string;

  constructor(turnErrorKind: string, retryable: boolean | undefined) {
    const safeKind = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(turnErrorKind) ? turnErrorKind : "unknown";
    super("MUSE_TURN_FAILED", `Muse turn failed (${safeKind})`, retryable);
    this.turnErrorKind = safeKind;
    this.name = "MuseTurnFailedError";
  }
}

export class MuseTurnUnqueuedError extends MuseBridgeError {
  constructor() {
    super("MUSE_TURN_UNQUEUED", "Muse queued turn was reclaimed before it started", false);
    this.name = "MuseTurnUnqueuedError";
  }
}

export class MuseUnsupportedRequestError extends MuseBridgeError {
  constructor(readonly requestKind: string) {
    super("MUSE_UNSUPPORTED_REQUEST", `Muse bridge does not support this request kind (${requestKind})`, false);
    this.name = "MuseUnsupportedRequestError";
  }
}

export class MuseUnsupportedInputError extends MuseBridgeError {
  constructor(readonly inputKind: string) {
    super("MUSE_UNSUPPORTED_INPUT", `Muse bridge cannot represent this input kind (${inputKind})`, false);
    this.name = "MuseUnsupportedInputError";
  }
}

export class MuseRecoveryChoiceRequiredError extends MuseBridgeError {
  constructor() {
    super("MUSE_RECOVERY_CHOICE_REQUIRED", "A prior Muse command has an unknown outcome; inspect or resume the session before continuing", false);
    this.name = "MuseRecoveryChoiceRequiredError";
  }
}

export class MuseTranscriptDivergedError extends MuseBridgeError {
  constructor() {
    super("MUSE_TRANSCRIPT_DIVERGED", "OpenCode history diverged from the mapped Muse session; start a fresh Muse session or recover it explicitly", false);
    this.name = "MuseTranscriptDivergedError";
  }
}

export class MuseApprovalPendingError extends MuseBridgeError {
  constructor() {
    super("MUSE_APPROVAL_PENDING", "Muse turn is parked awaiting an approval verdict; answer the pending prompt first", true);
    this.name = "MuseApprovalPendingError";
  }
}
