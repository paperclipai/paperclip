import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { request } from "node:http";
import { isAbsolute } from "node:path";
import { RUNNER_TOOL_SCOPE_TOKEN_HEADER } from "../../vendor/paperclip-runner/index.js";

export interface RemoteMcpRelayBinding {
  runId: string;
  socketPath: string;
  token: string;
  expiresAt: number;
  authorized(): Promise<boolean>;
}

const bindings = new Map<string, RemoteMcpRelayBinding>();
const digest = (value: string) => createHash("sha256").update(value).digest();
const MAX_BODY = 1024 * 1024;
const MAX_RESULT = 4 * 1024 * 1024;

export function registerRemoteMcpRelay(binding: RemoteMcpRelayBinding): () => void {
  if (!isAbsolute(binding.socketPath) || binding.token.length < 32 || !Number.isFinite(binding.expiresAt)) {
    throw new Error("native_mcp_relay_invalid_binding");
  }
  if (bindings.has(binding.runId)) throw new Error("native_mcp_relay_already_registered");
  bindings.set(binding.runId, binding);
  return () => { if (bindings.get(binding.runId) === binding) bindings.delete(binding.runId); };
}

export function createRemoteMcpRelayToken(): string {
  return randomBytes(32).toString("base64url");
}

export function remoteMcpRelayUrl(origin: string, runId: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("cursor_cloud_public_url_required: configure PAPERCLIP_PUBLIC_URL with a reachable HTTPS origin");
  }
  return `${url.origin}/mcp/native-runs/${encodeURIComponent(runId)}`;
}

export async function forwardRemoteMcpRequest(input: {
  runId: string;
  authorization: string | undefined;
  scopeAuthorization?: string;
  body: unknown;
  mcpSessionId?: string;
}): Promise<{ status: number; body: Buffer; mcpSessionId?: string }> {
  const binding = bindings.get(input.runId);
  const supplied = input.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!binding || !supplied || !timingSafeEqual(digest(supplied), digest(binding.token)) || binding.expiresAt <= Date.now()) {
    return { status: 401, body: Buffer.alloc(0) };
  }
  if (!await binding.authorized() || bindings.get(input.runId) !== binding) {
    return { status: 403, body: Buffer.alloc(0) };
  }
  const body = Buffer.from(JSON.stringify(input.body ?? null));
  if (body.length > MAX_BODY) return { status: 413, body: Buffer.alloc(0) };
  return new Promise(resolve => {
    const upstream = request({ socketPath: binding.socketPath, path: "/mcp", method: "POST", headers: {
      "content-type": "application/json", accept: "application/json", authorization: `Bearer ${binding.token}`,
      "content-length": body.length,
      ...(input.mcpSessionId ? { "mcp-session-id": input.mcpSessionId } : {}),
      ...(input.scopeAuthorization ? { [RUNNER_TOOL_SCOPE_TOKEN_HEADER]: input.scopeAuthorization } : {}),
    } }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESULT) { upstream.destroy(); resolve({ status: 502, body: Buffer.alloc(0) }); }
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 502, body: Buffer.concat(chunks), ...(typeof response.headers["mcp-session-id"] === "string" ? { mcpSessionId: response.headers["mcp-session-id"] } : {}) }));
      response.on("error", () => resolve({ status: 502, body: Buffer.alloc(0) }));
    });
    upstream.setTimeout(120_000, () => upstream.destroy());
    upstream.on("error", () => resolve({ status: 503, body: Buffer.alloc(0) }));
    upstream.end(body);
  });
}
