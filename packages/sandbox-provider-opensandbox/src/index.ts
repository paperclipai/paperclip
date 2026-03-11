import { randomUUID } from "node:crypto";
import {
  ConnectionConfig,
  Sandbox,
  SandboxManager,
} from "@alibaba-group/opensandbox";
import type {
  SandboxCreateOptions,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxInstance,
  SandboxProvider,
  SandboxTestResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_OPEN_SANDBOX_REQUEST_TIMEOUT_SECONDS = 180;

interface OpenSandboxProviderConfig {
  apiKey?: string;
  domain?: string;
  image?: string;
  useServerProxy: boolean;
  requestTimeoutSeconds: number;
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function toStringMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      result[key] = value;
      continue;
    }
    if (value === null || typeof value === "undefined") continue;
    result[key] = typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function readConfig(config: Record<string, unknown>): OpenSandboxProviderConfig {
  const providerConfig = parseObject(config.providerConfig);
  const env = parseObject(config.env);
  return {
    apiKey:
      asString(providerConfig.apiKey, "").trim() ||
      asString(providerConfig.token, "").trim() ||
      asString(env.OPEN_SANDBOX_API_KEY, "").trim() ||
      undefined,
    domain:
      asString(providerConfig.domain, "").trim() ||
      asString(env.OPEN_SANDBOX_DOMAIN, "").trim() ||
      undefined,
    image:
      asString(providerConfig.image, "").trim() ||
      undefined,
    useServerProxy: providerConfig.useServerProxy === true,
    requestTimeoutSeconds: Math.max(
      30,
      asNumber(providerConfig.requestTimeoutSeconds, DEFAULT_OPEN_SANDBOX_REQUEST_TIMEOUT_SECONDS),
    ),
  };
}

function toConnectionConfig(config: OpenSandboxProviderConfig) {
  return new ConnectionConfig({
    ...(config.domain ? { domain: config.domain } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.useServerProxy ? { useServerProxy: true } : {}),
    requestTimeoutSeconds: config.requestTimeoutSeconds,
  });
}

function timeoutSeconds(timeoutSec: number | undefined) {
  if (!timeoutSec || timeoutSec <= 0) return undefined;
  return timeoutSec;
}

function mapState(state: string | undefined) {
  const normalized = (state ?? "").toLowerCase();
  if (normalized === "running" || normalized === "creating" || normalized === "resuming") {
    return "running" as const;
  }
  if (normalized === "error") {
    return "error" as const;
  }
  return "stopped" as const;
}

class OpenSandboxInstance implements SandboxInstance {
  constructor(
    readonly id: string,
    private readonly sandbox: Sandbox,
  ) {}

  async exec(command: string, opts: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    let resolvedCommand = command;
    let stdinPath: string | null = null;

    if (typeof opts.stdin === "string" && opts.stdin.length > 0) {
      stdinPath = `/tmp/paperclip-stdin-${randomUUID()}.txt`;
      await this.writeFile(stdinPath, opts.stdin);
      resolvedCommand = `sh -lc ${shellEscape(`${command} < ${shellEscape(stdinPath)}`)}`;
    }

    try {
      const execution = await this.sandbox.commands.run(
        resolvedCommand,
        {
          workingDirectory: opts.cwd,
          timeoutSeconds: timeoutSeconds(opts.timeoutSec),
        },
        {
          onStdout: (msg) => opts.onStdout?.(msg.text),
          onStderr: (msg) => opts.onStderr?.(msg.text),
        },
      );

      const status = execution.id
        ? await this.sandbox.commands.getCommandStatus(execution.id)
        : null;
      const errorText = status?.error ?? execution.error?.value ?? "";

      return {
        exitCode:
          typeof status?.exitCode === "number"
            ? status.exitCode
            : execution.error
              ? 1
              : 0,
        signal: null,
        timedOut: /timeout/i.test(errorText),
      };
    } finally {
      if (stdinPath) {
        void this.sandbox.commands.run(`rm -f ${shellEscape(stdinPath)}`, {
          timeoutSeconds: 10,
        }).catch(() => undefined);
      }
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sandbox.files.writeFiles([{ path, data: content }]);
  }

  async readFile(path: string): Promise<string> {
    return await this.sandbox.files.readFile(path);
  }

  async status() {
    const info = await this.sandbox.getInfo();
    return {
      status: mapState(info.status?.state),
      endpoint: null,
    };
  }

  async destroy(): Promise<void> {
    try {
      await this.sandbox.kill();
    } finally {
      await this.sandbox.close().catch(() => undefined);
    }
  }
}

export class OpenSandboxProvider implements SandboxProvider {
  readonly type = "opensandbox";

  constructor(private readonly config: Record<string, unknown>) {}

  private providerConfig() {
    return readConfig(this.config);
  }

  async create(opts: SandboxCreateOptions): Promise<SandboxInstance> {
    const config = this.providerConfig();
    const image = opts.image ?? config.image;
    if (!image) {
      throw new Error("sandbox.providerConfig.image is required for the OpenSandbox provider");
    }

    const sandbox = await Sandbox.create({
      connectionConfig: toConnectionConfig(config),
      image,
      ...(opts.env ? { env: opts.env } : {}),
      ...(toStringMetadata(opts.metadata) ? { metadata: toStringMetadata(opts.metadata) } : {}),
      ...(typeof opts.timeoutSec === "number" ? { timeoutSeconds: timeoutSeconds(opts.timeoutSec) } : {}),
      readyTimeoutSeconds: config.requestTimeoutSeconds,
    });

    return new OpenSandboxInstance(sandbox.id, sandbox);
  }

  async reconnect(id: string): Promise<SandboxInstance> {
    const sandbox = await Sandbox.connect({
      sandboxId: id,
      connectionConfig: toConnectionConfig(this.providerConfig()),
    });
    return new OpenSandboxInstance(sandbox.id, sandbox);
  }

  async testConnection(config: Record<string, unknown> = this.config): Promise<SandboxTestResult> {
    const providerConfig = readConfig(config);
    const manager = SandboxManager.create({
      connectionConfig: toConnectionConfig(providerConfig),
    });

    try {
      const response = await manager.listSandboxInfos({ pageSize: 1 });
      const sandboxes = response.items ?? [];
      return {
        ok: true,
        detail:
          sandboxes.length > 0
            ? `OpenSandbox reachable; found ${sandboxes.length} sandbox(s) on the first page.`
            : "OpenSandbox reachable.",
      };
    } finally {
      await manager.close().catch(() => undefined);
    }
  }
}

export function createOpenSandboxProvider(config: Record<string, unknown>): SandboxProvider {
  return new OpenSandboxProvider(config);
}
