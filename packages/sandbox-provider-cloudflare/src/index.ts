import type {
  SandboxCreateOptions,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxInstance,
  SandboxProvider,
  SandboxTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { randomUUID } from "node:crypto";

const DEFAULT_NAMESPACE = "paperclip";

interface CloudflareGatewayConfig {
  baseUrl: string;
  namespace: string;
  authToken: string | null;
}

function readGatewayConfig(config: Record<string, unknown>): CloudflareGatewayConfig {
  const providerConfig = parseObject(config.providerConfig);
  const env = parseObject(config.env);
  const baseUrl = asString(providerConfig.baseUrl, "").trim().replace(/\/+$/, "");
  const namespace = asString(providerConfig.namespace, DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE;
  const authToken =
    asString(providerConfig.authToken, "").trim() ||
    asString(providerConfig.token, "").trim() ||
    asString(env.CLOUDFLARE_GATEWAY_TOKEN, "").trim() ||
    null;

  if (!baseUrl) {
    throw new Error("sandbox.providerConfig.baseUrl is required for the Cloudflare sandbox provider");
  }

  return {
    baseUrl,
    namespace,
    authToken,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Cloudflare sandbox gateway request failed (${response.status})`);
  }
  if (!text) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function streamExecResponse(
  response: Response,
  opts: SandboxExecOptions,
): Promise<SandboxExecResult> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Cloudflare sandbox exec failed (${response.status})`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const payload = await readJson<SandboxExecResult>(response);
    return payload;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let result: SandboxExecResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const type = asString(event.type, "");
      if (type === "stdout") {
        const chunk = asString(event.chunk, "");
        if (chunk) await opts.onStdout?.(chunk);
        continue;
      }
      if (type === "stderr") {
        const chunk = asString(event.chunk, "");
        if (chunk) await opts.onStderr?.(chunk);
        continue;
      }
      if (type === "exit") {
        result = {
          exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
          signal: asString(event.signal, "") || null,
          timedOut: event.timedOut === true,
        };
      }
    }
  }

  if (buffer.trim()) {
    const event = JSON.parse(buffer) as Record<string, unknown>;
    if (asString(event.type, "") === "exit") {
      result = {
        exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
        signal: asString(event.signal, "") || null,
        timedOut: event.timedOut === true,
      };
    }
  }

  return result ?? { exitCode: null, signal: null, timedOut: false };
}

class CloudflareSandboxInstance implements SandboxInstance {
  constructor(
    readonly id: string,
    private readonly gateway: CloudflareGatewayConfig,
  ) {}

  private endpoint(pathname: string) {
    const url = new URL(`${this.gateway.baseUrl}${pathname}`);
    url.searchParams.set("namespace", this.gateway.namespace);
    return url;
  }

  private headers(extra: Record<string, string> = {}) {
    return {
      "content-type": "application/json",
      ...(this.gateway.authToken ? { authorization: `Bearer ${this.gateway.authToken}` } : {}),
      ...extra,
    };
  }

  async exec(command: string, opts: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    let resolvedCommand = command;
    let stdinPath: string | null = null;

    if (typeof opts.stdin === "string" && opts.stdin.length > 0) {
      stdinPath = `/tmp/paperclip-stdin-${randomUUID()}.txt`;
      await this.writeFile(stdinPath, opts.stdin);
      resolvedCommand = `sh -lc ${shellEscape(`${command} < ${shellEscape(stdinPath)}`)}`;
    }

    const response = await fetch(this.endpoint(`/v1/sandboxes/${encodeURIComponent(this.id)}/exec`), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        command: resolvedCommand,
        cwd: opts.cwd,
        env: opts.env ?? {},
        timeoutSec: opts.timeoutSec ?? 0,
      }),
    });

    try {
      return await streamExecResponse(response, opts);
    } finally {
      if (stdinPath) {
        void fetch(this.endpoint(`/v1/sandboxes/${encodeURIComponent(this.id)}/exec`), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            command: `rm -f ${shellEscape(stdinPath)}`,
            timeoutSec: 10,
          }),
        }).catch(() => undefined);
      }
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const response = await fetch(this.endpoint(`/v1/sandboxes/${encodeURIComponent(this.id)}/files`), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({
        path,
        content,
      }),
    });
    await readJson(response);
  }

  async readFile(path: string): Promise<string> {
    const url = this.endpoint(`/v1/sandboxes/${encodeURIComponent(this.id)}/files`);
    url.searchParams.set("path", path);
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers({ "content-type": "text/plain" }),
    });
    const payload = await readJson<{ content?: string }>(response);
    return typeof payload.content === "string" ? payload.content : "";
  }

  async status() {
    const response = await fetch(this.endpoint(`/v1/sandboxes/${encodeURIComponent(this.id)}`), {
      method: "GET",
      headers: this.headers({ "content-type": "text/plain" }),
    });
    const payload = await readJson<{ status?: "running" | "stopped" | "error"; endpoint?: string | null }>(
      response,
    );
    return {
      status: payload.status ?? "error",
      endpoint: payload.endpoint ?? null,
    };
  }

  async destroy(): Promise<void> {
    const response = await fetch(this.endpoint(`/v1/sandboxes/${encodeURIComponent(this.id)}`), {
      method: "DELETE",
      headers: this.headers({ "content-type": "text/plain" }),
    });
    await readJson(response);
  }
}

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly type = "cloudflare";

  constructor(private readonly config: Record<string, unknown>) {}

  private gateway() {
    return readGatewayConfig(this.config);
  }

  async create(opts: SandboxCreateOptions): Promise<SandboxInstance> {
    const gateway = this.gateway();
    const response = await fetch(`${gateway.baseUrl}/v1/sandboxes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(gateway.authToken ? { authorization: `Bearer ${gateway.authToken}` } : {}),
      },
      body: JSON.stringify({
        sandboxId: opts.sandboxId,
        namespace: gateway.namespace,
        env: opts.env ?? {},
        metadata: opts.metadata ?? {},
        image: opts.image,
        instanceType: opts.instanceType,
        timeoutSec: opts.timeoutSec ?? 0,
      }),
    });
    const payload = await readJson<{ sandboxId?: string }>(response);
    return new CloudflareSandboxInstance(payload.sandboxId ?? opts.sandboxId, gateway);
  }

  async reconnect(id: string): Promise<SandboxInstance> {
    return new CloudflareSandboxInstance(id, this.gateway());
  }

  async testConnection(config: Record<string, unknown> = this.config): Promise<SandboxTestResult> {
    const gateway = readGatewayConfig(config);
    const response = await fetch(`${gateway.baseUrl}/v1/health`, {
      method: "GET",
      headers: gateway.authToken ? { authorization: `Bearer ${gateway.authToken}` } : undefined,
    });
    const payload = await readJson<{ ok?: boolean; detail?: string | null }>(response);
    return {
      ok: payload.ok !== false,
      detail: payload.detail ?? null,
    };
  }
}

export function createCloudflareSandboxProvider(config: Record<string, unknown>): SandboxProvider {
  return new CloudflareSandboxProvider(config);
}
