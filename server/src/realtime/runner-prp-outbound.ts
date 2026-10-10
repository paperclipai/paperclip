import WebSocket from "ws";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import type {
  DurablePrpControlPlane,
  PrpWireConnection,
  TransportCloseReason,
} from "../vendor/paperclip-runner/index.js";

const DEFAULT_STARTUP_DEADLINE_MS = 60_000;
const DEFAULT_RECOVERY_GRACE_MS = 120_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

export type RunnerIngressFailureCode =
  | "runner_ingress_unavailable"
  | "runner_ingress_auth_failed";

export class RunnerIngressConnectionError extends Error {
  constructor(
    readonly code: RunnerIngressFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "RunnerIngressConnectionError";
  }
}

export class WsJsonWireConnection implements PrpWireConnection {
  #onJson: ((value: unknown) => void) | null = null;
  #onClose = new Set<(reason: TransportCloseReason) => void>();
  #pendingJson: unknown[] = [];
  #closeReason: TransportCloseReason | null = null;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.close(1003);
        return;
      }
      try {
        const value = JSON.parse(data.toString()) as unknown;
        if (this.#onJson === null) {
          this.#pendingJson.push(value);
        } else {
          this.#onJson(value);
        }
      } catch {
        this.close(1007);
      }
    });
    socket.on("close", (code, reason) => {
      this.#notifyClose({ code, message: reason.toString() });
    });
    socket.on("error", (error) => {
      this.#notifyClose({ message: "websocket_error", error });
    });
  }

  sendJson(value: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(value));
    }
  }

  close(code = 1000): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(code);
    }
  }

  onJson(listener: (value: unknown) => void): void {
    this.#onJson = listener;
    for (const value of this.#pendingJson.splice(0)) listener(value);
  }

  onClose(listener: (reason: TransportCloseReason) => void): void {
    if (this.#closeReason) listener(this.#closeReason);
    else this.#onClose.add(listener);
  }

  #notifyClose(reason: TransportCloseReason): void {
    if (this.#closeReason) return;
    this.#closeReason = reason;
    for (const listener of this.#onClose) listener(reason);
    this.#onClose.clear();
  }
}

function validateEndpoint(endpoint: RunnerIngressEndpoint): void {
  const url = new URL(endpoint.websocketUrl);
  if (
    endpoint.kind !== "authenticated_websocket" ||
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RunnerIngressConnectionError(
      "runner_ingress_unavailable",
      "The provider returned an invalid runner ingress endpoint.",
    );
  }
}

function endpointHeaders(endpoint: RunnerIngressEndpoint): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of endpoint.secretHeaders) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name) || !header.value) {
      throw new RunnerIngressConnectionError(
        "runner_ingress_unavailable",
        "The provider returned an invalid runner ingress credential.",
      );
    }
    headers[header.name] = header.value;
  }
  return headers;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function awaitWithinDeadline<T>(input: {
  operation: () => Promise<T>;
  deadline: number;
  signal: AbortSignal;
}): Promise<T> {
  if (input.signal.aborted) {
    throw new Error("runner ingress operation was cancelled");
  }
  const remaining = input.deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("runner ingress operation deadline elapsed");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const gate = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("runner ingress operation deadline elapsed")),
      remaining,
    );
    onAbort = () => reject(new Error("runner ingress operation was cancelled"));
    input.signal.addEventListener("abort", onAbort, { once: true });
  });
  const operation = Promise.resolve().then(input.operation);
  try {
    return await Promise.race([operation, gate]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) input.signal.removeEventListener("abort", onAbort);
  }
}

async function openEndpoint(input: {
  endpoint: RunnerIngressEndpoint;
  signal: AbortSignal;
}): Promise<{ wire: WsJsonWireConnection; statusCode: number | null }> {
  validateEndpoint(input.endpoint);
  return await new Promise((resolve, reject) => {
    let statusCode: number | null = null;
    const socket = new WebSocket(input.endpoint.websocketUrl, {
      headers: endpointHeaders(input.endpoint),
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: 15_000,
    });
    const wire = new WsJsonWireConnection(socket);
    const onAbort = () => {
      wire.close(1001);
      reject(
        new RunnerIngressConnectionError(
          "runner_ingress_unavailable",
          "Runner ingress connection was cancelled.",
        ),
      );
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    socket.once("unexpected-response", (_request, response) => {
      statusCode = response.statusCode ?? null;
      response.resume();
      input.signal.removeEventListener("abort", onAbort);
      socket.terminate();
      reject(
        Object.assign(new Error("runner_ingress_upgrade_rejected"), {
          statusCode,
        }),
      );
    });
    socket.once("open", () => {
      input.signal.removeEventListener("abort", onAbort);
      resolve({ wire, statusCode });
    });
    socket.once("error", (error) => {
      input.signal.removeEventListener("abort", onAbort);
      reject(Object.assign(error, { statusCode }));
    });
  });
}

function socketClosed(wire: WsJsonWireConnection): Promise<void> {
  return new Promise((resolve) => wire.onClose(() => resolve()));
}

async function waitForPrpReady(input: {
  isAuthenticated: () => boolean;
  wire: WsJsonWireConnection;
  deadline: number;
  signal: AbortSignal;
}): Promise<boolean> {
  while (
    !input.signal.aborted &&
    input.wire.socket.readyState === WebSocket.OPEN &&
    Date.now() < input.deadline
  ) {
    if (input.isAuthenticated()) return true;
    await delay(25, input.signal);
  }
  return false;
}

export interface RunnerPrpOutboundHandle {
  readonly ready: Promise<void>;
  /** Rejects only when active-run recovery has exhausted its fixed budget. */
  readonly failure: Promise<never>;
  close(): Promise<void>;
}

/**
 * Keep a Paperclip-originated provider-ingress WebSocket attached to one PRP
 * authority. Authentication is the readiness signal; HTTP success alone is not.
 */
export function connectRunnerPrpIngress(input: {
  authority: DurablePrpControlPlane;
  endpoint: RunnerIngressEndpoint;
  startupDeadlineMs?: number;
  recoveryGraceMs?: number;
  random?: () => number;
  onStateChange?: (
    state: "connecting" | "authenticated" | "reconnecting" | "failed" | "closed",
    failureCode?: RunnerIngressFailureCode,
  ) => void;
}): RunnerPrpOutboundHandle {
  const abort = new AbortController();
  let activeWire: WsJsonWireConnection | null = null;
  let endpoint = input.endpoint;
  const startupDeadline =
    Date.now() + (input.startupDeadlineMs ?? DEFAULT_STARTUP_DEADLINE_MS);
  const recoveryGraceMs = input.recoveryGraceMs ?? DEFAULT_RECOVERY_GRACE_MS;
  const random = input.random ?? Math.random;
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let failureReject!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    failureReject = reject;
  });
  // The owning native session normally races this promise against the provider
  // turn. A turn can finish first, though, and a later preview outage must not
  // become an unhandled process-level rejection. Keep the original promise
  // rejected for explicit observers while registering an internal handler.
  void failure.catch(() => undefined);
  void ready.catch(() => undefined);

  const loop = (async () => {
    let attempt = 0;
    let recoveryDeadline = startupDeadline;
    while (!abort.signal.aborted) {
      try {
        input.onStateChange?.(attempt === 0 ? "connecting" : "reconnecting");
        const opened = await openEndpoint({ endpoint, signal: abort.signal });
        activeWire = opened.wire;
        const attachment = input.authority.attachWireConnection(opened.wire);
        const authenticated = await waitForPrpReady({
          isAuthenticated: attachment.isAuthenticated,
          wire: opened.wire,
          deadline: recoveryDeadline,
          signal: abort.signal,
        });
        if (!authenticated) {
          opened.wire.close(1008);
          throw new RunnerIngressConnectionError(
            "runner_ingress_auth_failed",
            "Runner ingress did not complete PRP authentication before the deadline.",
          );
        }
        if (!readySettled) {
          readySettled = true;
          readyResolve();
        }
        input.onStateChange?.("authenticated");
        attempt = 0;
        await socketClosed(opened.wire);
        activeWire = null;
        recoveryDeadline = Date.now() + recoveryGraceMs;
      } catch (error) {
        activeWire = null;
        // close() owns intentional shutdown. openEndpoint rejects its pending
        // handshake when the abort signal fires, but that cancellation is not
        // an active-run transport failure and must not reject the long-lived
        // failure promise (an unobserved rejection here can terminate Node).
        if (abort.signal.aborted) return;
        let failure: unknown = error;
        const statusCode =
          typeof error === "object" && error !== null && "statusCode" in error
            ? Number((error as { statusCode?: unknown }).statusCode)
            : null;
        if (
          (statusCode === 401 || statusCode === 403) &&
          Date.now() < recoveryDeadline
        ) {
          try {
            const refreshedEndpoint = await awaitWithinDeadline({
              operation: () => endpoint.refresh(),
              deadline: recoveryDeadline,
              signal: abort.signal,
            });
            // Preview credentials can rotate without changing the sandbox
            // generation. Refresh every rejected credential, but never let a
            // successful refresh reset or step past the fixed recovery budget.
            if (Date.now() < recoveryDeadline) {
              endpoint = refreshedEndpoint;
              continue;
            }
          } catch (refreshError) {
            if (abort.signal.aborted) return;
            failure = refreshError;
          }
        }
        if (Date.now() >= recoveryDeadline) {
          const terminal =
            failure instanceof RunnerIngressConnectionError
              ? failure
              : new RunnerIngressConnectionError(
                  statusCode === 401 || statusCode === 403
                    ? "runner_ingress_auth_failed"
                    : "runner_ingress_unavailable",
                  "Runner ingress connection failed.",
                  { cause: failure },
                );
          if (!readySettled) {
            readySettled = true;
            readyReject(terminal);
          }
          input.onStateChange?.("failed", terminal.code);
          failureReject(terminal);
          return;
        }
        const base = RECONNECT_DELAYS_MS[
          Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)
        ]!;
        attempt += 1;
        await delay(Math.max(1, Math.round(base * (0.75 + random() * 0.5))), abort.signal);
      }
    }
  })();

  return {
    ready,
    failure,
    async close() {
      abort.abort();
      activeWire?.close(1001);
      await loop;
      await endpoint.close();
      input.onStateChange?.("closed");
      if (!readySettled) {
        readySettled = true;
        readyReject(
          new RunnerIngressConnectionError(
            "runner_ingress_unavailable",
            "Runner ingress was closed before it became ready.",
          ),
        );
      }
    },
  };
}

export const __runnerPrpOutboundTesting = { awaitWithinDeadline };
