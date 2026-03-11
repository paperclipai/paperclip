import { randomUUID } from "node:crypto";
import { Sandbox } from "e2b";
import type {
  SandboxCreateOptions,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxInstance,
  SandboxProvider,
  SandboxTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

interface E2BProviderConfig {
  apiKey?: string;
  accessToken?: string;
  domain?: string;
  template?: string;
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

function readConfig(config: Record<string, unknown>): E2BProviderConfig {
  const providerConfig = parseObject(config.providerConfig);
  const env = parseObject(config.env);
  const apiKey =
    asString(providerConfig.apiKey, "").trim() ||
    asString(providerConfig.token, "").trim() ||
    asString(env.E2B_API_KEY, "").trim() ||
    undefined;
  const accessToken =
    asString(providerConfig.accessToken, "").trim() ||
    asString(env.E2B_ACCESS_TOKEN, "").trim() ||
    undefined;
  const domain =
    asString(providerConfig.domain, "").trim() ||
    asString(env.E2B_DOMAIN, "").trim() ||
    undefined;
  const template =
    asString(providerConfig.template, "").trim() ||
    asString(providerConfig.image, "").trim() ||
    undefined;

  return {
    apiKey,
    accessToken,
    domain,
    template,
  };
}

function buildConnection(config: E2BProviderConfig) {
  return {
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.accessToken ? { accessToken: config.accessToken } : {}),
    ...(config.domain ? { domain: config.domain } : {}),
  };
}

function timeoutMs(timeoutSec: number | undefined) {
  if (!timeoutSec || timeoutSec <= 0) return undefined;
  return timeoutSec * 1000;
}

class E2BSandboxInstance implements SandboxInstance {
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
      const result = await this.sandbox.commands.run(resolvedCommand, {
        cwd: opts.cwd,
        envs: opts.env ?? {},
        timeoutMs: timeoutMs(opts.timeoutSec),
        onStdout: opts.onStdout,
        onStderr: opts.onStderr,
      });

      return {
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
        signal: null,
        timedOut: false,
      };
    } finally {
      if (stdinPath) {
        void this.sandbox.commands.run(`rm -f ${shellEscape(stdinPath)}`, {
          timeoutMs: 10_000,
        }).catch(() => undefined);
      }
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sandbox.files.write(path, content);
  }

  async readFile(path: string): Promise<string> {
    return await this.sandbox.files.read(path, { format: "text" });
  }

  async status() {
    const running = await this.sandbox.isRunning();
    return {
      status: running ? "running" : "stopped",
      endpoint: null,
    } as const;
  }

  async destroy(): Promise<void> {
    await this.sandbox.kill();
  }
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly type = "e2b";

  constructor(private readonly config: Record<string, unknown>) {}

  private providerConfig() {
    return readConfig(this.config);
  }

  async create(opts: SandboxCreateOptions): Promise<SandboxInstance> {
    const config = this.providerConfig();
    const connection = buildConnection(config);
    const metadata = toStringMetadata(opts.metadata);
    const baseOpts = {
      ...connection,
      ...(metadata ? { metadata } : {}),
      ...(opts.env ? { envs: opts.env } : {}),
      ...(typeof opts.timeoutSec === "number" ? { timeoutMs: timeoutMs(opts.timeoutSec) } : {}),
    };

    const sandbox = config.template
      ? await Sandbox.create(config.template, baseOpts)
      : await Sandbox.create(baseOpts);

    return new E2BSandboxInstance(sandbox.sandboxId, sandbox);
  }

  async reconnect(id: string): Promise<SandboxInstance> {
    const sandbox = await Sandbox.connect(id, buildConnection(this.providerConfig()));
    return new E2BSandboxInstance(sandbox.sandboxId, sandbox);
  }

  async testConnection(config: Record<string, unknown> = this.config): Promise<SandboxTestResult> {
    const providerConfig = readConfig(config);
    const page = await Sandbox.list(buildConnection(providerConfig)).nextItems();
    return {
      ok: true,
      detail:
        page.length > 0
          ? `E2B reachable; found ${page.length} sandbox(s) on the first page.`
          : "E2B reachable.",
    };
  }
}

export function createE2BSandboxProvider(config: Record<string, unknown>): SandboxProvider {
  return new E2BSandboxProvider(config);
}
