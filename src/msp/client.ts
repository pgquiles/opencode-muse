import {
  MspError,
  ProtocolError as SdkProtocolError,
  type CommandOptions,
} from "@muse-code/sdk";
import {
  MspCommandRejectedError,
  MspCommandTimeoutError,
  MspHostClosedError,
  MspProtocolError,
  MspRequestTimeoutError,
  MspTransportError,
} from "../errors.js";

export interface MspNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  emittedAtMs?: number;
}

export interface MspServerRequest {
  method: string;
  params?: Record<string, unknown>;
}

export interface MspConnectionLike {
  readonly closed?: Promise<void>;
  command(
    method: string,
    params: Record<string, unknown>,
    options?: CommandOptions,
  ): Promise<Record<string, unknown>>;
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  mintCommandId(): string;
  onNotification(handler: (notification: MspNotification) => void): void;
  onServerRequest?(handler: (request: MspServerRequest) => Promise<Record<string, unknown>>): void;
  onProtocolError?(handler: (error: unknown) => void): void;
  close(): Promise<void>;
}

export interface MspClientOptions {
  commandTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeConnection?: boolean;
  onServerRequest?: (request: MspServerRequest) => Promise<Record<string, unknown>>;
  onFatal?: () => void;
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly readers = new Set<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }>();
  private ended = false;
  private failure: unknown;

  push(value: T): void {
    if (this.ended) return;
    const reader = this.readers.values().next().value as typeof this.readers extends Set<infer T> ? T : never;
    if (reader) {
      this.readers.delete(reader);
      if (reader.onAbort && reader.signal) reader.signal.removeEventListener("abort", reader.onAbort);
      reader.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  next(signal?: AbortSignal): Promise<IteratorResult<T>> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      const reader: {
        resolve: (result: IteratorResult<T>) => void;
        reject: (error: unknown) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, signal };
      if (signal) {
        reader.onAbort = () => {
          this.readers.delete(reader);
          reject(abortError());
        };
        signal.addEventListener("abort", reader.onAbort, { once: true });
      }
      this.readers.add(reader);
    });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const reader of this.readers) {
      if (reader.onAbort && reader.signal) reader.signal.removeEventListener("abort", reader.onAbort);
      reader.resolve({ value: undefined, done: true });
    }
    this.readers.clear();
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    for (const reader of this.readers) {
      if (reader.onAbort && reader.signal) reader.signal.removeEventListener("abort", reader.onAbort);
      reader.reject(error);
    }
    this.readers.clear();
  }
}

function abortError(): DOMException {
  return new DOMException("MSP subscription aborted", "AbortError");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeout: () => Error): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(timeout()), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function safeRequestFailure(method: string, error: unknown): Error {
  if (error instanceof MspError) {
    return new MspCommandRejectedError(method, error.code, error.kind, error.retryable);
  }
  if (error instanceof SdkProtocolError) return new MspProtocolError(method);
  if (error instanceof Error && error.name === "MspRequestTimeoutError") return error;
  return new MspTransportError(method);
}

/** Thin typed facade over the SDK connection; it never logs or retains wire payloads. */
export class MspClient {
  private readonly subscribers = new Set<{ sessionId: string; queue: AsyncQueue<MspNotification> }>();
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private observedProtocolFailure: MspProtocolError | undefined;
  private readonly commandTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly closeConnection: boolean;

  constructor(
    private readonly connection: MspConnectionLike,
    options: MspClientOptions = {},
  ) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? this.commandTimeoutMs;
    this.closeConnection = options.closeConnection ?? true;
    connection.onNotification((notification) => this.publish(notification));
    if (options.onServerRequest) {
      const handler = options.onServerRequest;
      connection.onServerRequest?.((request) => handler(request));
    }
    connection.onProtocolError?.(() => {
      if (this.observedProtocolFailure) return;
      this.observedProtocolFailure = new MspProtocolError();
      this.closed = true;
      for (const subscription of this.subscribers) subscription.queue.fail(this.observedProtocolFailure);
      this.subscribers.clear();
      options.onFatal?.();
    });
    void connection.closed?.then(
      () => {
        const unexpected = !this.closed;
        this.dispose();
        if (unexpected) options.onFatal?.();
      },
      () => {
        const unexpected = !this.closed;
        this.dispose();
        if (unexpected) options.onFatal?.();
      },
    );
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get protocolFailure(): MspProtocolError | undefined {
    return this.observedProtocolFailure;
  }

  mintCommandId(): string {
    this.assertOpen();
    return this.connection.mintCommandId();
  }

  command<TResult extends object = Record<string, unknown>>(
    method: string,
    paramsWithCommandId: Record<string, unknown> & { commandId: string },
    options: Omit<CommandOptions, "commandId"> = {},
  ): Promise<TResult> {
    this.assertOpen();
    if (typeof paramsWithCommandId.commandId !== "string" || paramsWithCommandId.commandId.length === 0) {
      return Promise.reject(new MspProtocolError(method));
    }
    const request = this.connection.command(method, paramsWithCommandId, {
      ...options,
      commandId: paramsWithCommandId.commandId,
    });
    return withTimeout(
      request,
      this.commandTimeoutMs,
      () => new MspCommandTimeoutError(method, this.commandTimeoutMs),
    ).catch((error: unknown) => {
      if (error instanceof MspCommandTimeoutError) throw error;
      throw safeRequestFailure(method, error);
    }) as Promise<TResult>;
  }

  request<TResult extends object = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<TResult> {
    this.assertOpen();
    const request = this.connection.request(method, params);
    return withTimeout(
      request,
      this.requestTimeoutMs,
      () => new MspRequestTimeoutError(method, this.requestTimeoutMs),
    ).catch((error: unknown) => {
      if (error instanceof MspRequestTimeoutError) throw error;
      throw safeRequestFailure(method, error);
    }) as Promise<TResult>;
  }

  /** Start/resume already attach at their returned head; `after` explicitly requests replay. */
  async *subscribe(sessionId: string, after?: string, signal?: AbortSignal): AsyncIterable<MspNotification> {
    this.assertOpen();
    if (!sessionId) throw new MspProtocolError("view/subscribe");
    if (signal?.aborted) throw abortError();

    const subscription = { sessionId, queue: new AsyncQueue<MspNotification>() };
    this.subscribers.add(subscription);
    try {
      if (after !== undefined) await this.request("view/subscribe", { sessionId, after });
      while (!signal?.aborted) {
        const next = await subscription.queue.next(signal);
        if (next.done) return;
        yield next.value;
      }
    } finally {
      this.subscribers.delete(subscription);
      subscription.queue.end();
    }
  }

  /** Mark subscriptions ended after the owning process wrapper has shut down. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscription of this.subscribers) subscription.queue.end();
    this.subscribers.clear();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.dispose();
    this.closePromise = this.closeConnection
      ? this.connection.close().catch(() => { throw new MspTransportError(); })
      : Promise.resolve();
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.observedProtocolFailure) throw this.observedProtocolFailure;
    if (this.closed) throw new MspHostClosedError();
  }

  private publish(notification: MspNotification): void {
    if (this.closed) return;
    const params = notification.params ?? {};
    const item = params.item as { sessionId?: unknown } | undefined;
    const sessionId = typeof params.sessionId === "string"
      ? params.sessionId
      : typeof item?.sessionId === "string" ? item.sessionId : undefined;
    if (sessionId === undefined) return;
    for (const subscription of this.subscribers) {
      if (subscription.sessionId === sessionId) subscription.queue.push(notification);
    }
  }
}
