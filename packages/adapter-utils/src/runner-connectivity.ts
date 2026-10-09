import type { AdapterExecutionTarget } from "./execution-target.js";

export const PAPERCLIP_RUNNER_INGRESS_PORT = 43_127;
export const PAPERCLIP_RUNNER_CONNECT_PATH_PREFIX = "/api/runner/v1/connect";

export interface SecretHeader {
  readonly name: string;
  readonly value: string;
}

export interface RunnerIngressEndpoint {
  readonly kind: "authenticated_websocket";
  readonly websocketUrl: string;
  readonly secretHeaders: readonly SecretHeader[];
  readonly generation: string;
  refresh(): Promise<RunnerIngressEndpoint>;
  close(): Promise<void>;
}

export type PaperclipRunnerTransport =
  | {
      readonly mode: "local_loopback";
      readonly connectUrl: string;
    }
  | {
      readonly mode: "direct_outbound";
      readonly connectUrl: string;
      readonly caBundlePath?: string;
    }
  | {
      readonly mode: "provider_ingress";
      readonly listenAddress: "0.0.0.0";
      readonly listenPort: number;
      readonly listenPath: string;
      readonly ingress: RunnerIngressEndpoint;
    };

type RunnerIngressAuthorization =
  | {
      /** Per-run authorization resolved by the native runtime selection policy. */
      readonly runnerIngressAuthorized: boolean;
      /** @deprecated Use runnerIngressAuthorized. Retained for API compatibility. */
      readonly enableRunnerPreviewIngress?: boolean;
    }
  | {
      readonly runnerIngressAuthorized?: never;
      /** @deprecated Use runnerIngressAuthorized. Retained for API compatibility. */
      readonly enableRunnerPreviewIngress: boolean;
    };

export class PaperclipRunnerTransportError extends Error {
  readonly code:
    | "runner_transport_ineligible"
    | "runner_direct_wss_failed"
    | "runner_ingress_unavailable";

  constructor(
    code: PaperclipRunnerTransportError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "PaperclipRunnerTransportError";
    this.code = code;
  }
}

function connectPath(runId: string): string {
  if (!runId || runId.includes("/") || runId.includes("?") || runId.includes("#")) {
    throw new PaperclipRunnerTransportError(
      "runner_transport_ineligible",
      "Runner run id is not safe for a WebSocket route.",
    );
  }
  return `${PAPERCLIP_RUNNER_CONNECT_PATH_PREFIX}/${encodeURIComponent(runId)}`;
}

export function buildDirectRunnerConnectUrl(input: {
  runnerPublicUrl: string;
  runId: string;
}): string {
  let url: URL;
  try {
    url = new URL(input.runnerPublicUrl);
  } catch (error) {
    throw new PaperclipRunnerTransportError(
      "runner_direct_wss_failed",
      "The configured runner public URL is invalid.",
      { cause: error },
    );
  }
  if (url.protocol !== "wss:") {
    throw new PaperclipRunnerTransportError(
      "runner_direct_wss_failed",
      "Remote runner connectivity requires a wss: runner public URL.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new PaperclipRunnerTransportError(
      "runner_direct_wss_failed",
      "Runner public URLs cannot contain userinfo, a query string, or a fragment.",
    );
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}${connectPath(input.runId)}`;
  return url.toString();
}

export async function resolvePaperclipRunnerTransport(input: {
  target: AdapterExecutionTarget;
  runId: string;
  localConnectUrl: string;
  runnerPublicUrl?: string | null;
  runnerCaBundlePath?: string | null;
  getRunnerIngressEndpoint?: (input: {
    leaseId: string;
    port: number;
    path: string;
  }) => Promise<RunnerIngressEndpoint>;
} & RunnerIngressAuthorization): Promise<PaperclipRunnerTransport> {
  if (input.target.kind === "local") {
    return { mode: "local_loopback", connectUrl: input.localConnectUrl };
  }

  if (
    input.target.transport === "sandbox" &&
    input.target.providerKey === "daytona" &&
    input.target.effectiveCapabilities?.runnerWebSocketIngress !== true
  ) {
    throw new PaperclipRunnerTransportError(
      "runner_ingress_unavailable",
      "Daytona runner execution requires provider WebSocket ingress capability.",
    );
  }

  if (
    input.target.transport === "sandbox" &&
    input.target.effectiveCapabilities?.runnerWebSocketIngress === true
  ) {
    const ingressAuthorized =
      input.runnerIngressAuthorized ?? input.enableRunnerPreviewIngress ?? false;
    if (!ingressAuthorized) {
      throw new PaperclipRunnerTransportError(
        "runner_ingress_unavailable",
        "Runner ingress is not authorized for this Paperclip Runner run.",
      );
    }
    const getRunnerIngressEndpoint =
      input.getRunnerIngressEndpoint ?? input.target.getRunnerIngressEndpoint;
    if (!input.target.leaseId || !getRunnerIngressEndpoint) {
      throw new PaperclipRunnerTransportError(
        "runner_ingress_unavailable",
        "The sandbox runner ingress provider is unavailable for this lease.",
      );
    }
    const path = connectPath(input.runId);
    const ingress = await getRunnerIngressEndpoint({
      leaseId: input.target.leaseId,
      port: PAPERCLIP_RUNNER_INGRESS_PORT,
      path,
    });
    return {
      mode: "provider_ingress",
      listenAddress: "0.0.0.0",
      listenPort: PAPERCLIP_RUNNER_INGRESS_PORT,
      listenPath: path,
      ingress,
    };
  }

  if (input.runnerPublicUrl) {
    return {
      mode: "direct_outbound",
      connectUrl: buildDirectRunnerConnectUrl({
        runnerPublicUrl: input.runnerPublicUrl,
        runId: input.runId,
      }),
      ...(input.runnerCaBundlePath
        ? { caBundlePath: input.runnerCaBundlePath }
        : {}),
    };
  }

  throw new PaperclipRunnerTransportError(
    "runner_transport_ineligible",
    "The remote execution target has neither runner WebSocket ingress nor an explicit runner public URL.",
  );
}
