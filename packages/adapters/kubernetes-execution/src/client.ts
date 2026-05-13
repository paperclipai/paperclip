import {
  KubeConfig,
  CoreV1Api,
  BatchV1Api,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
  ApiextensionsV1Api,
} from "@kubernetes/client-node";
import { Agent, request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { URL } from "node:url";
import type { ResolvedClusterConnection, KubernetesApiClient } from "./types.js";

export function createKubernetesApiClient(connection: ResolvedClusterConnection): KubernetesApiClient {
  const kc = new KubeConfig();

  if (connection.kind === "in-cluster") {
    // Detect whether we're actually running inside a Kubernetes pod by checking
    // the standard in-cluster env vars. loadFromCluster() does not throw when
    // these are absent — it just builds a cluster with an invalid server URL.
    if (!process.env["KUBERNETES_SERVICE_HOST"] || !process.env["KUBERNETES_SERVICE_PORT"]) {
      throw new Error(
        `Cluster connection ${connection.id} is in-cluster but Paperclip is not running inside a Kubernetes pod ` +
          `(KUBERNETES_SERVICE_HOST / KUBERNETES_SERVICE_PORT are not set)`,
      );
    }
    try {
      kc.loadFromCluster();
    } catch (err) {
      throw new Error(
        `Cluster connection ${connection.id} is in-cluster but Paperclip is not running inside a Kubernetes pod: ${(err as Error).message}`,
      );
    }
    if (!kc.getCurrentCluster()) {
      throw new Error(
        `Cluster connection ${connection.id} is in-cluster but no cluster could be loaded — is Paperclip running inside a Kubernetes pod?`,
      );
    }
  } else {
    if (!connection.kubeconfigYaml) {
      throw new Error(`Cluster connection ${connection.id} is kind=kubeconfig but kubeconfigYaml is empty`);
    }
    kc.loadFromString(connection.kubeconfigYaml);
  }

  const core = kc.makeApiClient(CoreV1Api);
  const batch = kc.makeApiClient(BatchV1Api);
  const networking = kc.makeApiClient(NetworkingV1Api);
  const rbac = kc.makeApiClient(RbacAuthorizationV1Api);
  const apiext = kc.makeApiClient(ApiextensionsV1Api);

  const ctx = kc.getCurrentContext();

  // Build an https.Agent once per client carrying the kubeconfig's TLS material
  // (CA bundle + optional client cert/key). Required for kind/EKS-style
  // kubeconfigs that authenticate via mTLS rather than a bearer token.
  // @kubernetes/client-node@0.21 exposes applyHTTPSOptions which writes
  // ca/cert/key/rejectUnauthorized onto a plain object; we hand that object to
  // https.Agent. Lazily materialised so in-cluster paths without TLS material
  // still work.
  type HttpsOpts = {
    ca?: Buffer | string;
    cert?: Buffer | string;
    key?: Buffer | string;
    rejectUnauthorized?: boolean;
  };
  let httpsAgent: Agent | null | undefined;
  function getHttpsAgent(): Agent | null {
    if (httpsAgent !== undefined) return httpsAgent;
    const kcAny = kc as unknown as { applyHTTPSOptions?: (opts: HttpsOpts) => void };
    if (typeof kcAny.applyHTTPSOptions !== "function") {
      httpsAgent = null;
      return null;
    }
    const opts: HttpsOpts = {};
    kcAny.applyHTTPSOptions(opts);
    if (opts.ca || opts.cert || opts.key || opts.rejectUnauthorized === false) {
      httpsAgent = new Agent({
        ca: opts.ca,
        cert: opts.cert,
        key: opts.key,
        rejectUnauthorized: opts.rejectUnauthorized !== false,
      });
    } else {
      httpsAgent = null;
    }
    return httpsAgent;
  }

  // Build https.RequestOptions for an arbitrary k8s API path. Centralised so
  // `request` and `requestStream` share the exact same auth path.
  async function buildAuthedRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ options: HttpsRequestOptions; payload: string | undefined }> {
    const cluster = kc.getCurrentCluster();
    if (!cluster) throw new Error(`No current cluster in kubeconfig`);
    const url = new URL(path, cluster.server);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    if (payload !== undefined) {
      headers["Content-Length"] = Buffer.byteLength(payload).toString();
    }

    // Authorization header: for token-based and exec-credential users, the SDK
    // exposes applyAuthorizationHeader which writes Authorization onto a plain
    // headers object. For cert-based users it's a no-op — the auth is the mTLS
    // handshake itself, not a header — and the https.Agent above carries the
    // cert/key.
    const kcAny = kc as unknown as {
      applyAuthorizationHeader?: (opts: { headers: Record<string, string> }) => Promise<void>;
    };
    if (typeof kcAny.applyAuthorizationHeader === "function") {
      await kcAny.applyAuthorizationHeader({ headers });
    } else {
      const user = kc.getCurrentUser();
      if (user?.token) headers["Authorization"] = `Bearer ${user.token}`;
    }

    const agent = getHttpsAgent();
    const options: HttpsRequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers,
    };
    if (agent) options.agent = agent;
    return { options, payload };
  }

  function sendHttps(
    options: HttpsRequestOptions,
    payload: string | undefined,
    timeoutMs?: number,
    label?: string,
  ): Promise<IncomingMessage> {
    const reqOptions = timeoutMs !== undefined ? { ...options, timeout: timeoutMs } : options;
    return new Promise((resolve, reject) => {
      const req = httpsRequest(reqOptions, (res) => resolve(res));
      req.once("error", reject);
      if (timeoutMs !== undefined) {
        req.once("timeout", () => {
          req.destroy(new Error(`${label ?? "k8s API request"} timed out after ${timeoutMs}ms`));
        });
      }
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  return {
    core,
    batch,
    networking,
    rbac,
    apiext,
    describe: () => `${connection.label} (context=${ctx})`,
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
      const { options, payload } = await buildAuthedRequest(method, path, body);
      // 30s socket timeout. Without this the request could hang for tens of
      // minutes if the API server stops responding mid-handshake (Node's
      // default keep-alive socket has no upper bound). 30s is well above
      // realistic API server tail latency but short enough that ensureTenant
      // surfaces an actionable error rather than appearing to stall.
      const REQUEST_TIMEOUT_MS = 30_000;
      const res = await sendHttps(options, payload, REQUEST_TIMEOUT_MS, `k8s API ${method} ${path}`);
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      for await (const chunk of res) {
        chunks.push(chunk as Buffer);
      }
      const text = Buffer.concat(chunks).toString("utf-8");
      if (status < 200 || status >= 300) {
        throw new Error(`k8s API ${method} ${path} failed ${status}: ${text}`);
      }
      if (status === 204 || text.length === 0) return undefined as T;
      return JSON.parse(text) as T;
    },
    async requestStream(method: string, path: string, body?: unknown): Promise<Response> {
      const { options, payload } = await buildAuthedRequest(method, path, body);
      // No socket timeout: pod-log streams and event watches are intentionally
      // long-lived. The caller drives reconnect / cancellation via the
      // returned Response.body.getReader().
      const incoming = await sendHttps(options, payload);
      // Adapt the Node IncomingMessage into a Web Response so log-stream and
      // event-watch consumers (which call response.body.getReader()) work
      // uniformly.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          incoming.on("data", (chunk: Buffer) => {
            try {
              controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            } catch {
              /* controller already closed */
            }
          });
          incoming.on("end", () => {
            try { controller.close(); } catch { /* already closed */ }
          });
          incoming.on("error", (err) => {
            try { controller.error(err); } catch { /* already errored */ }
          });
        },
        cancel() {
          incoming.destroy();
        },
      });
      const headers = new Headers();
      for (const [k, v] of Object.entries(incoming.headers)) {
        if (Array.isArray(v)) for (const item of v) headers.append(k, item);
        else if (v !== undefined) headers.set(k, v);
      }
      return new Response(stream, {
        status: incoming.statusCode ?? 0,
        statusText: incoming.statusMessage ?? "",
        headers,
      });
    },
  };
}
