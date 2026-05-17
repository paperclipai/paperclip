import type {
  EnvironmentProbeResult,
  PluginSandboxEnvironmentConfig,
  SandboxEnvironmentConfig,
} from "@paperclipai/shared";
import type {
  AcquireSandboxLeaseInput,
  DestroySandboxLeaseInput,
  PrepareSandboxWorkspaceInput,
  PreparedSandboxWorkspace,
  ReadSandboxLogsInput,
  ReleaseSandboxLeaseInput,
  ResumeSandboxLeaseInput,
  SandboxExecuteInput,
  SandboxExecuteResult,
  SandboxLeaseHandle,
  SandboxProvider,
  SandboxProviderCapabilityFlags,
  SandboxProviderLogLine,
  SandboxProviderLogsResult,
  SandboxProviderStatusSnapshot,
  SandboxProviderStreamEvent,
  SandboxProviderValidationIssue,
  SandboxProviderValidationResult,
  StartSandboxLeaseInput,
  StopSandboxLeaseInput,
  StreamSandboxEventsInput,
} from "./provider-contract.js";
import {
  PREVIEW_NO_SECRET_INJECTION,
  SandboxProviderError,
  previewSandboxProviderStatus,
  throwIfAborted,
} from "./provider-contract.js";

export const E2B_SANDBOX_PROVIDER_KEY = "e2b" as const;
export const DAYTONA_SANDBOX_PROVIDER_KEY = "daytona" as const;
export const MANAGED_SANDBOX_LIVE_ENV = "SANDBOX_PROVIDER_ALLOW_LIVE" as const;

type ManagedSandboxProviderKey = typeof E2B_SANDBOX_PROVIDER_KEY | typeof DAYTONA_SANDBOX_PROVIDER_KEY;

export interface ManagedSandboxProviderConfig extends PluginSandboxEnvironmentConfig {
  provider: string;
  image?: string;
  snapshot?: string;
  template?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  network?: Record<string, unknown>;
  region?: string;
  apiUrl?: string;
  language?: string;
  resources?: Record<string, number>;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
}

export type ManagedSandboxProviderFailureMode =
  | "auth_failure"
  | "rate_limit"
  | "lease_not_found"
  | "exec_timeout"
  | "network_egress_denied";

interface ManagedSandboxProviderSurface {
  provider: ManagedSandboxProviderKey;
  label: string;
  docsUrl: string;
  apiReferenceUrl: string;
  apiKeyEnv: string;
  baseUrl: string;
  createPath: string;
  startPath: (sandboxId: string) => string;
  execPath: (sandboxId: string) => string;
  logsPath: (sandboxId: string) => string;
  eventsPath: (sandboxId: string) => string;
  releasePath: (sandboxId: string) => string;
  destroyPath: (sandboxId: string) => string;
}

interface ManagedSandboxRecord {
  id: string;
  provider: ManagedSandboxProviderKey;
  state: "created" | "running" | "released" | "destroyed";
  metadata: Record<string, unknown>;
}

interface ManagedSandboxCreateInput {
  config: ManagedSandboxProviderConfig;
  environmentId: string;
  heartbeatRunId: string;
  issueId: string | null;
}

interface ManagedSandboxExecuteTransportInput {
  sandboxId: string;
  config: ManagedSandboxProviderConfig;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface ManagedSandboxReleaseInput {
  sandboxId: string;
  status?: ReleaseSandboxLeaseInput["status"];
  reason?: string | null;
  signal?: AbortSignal;
}

export interface ManagedSandboxFakeRequest {
  method: string;
  path: string;
  body?: Record<string, unknown> | null;
}

interface ManagedSandboxTransport {
  readonly mode: "mock-disabled" | "mock-http";
  createSandbox(input: ManagedSandboxCreateInput): Promise<ManagedSandboxRecord>;
  startSandbox(input: { sandboxId: string; signal?: AbortSignal }): Promise<ManagedSandboxRecord>;
  executeCommand(input: ManagedSandboxExecuteTransportInput): Promise<SandboxExecuteResult>;
  readLogs(input: { sandboxId: string; tail?: number; cursor?: string | null; signal?: AbortSignal }): Promise<SandboxProviderLogsResult>;
  streamEvents(input: { sandboxId: string; signal?: AbortSignal }): AsyncIterable<SandboxProviderStreamEvent>;
  releaseSandbox(input: ManagedSandboxReleaseInput): Promise<void>;
  destroySandbox(input: ManagedSandboxReleaseInput): Promise<void>;
}

export interface ManagedSandboxProviderOptions {
  transport?: ManagedSandboxTransport;
}

const MANAGED_CAPABILITIES: SandboxProviderCapabilityFlags = Object.freeze({
  lease: true,
  start: true,
  exec: true,
  readLogs: true,
  streamEvents: true,
  stop: true,
  destroy: true,
});

const DEFAULT_E2B_TEMPLATE = "base";
const MANAGED_PROVIDER_TIMEOUT_MAX_MS = 86_400_000;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const E2B_SURFACE: ManagedSandboxProviderSurface = Object.freeze({
  provider: E2B_SANDBOX_PROVIDER_KEY,
  label: "E2B",
  docsUrl: "https://e2b.dev/docs/sandbox",
  apiReferenceUrl: "https://e2b.dev/docs/api-reference/sandboxes/list-sandboxes",
  apiKeyEnv: "E2B_API_KEY",
  baseUrl: "https://api.e2b.app",
  createPath: "/sandboxes",
  startPath: (sandboxId: string) => `/sandboxes/${encodeURIComponent(sandboxId)}/resume`,
  execPath: (sandboxId: string) => `/sandboxes/${encodeURIComponent(sandboxId)}/commands`,
  logsPath: (sandboxId: string) => `/sandboxes/${encodeURIComponent(sandboxId)}/logs`,
  eventsPath: (sandboxId: string) => `/sandboxes/${encodeURIComponent(sandboxId)}/events`,
  releasePath: (sandboxId: string) => `/sandboxes/${encodeURIComponent(sandboxId)}/pause`,
  destroyPath: (sandboxId: string) => `/sandboxes/${encodeURIComponent(sandboxId)}`,
});

const DAYTONA_SURFACE: ManagedSandboxProviderSurface = Object.freeze({
  provider: DAYTONA_SANDBOX_PROVIDER_KEY,
  label: "Daytona",
  docsUrl: "https://www.daytona.io/docs/en/sandboxes",
  apiReferenceUrl: "https://www.daytona.io/docs/openapi.json",
  apiKeyEnv: "DAYTONA_API_KEY",
  baseUrl: "https://api.daytona.io",
  createPath: "/sandbox",
  startPath: (sandboxId: string) => `/sandbox/${encodeURIComponent(sandboxId)}/start`,
  execPath: (sandboxId: string) => `/toolbox/${encodeURIComponent(sandboxId)}/toolbox/process/execute`,
  logsPath: (sandboxId: string) => `/sandbox/${encodeURIComponent(sandboxId)}/telemetry/logs`,
  eventsPath: (sandboxId: string) => `/sandbox/${encodeURIComponent(sandboxId)}/telemetry/traces`,
  releasePath: (sandboxId: string) => `/sandbox/${encodeURIComponent(sandboxId)}/stop`,
  destroyPath: (sandboxId: string) => `/sandbox/${encodeURIComponent(sandboxId)}`,
});

export function isManagedSandboxLiveAllowed(): boolean {
  const flag = process.env[MANAGED_SANDBOX_LIVE_ENV];
  if (!flag) return false;
  return flag === "1" || flag.toLowerCase() === "true";
}

function assertManagedConfig(
  provider: ManagedSandboxProviderKey,
  config: SandboxEnvironmentConfig,
): asserts config is ManagedSandboxProviderConfig {
  if ((config as { provider?: unknown }).provider !== provider) {
    throw new Error(`Managed sandbox provider "${provider}" received config for provider "${config.provider}".`);
  }
}

function optionalNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateOptionalString(
  issues: SandboxProviderValidationIssue[],
  config: Record<string, unknown>,
  path: keyof ManagedSandboxProviderConfig,
): boolean {
  if (config[path] === undefined) return false;
  if (!optionalNonEmptyString(config[path])) {
    issues.push({ path: String(path), message: `${String(path)} must be a non-empty string when provided.` });
    return false;
  }
  return true;
}

function validateManagedConfig(
  surface: ManagedSandboxProviderSurface,
  config: SandboxEnvironmentConfig,
): SandboxProviderValidationResult {
  const issues: SandboxProviderValidationIssue[] = [];
  const provider = (config as { provider?: unknown }).provider;
  if (provider !== surface.provider) {
    issues.push({ path: "provider", message: `${surface.label} sandbox configs must use provider=\"${surface.provider}\".` });
  }
  const maybeConfig = config as ManagedSandboxProviderConfig;
  const configRecord = maybeConfig as unknown as Record<string, unknown>;
  const hasImage = validateOptionalString(issues, configRecord, "image");
  const hasSnapshot = validateOptionalString(issues, configRecord, "snapshot");
  const hasTemplate = validateOptionalString(issues, configRecord, "template");
  if (surface.provider === DAYTONA_SANDBOX_PROVIDER_KEY) {
    if (!hasImage && !hasSnapshot && !hasTemplate) {
      issues.push({ path: "image", message: "Daytona sandbox config must include an image, snapshot, or template identifier." });
    }
    if (hasImage && hasSnapshot) {
      issues.push({ path: "snapshot", message: "Daytona sandbox config must not set both image and snapshot." });
    }
  }
  if (surface.provider === E2B_SANDBOX_PROVIDER_KEY && configRecord.image !== undefined && !hasImage) {
    issues.push({ path: "image", message: "E2B sandbox image must be a non-empty string when provided." });
  }
  if (configRecord.apiKey !== undefined) {
    issues.push({
      path: "apiKey",
      message: `${surface.label} sandbox provider spike does not accept raw API keys in config; use ${surface.apiKeyEnv} only for explicit approved live mode.`,
    });
  }
  if (maybeConfig.apiUrl !== undefined) {
    if (!optionalNonEmptyString(maybeConfig.apiUrl)) {
      issues.push({ path: "apiUrl", message: "apiUrl must be a non-empty URL string when provided." });
    } else {
      try {
        new URL(maybeConfig.apiUrl);
      } catch {
        issues.push({ path: "apiUrl", message: "apiUrl must be a valid URL when provided." });
      }
    }
  }
  if (
    maybeConfig.timeoutMs !== undefined &&
    (!Number.isFinite(maybeConfig.timeoutMs) || maybeConfig.timeoutMs <= 0 || maybeConfig.timeoutMs > MANAGED_PROVIDER_TIMEOUT_MAX_MS)
  ) {
    issues.push({ path: "timeoutMs", message: `timeoutMs must be between 1 and ${MANAGED_PROVIDER_TIMEOUT_MAX_MS} when provided.` });
  }
  for (const path of ["autoStopInterval", "autoArchiveInterval", "autoDeleteInterval"] as const) {
    const value = maybeConfig[path];
    if (value === undefined) continue;
    const min = path === "autoDeleteInterval" ? -1 : 0;
    if (!Number.isFinite(value) || value < min) {
      issues.push({ path, message: `${path} must be >= ${min} when provided.` });
    }
  }
  if (maybeConfig.resources !== undefined) {
    if (typeof maybeConfig.resources !== "object" || maybeConfig.resources === null || Array.isArray(maybeConfig.resources)) {
      issues.push({ path: "resources", message: "resources must be an object of positive numeric limits when provided." });
    } else {
      for (const [key, value] of Object.entries(maybeConfig.resources)) {
        if (!Number.isFinite(value) || value <= 0) {
          issues.push({ path: `resources.${key}`, message: "resource limits must be positive numbers when provided." });
        }
      }
    }
  }
  if (maybeConfig.env !== undefined) {
    if (typeof maybeConfig.env !== "object" || maybeConfig.env === null || Array.isArray(maybeConfig.env)) {
      issues.push({ path: "env", message: "env injection must be a string-to-string map with shell-safe variable names." });
    } else {
      const invalidEnvKey = Object.entries(maybeConfig.env).find(
        ([key, value]) => !ENV_KEY_PATTERN.test(key) || typeof value !== "string",
      );
      if (invalidEnvKey) {
        issues.push({ path: "env", message: "env injection must be a string-to-string map with shell-safe variable names." });
      }
    }
  }
  const normalizedConfig: ManagedSandboxProviderConfig | undefined = issues.length === 0
    ? { ...maybeConfig, provider: surface.provider, reuseLease: maybeConfig.reuseLease === true }
    : undefined;
  if (normalizedConfig) {
    for (const key of ["image", "snapshot", "template", "apiUrl", "language", "region"] as const) {
      const value = normalizedConfig[key];
      if (typeof value === "string") normalizedConfig[key] = value.trim();
    }
    if (surface.provider === E2B_SANDBOX_PROVIDER_KEY && !normalizedConfig.image && !normalizedConfig.template) {
      normalizedConfig.template = DEFAULT_E2B_TEMPLATE;
    }
  }
  return {
    ok: issues.length === 0,
    summary: issues.length === 0
      ? `${surface.label} sandbox provider spike accepted config in preview/mock mode.`
      : `${surface.label} sandbox provider spike rejected config.`,
    issues,
    details: {
      provider: surface.provider,
      docsUrl: surface.docsUrl,
      apiReferenceUrl: surface.apiReferenceUrl,
      apiKeyEnv: surface.apiKeyEnv,
      endpointSurface: {
        create: surface.createPath,
        start: surface.startPath(":sandboxId"),
        exec: surface.execPath(":sandboxId"),
        logs: surface.logsPath(":sandboxId"),
        events: surface.eventsPath(":sandboxId"),
        release: surface.releasePath(":sandboxId"),
        destroy: surface.destroyPath(":sandboxId"),
      },
      liveEnv: MANAGED_SANDBOX_LIVE_ENV,
      liveFlagSet: isManagedSandboxLiveAllowed(),
      liveAllowed: false,
      mockedTransportsOnly: true,
      previewOnly: true,
    },
    normalizedConfig,
  };
}

function previewNetworkPolicy(network: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!network) return undefined;
  return {
    keys: Object.keys(network).sort(),
    egress: typeof network.egress === "string" ? network.egress : undefined,
  };
}

function redactEnvMap(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(Object.keys(env).sort().map((key) => [key, "[redacted]"]));
}

function sanitizeConfigForTransport(config: ManagedSandboxProviderConfig): ManagedSandboxProviderConfig {
  return {
    ...config,
    env: redactEnvMap(config.env),
  };
}

function sanitizedStdinForTransport(stdin: string | undefined): string | undefined {
  return stdin === undefined ? undefined : "[redacted-stdin]";
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function sortedStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value].sort() : null;
}

function buildMetadata(input: {
  surface: ManagedSandboxProviderSurface;
  config: ManagedSandboxProviderConfig;
  record: ManagedSandboxRecord;
  transportMode: ManagedSandboxTransport["mode"];
}): Record<string, unknown> {
  return {
    provider: input.surface.provider,
    kind: input.surface.provider,
    providerSandboxId: input.record.id,
    sandboxState: input.record.state,
    image: input.config.image,
    snapshot: input.config.snapshot,
    template: input.config.template,
    reuseLease: input.config.reuseLease === true,
    timeoutMs: input.config.timeoutMs,
    region: input.config.region,
    language: input.config.language,
    resourceKeys: input.config.resources ? Object.keys(input.config.resources).sort() : [],
    networkPolicy: previewNetworkPolicy(input.config.network),
    envKeys: input.config.env ? Object.keys(input.config.env).sort() : [],
    docsUrl: input.surface.docsUrl,
    apiReferenceUrl: input.surface.apiReferenceUrl,
    liveEnv: MANAGED_SANDBOX_LIVE_ENV,
    transport: input.transportMode,
    previewOnly: true,
  };
}

function providerLeaseId(surface: ManagedSandboxProviderSurface, sandboxId: string): string {
  return `sandbox://${surface.provider}/${sandboxId}`;
}

function sandboxIdFromProviderLeaseId(
  surface: ManagedSandboxProviderSurface,
  value: string | null,
): string {
  const prefix = `sandbox://${surface.provider}/`;
  if (!value?.startsWith(prefix)) {
    throw new SandboxProviderError("LEASE_NOT_FOUND", `${surface.label} sandbox provider lease is missing or not owned by this provider.`, {
      details: { provider: surface.provider, providerLeaseId: value },
    });
  }
  const sandboxId = value.slice(prefix.length);
  if (!sandboxId) {
    throw new SandboxProviderError("LEASE_NOT_FOUND", `${surface.label} sandbox provider lease does not include a sandbox id.`, {
      details: { provider: surface.provider, providerLeaseId: value },
    });
  }
  return decodeURIComponent(sandboxId);
}

class MockOnlyManagedSandboxTransport implements ManagedSandboxTransport {
  readonly mode = "mock-disabled" as const;

  constructor(private readonly surface: ManagedSandboxProviderSurface) {}

  private disabledError(): SandboxProviderError {
    return new SandboxProviderError(
      "PROVIDER_DISABLED",
      `${this.surface.label} sandbox provider spike is mock-transport-only in LET-351; inject createManagedSandboxFakeHttpServer().transport for tests. ${MANAGED_SANDBOX_LIVE_ENV} is recorded for future pilot gating but is not honored by this implementation.`,
      {
        details: {
          provider: this.surface.provider,
          liveEnv: MANAGED_SANDBOX_LIVE_ENV,
          docsUrl: this.surface.docsUrl,
          apiReferenceUrl: this.surface.apiReferenceUrl,
          mockedTransportsOnly: true,
        },
      },
    );
  }

  private fail(): never {
    throw this.disabledError();
  }

  async createSandbox(_input: ManagedSandboxCreateInput): Promise<ManagedSandboxRecord> {
    this.fail();
  }

  async startSandbox(_input: { sandboxId: string; signal?: AbortSignal }): Promise<ManagedSandboxRecord> {
    this.fail();
  }

  async executeCommand(_input: ManagedSandboxExecuteTransportInput): Promise<SandboxExecuteResult> {
    this.fail();
  }

  async readLogs(_input: { sandboxId: string; tail?: number; cursor?: string | null; signal?: AbortSignal }): Promise<SandboxProviderLogsResult> {
    this.fail();
  }

  async *streamEvents(_input: { sandboxId: string; signal?: AbortSignal }): AsyncIterable<SandboxProviderStreamEvent> {
    this.fail();
  }

  async releaseSandbox(_input: ManagedSandboxReleaseInput): Promise<void> {
    this.fail();
  }

  async destroySandbox(_input: ManagedSandboxReleaseInput): Promise<void> {
    this.fail();
  }
}

function isLogLine(value: unknown): value is SandboxProviderLogLine {
  if (typeof value !== "object" || value === null) return false;
  const maybe = value as Partial<SandboxProviderLogLine>;
  return typeof maybe.timestamp === "string" &&
    (maybe.stream === "stdout" || maybe.stream === "stderr" || maybe.stream === "system") &&
    typeof maybe.message === "string";
}

function isStreamEvent(value: unknown): value is SandboxProviderStreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const maybe = value as Partial<SandboxProviderStreamEvent>;
  return typeof maybe.type === "string" && typeof maybe.timestamp === "string" &&
    typeof maybe.data === "object" && maybe.data !== null;
}

abstract class BaseManagedSandboxProvider implements SandboxProvider {
  readonly kind = "builtin" as const;
  readonly capabilities = MANAGED_CAPABILITIES;
  readonly secretInjection = PREVIEW_NO_SECRET_INJECTION;
  private readonly transport: ManagedSandboxTransport;

  protected constructor(
    protected readonly surface: ManagedSandboxProviderSurface,
    options: ManagedSandboxProviderOptions = {},
  ) {
    this.transport = options.transport ?? new MockOnlyManagedSandboxTransport(surface);
  }

  get provider(): ManagedSandboxProviderKey {
    return this.surface.provider;
  }

  status(): SandboxProviderStatusSnapshot {
    return previewSandboxProviderStatus({
      provider: this.surface.provider,
      enabled: this.transport.mode === "mock-http",
      capabilities: this.capabilities,
      secretInjection: this.secretInjection,
    });
  }

  async validateConfig(config: SandboxEnvironmentConfig): Promise<SandboxProviderValidationResult> {
    const result = validateManagedConfig(this.surface, config);
    result.details = {
      ...(result.details ?? {}),
      transport: this.transport.mode,
    };
    return result;
  }

  async probe(config: SandboxEnvironmentConfig): Promise<EnvironmentProbeResult> {
    const validation = await this.validateConfig(config);
    return {
      ok: validation.ok,
      driver: "sandbox",
      summary: validation.ok
        ? `${this.surface.label} sandbox provider spike is available in ${this.transport.mode} mode; live calls remain approval-gated.`
        : validation.summary,
      details: {
        ...(validation.details ?? {}),
        issues: validation.issues ?? [],
      },
    };
  }

  async lease(input: AcquireSandboxLeaseInput): Promise<SandboxLeaseHandle> {
    return this.acquireLease(input);
  }

  async acquireLease(input: AcquireSandboxLeaseInput): Promise<SandboxLeaseHandle> {
    assertManagedConfig(this.surface.provider, input.config);
    const validation = await this.validateConfig(input.config);
    if (!validation.ok) {
      throw new SandboxProviderError("CONFIG_INVALID", validation.summary, {
        details: { provider: this.surface.provider, issues: validation.issues ?? [] },
      });
    }
    const record = await this.transport.createSandbox({
      config: sanitizeConfigForTransport(input.config),
      environmentId: input.environmentId,
      heartbeatRunId: input.heartbeatRunId,
      issueId: input.issueId,
    });
    return {
      providerLeaseId: providerLeaseId(this.surface, record.id),
      metadata: buildMetadata({
        surface: this.surface,
        config: input.config,
        record,
        transportMode: this.transport.mode,
      }),
    };
  }

  async resumeLease(input: ResumeSandboxLeaseInput): Promise<SandboxLeaseHandle | null> {
    assertManagedConfig(this.surface.provider, input.config);
    const sandboxId = sandboxIdFromProviderLeaseId(this.surface, input.providerLeaseId);
    try {
      const record = await this.transport.startSandbox({ sandboxId });
      return {
        providerLeaseId: input.providerLeaseId,
        metadata: buildMetadata({
          surface: this.surface,
          config: input.config,
          record,
          transportMode: this.transport.mode,
        }),
      };
    } catch (error) {
      if (error instanceof SandboxProviderError && error.code === "LEASE_NOT_FOUND") return null;
      throw error;
    }
  }

  async releaseLease(input: ReleaseSandboxLeaseInput): Promise<void> {
    const sandboxId = sandboxIdFromProviderLeaseId(this.surface, input.providerLeaseId);
    await this.transport.releaseSandbox({ sandboxId, status: input.status });
  }

  async destroyLease(input: DestroySandboxLeaseInput): Promise<void> {
    const sandboxId = sandboxIdFromProviderLeaseId(this.surface, input.providerLeaseId);
    await this.transport.destroySandbox({ sandboxId });
  }

  async prepareWorkspace(input: PrepareSandboxWorkspaceInput): Promise<PreparedSandboxWorkspace> {
    assertManagedConfig(this.surface.provider, input.config);
    const sandboxId = sandboxIdFromProviderLeaseId(this.surface, input.providerLeaseId);
    return {
      remotePath: input.workspace.remotePath ?? `/workspace/${sandboxId}`,
      metadata: {
        provider: this.surface.provider,
        providerSandboxId: sandboxId,
        mode: input.workspace.mode ?? "managed-sandbox-preview",
        previewOnly: true,
      },
    };
  }

  async start(input: StartSandboxLeaseInput): Promise<SandboxLeaseHandle> {
    throwIfAborted(input.signal);
    const sandboxId = sandboxIdFromProviderLeaseId(this.surface, input.lease.providerLeaseId);
    const record = await this.transport.startSandbox({ sandboxId, signal: input.signal });
    return {
      providerLeaseId: input.lease.providerLeaseId,
      metadata: {
        ...input.lease.metadata,
        ...record.metadata,
        sandboxState: record.state,
        providerSandboxId: record.id,
      },
    };
  }

  async exec(input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
    return this.execute(input);
  }

  async execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
    assertManagedConfig(this.surface.provider, input.config);
    throwIfAborted(input.signal);
    const sandboxId = sandboxIdFromProviderLeaseId(this.surface, input.providerLeaseId);
    return await this.transport.executeCommand({
      sandboxId,
      config: sanitizeConfigForTransport(input.config),
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: redactEnvMap(input.env),
      stdin: sanitizedStdinForTransport(input.stdin),
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
  }

  async readLogs(input: ReadSandboxLogsInput): Promise<SandboxProviderLogsResult> {
    throwIfAborted(input.signal);
    const sandboxId = sandboxIdFromProviderLeaseId(this.surface, input.providerLeaseId);
    return await this.transport.readLogs({
      sandboxId,
      tail: input.tail,
      cursor: input.cursor,
      signal: input.signal,
    });
  }

  async *streamEvents(input: StreamSandboxEventsInput): AsyncIterable<SandboxProviderStreamEvent> {
    throwIfAborted(input.signal);
    const sandboxId = sandboxIdFromProviderLeaseId(this.surface, input.providerLeaseId);
    yield* this.transport.streamEvents({ sandboxId, signal: input.signal });
  }

  async stop(input: StopSandboxLeaseInput): Promise<void> {
    throwIfAborted(input.signal);
    const sandboxId = sandboxIdFromProviderLeaseId(this.surface, input.providerLeaseId);
    await this.transport.releaseSandbox({ sandboxId, reason: input.reason, signal: input.signal });
  }

  async destroy(input: StopSandboxLeaseInput): Promise<void> {
    throwIfAborted(input.signal);
    const sandboxId = sandboxIdFromProviderLeaseId(this.surface, input.providerLeaseId);
    await this.transport.destroySandbox({ sandboxId, reason: input.reason, signal: input.signal });
  }

  matchesReusableLease(input: {
    config: SandboxEnvironmentConfig;
    lease: { providerLeaseId: string | null; metadata: Record<string, unknown> | null };
  }): boolean {
    assertManagedConfig(this.surface.provider, input.config);
    const metadata = input.lease.metadata ?? {};
    if (
      input.config.reuseLease !== true ||
      typeof input.lease.providerLeaseId !== "string" ||
      !input.lease.providerLeaseId.startsWith(`sandbox://${this.surface.provider}/`) ||
      metadata.provider !== this.surface.provider ||
      metadata.reuseLease !== true
    ) {
      return false;
    }
    for (const key of ["image", "snapshot", "template", "timeoutMs", "region", "language"] as const) {
      const value = input.config[key];
      if (value !== undefined && metadata[key] !== value) return false;
    }
    if (input.config.env !== undefined) {
      const metadataEnvKeys = sortedStringArray(metadata.envKeys);
      if (!metadataEnvKeys || stableJson(metadataEnvKeys) !== stableJson(Object.keys(input.config.env).sort())) return false;
    }
    if (input.config.resources !== undefined) {
      const metadataResourceKeys = sortedStringArray(metadata.resourceKeys);
      if (!metadataResourceKeys || stableJson(metadataResourceKeys) !== stableJson(Object.keys(input.config.resources).sort())) return false;
    }
    if (input.config.network !== undefined && stableJson(metadata.networkPolicy) !== stableJson(previewNetworkPolicy(input.config.network))) {
      return false;
    }
    return true;
  }

  configFromLeaseMetadata(metadata: Record<string, unknown>): SandboxEnvironmentConfig | null {
    if (metadata.provider !== this.surface.provider) return null;
    const config: ManagedSandboxProviderConfig = {
      provider: this.surface.provider,
      reuseLease: metadata.reuseLease === true,
    };
    if (typeof metadata.image === "string") config.image = metadata.image;
    if (typeof metadata.snapshot === "string") config.snapshot = metadata.snapshot;
    if (typeof metadata.template === "string") config.template = metadata.template;
    if (typeof metadata.timeoutMs === "number") config.timeoutMs = metadata.timeoutMs;
    if (typeof metadata.region === "string") config.region = metadata.region;
    if (typeof metadata.language === "string") config.language = metadata.language;
    return config;
  }
}

export class E2BSandboxProvider extends BaseManagedSandboxProvider {
  constructor(options: ManagedSandboxProviderOptions = {}) {
    super(E2B_SURFACE, options);
  }
}

export class DaytonaSandboxProvider extends BaseManagedSandboxProvider {
  constructor(options: ManagedSandboxProviderOptions = {}) {
    super(DAYTONA_SURFACE, options);
  }
}

function now(): string {
  return new Date().toISOString();
}

function failureToError(
  provider: ManagedSandboxProviderKey,
  failureMode: ManagedSandboxProviderFailureMode,
): SandboxProviderError {
  const details = { provider, failureMode };
  switch (failureMode) {
    case "auth_failure":
      return new SandboxProviderError("CONFIG_INVALID", `${provider} fake transport rejected authentication.`, {
        details: { ...details, status: 401, vendorCode: "auth_failed" },
      });
    case "rate_limit":
      return new SandboxProviderError("PROVIDER_FAILURE", `${provider} fake transport simulated provider rate limit.`, {
        retryable: true,
        details: { ...details, status: 429, vendorCode: "rate_limited" },
      });
    case "lease_not_found":
      return new SandboxProviderError("LEASE_NOT_FOUND", `${provider} fake transport could not find the sandbox lease.`, {
        details: { ...details, status: 404, vendorCode: "sandbox_not_found" },
      });
    case "exec_timeout":
      return new SandboxProviderError("TIMEOUT", `${provider} fake transport simulated command timeout.`, {
        retryable: true,
        details: { ...details, status: 504, vendorCode: "command_timeout" },
      });
    case "network_egress_denied":
      return new SandboxProviderError("PROVIDER_FAILURE", `${provider} fake transport denied network egress.`, {
        details: { ...details, status: 403, vendorCode: "network_egress_denied", reason: "network_egress_denied" },
      });
  }
}

export class ManagedSandboxFakeHttpServer {
  readonly requests: ManagedSandboxFakeRequest[] = [];
  readonly createdSandboxIds: string[] = [];
  readonly transport: ManagedSandboxTransport;
  private readonly surface: ManagedSandboxProviderSurface;
  private readonly records = new Map<string, ManagedSandboxRecord>();
  private readonly logs = new Map<string, SandboxProviderLogLine[]>();
  private readonly events = new Map<string, SandboxProviderStreamEvent[]>();
  private nextId = 1;

  constructor(input: { provider: ManagedSandboxProviderKey; failureMode?: ManagedSandboxProviderFailureMode }) {
    this.surface = input.provider === E2B_SANDBOX_PROVIDER_KEY ? E2B_SURFACE : DAYTONA_SURFACE;
    const failureMode = input.failureMode;
    this.transport = {
      mode: "mock-http",
      createSandbox: async (request) => this.createSandbox(request, failureMode),
      startSandbox: async (request) => this.startSandbox(request, failureMode),
      executeCommand: async (request) => this.executeCommand(request, failureMode),
      readLogs: async (request) => this.readLogs(request, failureMode),
      streamEvents: (request) => this.streamEvents(request, failureMode),
      releaseSandbox: async (request) => this.releaseSandbox(request, failureMode),
      destroySandbox: async (request) => this.destroySandbox(request, failureMode),
    };
  }

  expectedHappyPath(): string[] {
    const sandboxId = this.createdSandboxIds[0] ?? ":sandboxId";
    return [
      `POST ${this.surface.createPath}`,
      `POST ${this.surface.startPath(sandboxId)}`,
      `POST ${this.surface.execPath(sandboxId)}`,
      `GET ${this.surface.logsPath(sandboxId)}`,
      `GET ${this.surface.eventsPath(sandboxId)}`,
      `POST ${this.surface.releasePath(sandboxId)}`,
      `DELETE ${this.surface.destroyPath(sandboxId)}`,
    ];
  }

  private record(method: string, path: string, body: Record<string, unknown> | null = null): void {
    this.requests.push({ method, path, body });
  }

  private maybeThrow(failureMode: ManagedSandboxProviderFailureMode | undefined, phases: ManagedSandboxProviderFailureMode[]): void {
    if (failureMode && phases.includes(failureMode)) {
      throw failureToError(this.surface.provider, failureMode);
    }
  }

  private async createSandbox(
    input: ManagedSandboxCreateInput,
    failureMode: ManagedSandboxProviderFailureMode | undefined,
  ): Promise<ManagedSandboxRecord> {
    this.record("POST", this.surface.createPath, {
      image: input.config.image,
      snapshot: input.config.snapshot,
      template: input.config.template,
      apiUrlHost: input.config.apiUrl ? new URL(input.config.apiUrl).host : undefined,
      timeoutMs: input.config.timeoutMs,
      envKeys: input.config.env ? Object.keys(input.config.env).sort() : [],
      networkPolicy: previewNetworkPolicy(input.config.network),
      resourceKeys: input.config.resources ? Object.keys(input.config.resources).sort() : [],
    });
    this.maybeThrow(failureMode, ["auth_failure", "rate_limit"]);
    const id = `${this.surface.provider}-sandbox-${this.nextId++}`;
    this.createdSandboxIds.push(id);
    const record: ManagedSandboxRecord = {
      id,
      provider: this.surface.provider,
      state: "created",
      metadata: {
        id,
        provider: this.surface.provider,
        sandboxState: "created",
        transport: "mock-http",
        docsUrl: this.surface.docsUrl,
      },
    };
    this.records.set(id, record);
    this.logs.set(id, [{ timestamp: now(), stream: "system", message: `${this.surface.provider} sandbox ${id} created` }]);
    this.events.set(id, [{ type: "sandbox.created", timestamp: now(), data: { provider: this.surface.provider, sandboxId: id } }]);
    return record;
  }

  private requireRecord(
    sandboxId: string,
    failureMode: ManagedSandboxProviderFailureMode | undefined,
  ): ManagedSandboxRecord {
    this.maybeThrow(failureMode, ["lease_not_found"]);
    const record = this.records.get(sandboxId);
    if (!record || record.state === "destroyed") {
      throw failureToError(this.surface.provider, "lease_not_found");
    }
    return record;
  }

  private async startSandbox(
    input: { sandboxId: string; signal?: AbortSignal },
    failureMode: ManagedSandboxProviderFailureMode | undefined,
  ): Promise<ManagedSandboxRecord> {
    throwIfAborted(input.signal);
    this.record("POST", this.surface.startPath(input.sandboxId));
    const record = this.requireRecord(input.sandboxId, failureMode);
    record.state = "running";
    record.metadata = { ...record.metadata, sandboxState: "running" };
    this.logs.get(input.sandboxId)?.push({ timestamp: now(), stream: "system", message: `${this.surface.provider} sandbox ${input.sandboxId} started` });
    this.events.get(input.sandboxId)?.push({ type: "sandbox.started", timestamp: now(), data: { provider: this.surface.provider, sandboxId: input.sandboxId } });
    return record;
  }

  private async executeCommand(
    input: ManagedSandboxExecuteTransportInput,
    failureMode: ManagedSandboxProviderFailureMode | undefined,
  ): Promise<SandboxExecuteResult> {
    throwIfAborted(input.signal);
    this.record("POST", this.surface.execPath(input.sandboxId), {
      command: input.command,
      args: input.args ?? [],
      cwd: input.cwd,
      envKeys: input.env ? Object.keys(input.env).sort() : [],
      timeoutMs: input.timeoutMs ?? input.config.timeoutMs,
    });
    this.maybeThrow(failureMode, ["exec_timeout", "network_egress_denied"]);
    this.requireRecord(input.sandboxId, failureMode);
    const rendered = [input.command, ...(input.args ?? [])].join(" ").trim();
    this.logs.get(input.sandboxId)?.push({ timestamp: now(), stream: "stdout", message: rendered });
    return { exitCode: 0, stdout: `${this.surface.provider} mock executed: ${rendered}`, stderr: "" };
  }

  private async readLogs(
    input: { sandboxId: string; tail?: number; cursor?: string | null; signal?: AbortSignal },
    failureMode: ManagedSandboxProviderFailureMode | undefined,
  ): Promise<SandboxProviderLogsResult> {
    throwIfAborted(input.signal);
    this.record("GET", this.surface.logsPath(input.sandboxId));
    this.requireRecord(input.sandboxId, failureMode);
    const lines = this.logs.get(input.sandboxId) ?? [];
    const tail = typeof input.tail === "number" && input.tail > 0 ? input.tail : lines.length;
    return { lines: lines.slice(-tail), nextCursor: null, truncated: false };
  }

  private async *streamEvents(
    input: { sandboxId: string; signal?: AbortSignal },
    failureMode: ManagedSandboxProviderFailureMode | undefined,
  ): AsyncIterable<SandboxProviderStreamEvent> {
    throwIfAborted(input.signal);
    this.record("GET", this.surface.eventsPath(input.sandboxId));
    this.requireRecord(input.sandboxId, failureMode);
    for (const event of this.events.get(input.sandboxId) ?? []) {
      yield event;
    }
  }

  private async releaseSandbox(
    input: ManagedSandboxReleaseInput,
    failureMode: ManagedSandboxProviderFailureMode | undefined,
  ): Promise<void> {
    throwIfAborted(input.signal);
    this.record("POST", this.surface.releasePath(input.sandboxId), { status: input.status, reason: input.reason });
    this.maybeThrow(failureMode, ["lease_not_found"]);
    const record = this.records.get(input.sandboxId);
    if (!record || record.state === "destroyed") return;
    record.state = "released";
    record.metadata = { ...record.metadata, sandboxState: "released" };
  }

  private async destroySandbox(
    input: ManagedSandboxReleaseInput,
    failureMode: ManagedSandboxProviderFailureMode | undefined,
  ): Promise<void> {
    throwIfAborted(input.signal);
    this.record("DELETE", this.surface.destroyPath(input.sandboxId));
    this.maybeThrow(failureMode, ["lease_not_found"]);
    const record = this.records.get(input.sandboxId);
    if (!record || record.state === "destroyed") return;
    record.state = "destroyed";
    record.metadata = { ...record.metadata, sandboxState: "destroyed" };
  }
}

export function createManagedSandboxFakeHttpServer(input: {
  provider: ManagedSandboxProviderKey;
  failureMode?: ManagedSandboxProviderFailureMode;
}): ManagedSandboxFakeHttpServer {
  return new ManagedSandboxFakeHttpServer(input);
}

export const __testing = {
  E2B_SURFACE,
  DAYTONA_SURFACE,
  MockOnlyManagedSandboxTransport,
};
