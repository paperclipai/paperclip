import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import type {
  DurablePrpControlPlane,
  HarnessRuntimeRequestResolution,
} from "../vendor/paperclip-runner/index.js";
import {
  assertNativeRuntimeRequestResolverAuthorized,
  type NativeRuntimeRequestResolver,
  type PendingNativeRuntimeRequest,
} from "../services/native-runtime/runtime-request-resolution-authority.js";

import { logger } from "../middleware/logger.js";

const CONNECT_PATH_PREFIX = "/api/runner/v1/connect/";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RegisteredAuthority {
  readonly companyId: string;
  readonly authority: DurablePrpControlPlane;
  readonly generation: symbol;
  readonly runtimeRequestResolutions: Map<
    string,
    { readonly fingerprint: string; readonly commandId: string }
  >;
}

interface RunnerPrpUpgradeRequest extends IncomingMessage {
  paperclipWebSocketHandled?: boolean;
}

const registrations = new Map<string, RegisteredAuthority>();
let loopbackOrigin: string | null = null;

function rejectUpgrade(
  socket: Duplex,
  status: "400 Bad Request" | "404 Not Found",
): void {
  if (socket.destroyed) return;
  try {
    socket.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch (error) {
    logger.warn(
      { errorName: error instanceof Error ? error.name : typeof error },
      "failed to reject runner PRP websocket upgrade",
    );
    socket.destroy();
  }
}

export function setupRunnerPrpWebSocketServer(
  server: Server,
  options: { readonly apiUrl: string },
): void {
  const apiUrl = new URL(options.apiUrl);
  if (!["http:", "https:"].includes(apiUrl.protocol)) {
    throw new Error("runner_prp_websocket_api_url_invalid");
  }
  apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
  apiUrl.username = "";
  apiUrl.password = "";
  apiUrl.pathname = "";
  apiUrl.search = "";
  apiUrl.hash = "";
  loopbackOrigin = apiUrl.toString().replace(/\/$/, "");
  server.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? "/", "http://paperclip.invalid");
      if (!url.pathname.startsWith(CONNECT_PATH_PREFIX)) return;

      const ownedRequest = request as RunnerPrpUpgradeRequest;
      if (ownedRequest.paperclipWebSocketHandled) return;
      ownedRequest.paperclipWebSocketHandled = true;
      socket.on("error", (error) => {
        logger.warn(
          { errorName: error.name },
          "runner PRP websocket upgrade socket failed",
        );
      });

      const runId = url.pathname.slice(CONNECT_PATH_PREFIX.length);
      if (!UUID_PATTERN.test(runId)) {
        rejectUpgrade(socket, "400 Bad Request");
        return;
      }
      const registration = registrations.get(runId);
      if (!registration) {
        rejectUpgrade(socket, "404 Not Found");
        return;
      }
      registration.authority.handleUpgrade(request, socket, url.pathname, head);
    },
  );
}

export async function registerRunnerPrpAuthority(input: {
  readonly companyId: string;
  readonly runId: string;
  readonly authority: DurablePrpControlPlane;
}): Promise<{ readonly connectUrl: string; release(): Promise<void> }> {
  if (loopbackOrigin === null) {
    throw new Error("runner_prp_websocket_server_not_configured");
  }
  if (!UUID_PATTERN.test(input.runId) || input.companyId.length === 0) {
    throw new Error("runner_prp_authority_binding_invalid");
  }
  if (registrations.has(input.runId)) {
    throw new Error("runner_prp_authority_already_registered");
  }
  const generation = Symbol(input.runId);
  registrations.set(input.runId, {
    companyId: input.companyId,
    authority: input.authority,
    generation,
    runtimeRequestResolutions: new Map(),
  });
  return {
    connectUrl: `${loopbackOrigin}${CONNECT_PATH_PREFIX}${input.runId}`,
    release: async () => {
      if (registrations.get(input.runId)?.generation === generation) {
        registrations.delete(input.runId);
      }
    },
  };
}

export class RunnerPrpRuntimeRequestResolutionError extends Error {
  constructor(
    readonly code:
      | "runner_prp_authority_not_active"
      | "runtime_request_resolution_conflict",
  ) {
    super(code);
    this.name = "RunnerPrpRuntimeRequestResolutionError";
  }
}

/**
 * Queue one turn-bound runtime response on the active durable PRP authority.
 * Identical browser retries reuse the original command; a different answer for
 * the same request fails closed instead of answering the provider twice.
 */
export function queueRunnerPrpRuntimeRequestResolution(input: {
  readonly companyId: string;
  readonly runId: string;
  readonly pendingRequest: PendingNativeRuntimeRequest;
  readonly actor: NativeRuntimeRequestResolver;
  readonly resolution: HarnessRuntimeRequestResolution;
}): { readonly commandId: string } {
  const registration = registrations.get(input.runId);
  if (!registration || registration.companyId !== input.companyId) {
    throw new RunnerPrpRuntimeRequestResolutionError(
      "runner_prp_authority_not_active",
    );
  }
  const pending = input.pendingRequest;
  if (
    pending.companyId !== input.companyId
    || pending.runId !== input.runId
  ) {
    throw new RunnerPrpRuntimeRequestResolutionError(
      "runner_prp_authority_not_active",
    );
  }
  // Authorization is intentionally checked again at the command-consumption
  // boundary. The route performs the same check before parsing a resolution,
  // but only this edge owns the durable command mutation.
  assertNativeRuntimeRequestResolverAuthorized(pending, input.actor);

  const fingerprint = JSON.stringify({
    requestKind: pending.requestKind,
    turnId: pending.turnId,
    actor: input.actor,
    resolution: input.resolution,
  });
  const previous = registration.runtimeRequestResolutions.get(pending.requestId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) {
      throw new RunnerPrpRuntimeRequestResolutionError(
        "runtime_request_resolution_conflict",
      );
    }
    return { commandId: previous.commandId };
  }

  const command = registration.authority.queueCommand(
    "request.resolve",
    {
      requestId: pending.requestId,
      requestKind: pending.requestKind,
      turnId: pending.turnId,
      resolution: input.resolution,
      resolutionActor: input.actor,
    },
    undefined,
    true,
  );
  registration.runtimeRequestResolutions.set(pending.requestId, {
    fingerprint,
    commandId: command.commandId,
  });
  return { commandId: command.commandId };
}

export const runnerPrpWebSocketInternals = {
  connectPathPrefix: CONNECT_PATH_PREFIX,
  activeRegistration(input: {
    readonly companyId: string;
    readonly runId: string;
  }): boolean {
    return registrations.get(input.runId)?.companyId === input.companyId;
  },
  resetForTests(): void {
    registrations.clear();
    loopbackOrigin = null;
  },
};
