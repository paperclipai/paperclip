import { randomUUID } from "node:crypto";
import type {
  EnvironmentLeaseStatus,
  EnvironmentProbeResult,
  FakeSandboxEnvironmentConfig,
  SandboxEnvironmentConfig,
  SandboxEnvironmentProvider,
} from "@paperclipai/shared";

export interface SandboxProviderValidationResult {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export interface AcquireSandboxLeaseInput {
  config: SandboxEnvironmentConfig;
  environmentId: string;
  heartbeatRunId: string;
  issueId: string | null;
}

export interface ResumeSandboxLeaseInput {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string;
}

export interface ReleaseSandboxLeaseInput {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string | null;
  status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
}

export interface DestroySandboxLeaseInput {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string | null;
}

export interface PrepareSandboxWorkspaceInput {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string | null;
  workspace: {
    localPath?: string;
    remotePath?: string;
    mode?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface SandboxExecuteInput {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string | null;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface SandboxLeaseHandle {
  providerLeaseId: string;
  metadata: Record<string, unknown>;
}

export interface PreparedSandboxWorkspace {
  remotePath?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SandboxExecuteResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SandboxProvider {
  readonly provider: SandboxEnvironmentProvider;
  validateConfig(config: SandboxEnvironmentConfig): Promise<SandboxProviderValidationResult>;
  probe(config: SandboxEnvironmentConfig): Promise<EnvironmentProbeResult>;
  acquireLease(input: AcquireSandboxLeaseInput): Promise<SandboxLeaseHandle>;
  resumeLease(input: ResumeSandboxLeaseInput): Promise<SandboxLeaseHandle | null>;
  releaseLease(input: ReleaseSandboxLeaseInput): Promise<void>;
  destroyLease(input: DestroySandboxLeaseInput): Promise<void>;
  matchesReusableLease(input: {
    config: SandboxEnvironmentConfig;
    lease: { providerLeaseId: string | null; metadata: Record<string, unknown> | null };
  }): boolean;
  configFromLeaseMetadata(metadata: Record<string, unknown>): SandboxEnvironmentConfig | null;
  prepareWorkspace?(input: PrepareSandboxWorkspaceInput): Promise<PreparedSandboxWorkspace>;
  execute?(input: SandboxExecuteInput): Promise<SandboxExecuteResult>;
}

function assertProviderConfig<T extends SandboxEnvironmentConfig>(
  provider: SandboxEnvironmentProvider,
  config: SandboxEnvironmentConfig,
): asserts config is T {
  if (config.provider !== provider) {
    throw new Error(`Sandbox provider "${provider}" received config for provider "${config.provider}".`);
  }
}

function buildFakeSandboxProbe(config: FakeSandboxEnvironmentConfig): EnvironmentProbeResult {
  return {
    ok: true,
    driver: "sandbox",
    summary: `Fake sandbox provider is ready for image ${config.image}.`,
    details: {
      provider: config.provider,
      image: config.image,
      reuseLease: config.reuseLease,
    },
  };
}

class FakeSandboxProvider implements SandboxProvider {
  readonly provider = "fake" as const;

  async validateConfig(config: SandboxEnvironmentConfig): Promise<SandboxProviderValidationResult> {
    assertProviderConfig<FakeSandboxEnvironmentConfig>(this.provider, config);
    return {
      ok: true,
      summary: `Fake sandbox provider config is valid for image ${config.image}.`,
      details: {
        provider: config.provider,
        image: config.image,
        reuseLease: config.reuseLease,
      },
    };
  }

  async probe(config: SandboxEnvironmentConfig): Promise<EnvironmentProbeResult> {
    assertProviderConfig<FakeSandboxEnvironmentConfig>(this.provider, config);
    return buildFakeSandboxProbe(config);
  }

  async acquireLease(input: AcquireSandboxLeaseInput): Promise<SandboxLeaseHandle> {
    assertProviderConfig<FakeSandboxEnvironmentConfig>(this.provider, input.config);
    const providerLeaseId = input.config.reuseLease
      ? `sandbox://fake/${input.environmentId}`
      : `sandbox://fake/${input.heartbeatRunId}/${randomUUID()}`;

    return {
      providerLeaseId,
      metadata: {
        provider: input.config.provider,
        image: input.config.image,
        reuseLease: input.config.reuseLease,
      },
    };
  }

  async resumeLease(input: ResumeSandboxLeaseInput): Promise<SandboxLeaseHandle | null> {
    assertProviderConfig<FakeSandboxEnvironmentConfig>(this.provider, input.config);
    return {
      providerLeaseId: input.providerLeaseId,
      metadata: {
        provider: input.config.provider,
        image: input.config.image,
        reuseLease: input.config.reuseLease,
        resumedLease: true,
      },
    };
  }

  async releaseLease(): Promise<void> {
    return;
  }

  async destroyLease(): Promise<void> {
    return;
  }

  matchesReusableLease(input: {
    config: SandboxEnvironmentConfig;
    lease: { providerLeaseId: string | null; metadata: Record<string, unknown> | null };
  }): boolean {
    assertProviderConfig<FakeSandboxEnvironmentConfig>(this.provider, input.config);
    return (
      typeof input.lease.providerLeaseId === "string" &&
      input.lease.providerLeaseId.length > 0 &&
      input.lease.metadata?.provider === input.config.provider &&
      input.lease.metadata?.reuseLease === true &&
      input.lease.metadata?.image === input.config.image
    );
  }

  configFromLeaseMetadata(metadata: Record<string, unknown>): SandboxEnvironmentConfig | null {
    if (metadata.provider !== this.provider || typeof metadata.image !== "string") {
      return null;
    }
    return {
      provider: this.provider,
      image: metadata.image,
      reuseLease: metadata.reuseLease === true,
    };
  }
}

// ---------------------------------------------------------------------------
// Provider registry — built-in providers only.
// Plugin-backed providers are resolved through the plugin environment driver
// system at the environment-runtime layer.
// ---------------------------------------------------------------------------

const registeredSandboxProviders = new Map<SandboxEnvironmentProvider, SandboxProvider>([
  ["fake", new FakeSandboxProvider()],
]);

/**
 * Returns a built-in sandbox provider, or null if the provider key is not
 * registered. Plugin-backed providers are not returned here — they are
 * resolved through the plugin worker manager at the environment-runtime level.
 */
export function getSandboxProvider(provider: string): SandboxProvider | null {
  return registeredSandboxProviders.get(provider as SandboxEnvironmentProvider) ?? null;
}

export function requireSandboxProvider(provider: string): SandboxProvider {
  const sandboxProvider = getSandboxProvider(provider);
  if (!sandboxProvider) {
    throw new Error(`Sandbox provider "${provider}" is not registered as a built-in provider.`);
  }
  return sandboxProvider;
}

/**
 * Returns true if the given provider key is handled by a built-in sandbox
 * provider (as opposed to a plugin-backed provider).
 */
export function isBuiltinSandboxProvider(provider: string): boolean {
  return registeredSandboxProviders.has(provider as SandboxEnvironmentProvider);
}

export function listSandboxProviders(): SandboxProvider[] {
  return [...registeredSandboxProviders.values()];
}

export async function validateSandboxProviderConfig(
  config: SandboxEnvironmentConfig,
): Promise<SandboxProviderValidationResult> {
  return await requireSandboxProvider(config.provider).validateConfig(config);
}

export function sandboxConfigFromLeaseMetadata(
  lease: Pick<{ metadata: Record<string, unknown> | null }, "metadata">,
): SandboxEnvironmentConfig | null {
  const metadata = lease.metadata ?? {};
  const provider = typeof metadata.provider === "string" ? getSandboxProvider(metadata.provider) : null;
  return provider?.configFromLeaseMetadata(metadata) ?? null;
}

/**
 * Reconstruct a sandbox environment config from lease metadata, including
 * plugin-backed providers. For plugin-backed providers, the
 * config is synthesized from lease metadata fields without requiring the
 * built-in provider to be registered.
 */
export function sandboxConfigFromLeaseMetadataLoose(
  lease: Pick<{ metadata: Record<string, unknown> | null }, "metadata">,
): SandboxEnvironmentConfig | null {
  const metadata = lease.metadata ?? {};
  const providerKey = typeof metadata.provider === "string" ? metadata.provider : null;
  if (!providerKey) return null;

  // Try built-in provider first.
  const builtinProvider = getSandboxProvider(providerKey);
  if (builtinProvider) {
    return builtinProvider.configFromLeaseMetadata(metadata);
  }

  return {
    ...metadata,
    provider: providerKey,
    reuseLease: metadata.reuseLease === true,
  } satisfies SandboxEnvironmentConfig;
}

export function findReusableSandboxProviderLeaseId(input: {
  config: SandboxEnvironmentConfig;
  leases: Array<{ providerLeaseId: string | null; metadata: Record<string, unknown> | null }>;
}): string | null {
  const provider = getSandboxProvider(input.config.provider);
  if (!provider) {
    for (const lease of input.leases) {
      const metadata = lease.metadata ?? {};
      if (
        typeof lease.providerLeaseId === "string" &&
        lease.providerLeaseId.length > 0 &&
        metadata.provider === input.config.provider &&
        metadataMatchesPluginSandboxConfig(input.config, metadata)
      ) {
        return lease.providerLeaseId;
      }
    }
    return null;
  }
  for (const lease of input.leases) {
    if (provider.matchesReusableLease({ config: input.config, lease })) {
      return lease.providerLeaseId;
    }
  }
  return null;
}

function metadataMatchesPluginSandboxConfig(
  config: SandboxEnvironmentConfig,
  metadata: Record<string, unknown>,
): boolean {
  if (metadata.reuseLease !== true) return false;
  for (const [key, value] of Object.entries(config)) {
    if (key === "provider" || key === "reuseLease") continue;
    if (value === undefined) continue;
    if (JSON.stringify(metadata[key]) !== JSON.stringify(value)) {
      return false;
    }
  }
  return true;
}

export async function probeSandboxProvider(
  config: SandboxEnvironmentConfig,
): Promise<EnvironmentProbeResult> {
  return await requireSandboxProvider(config.provider).probe(config);
}

export async function acquireSandboxProviderLease(input: {
  config: SandboxEnvironmentConfig;
  environmentId: string;
  heartbeatRunId: string;
  issueId: string | null;
  reusableProviderLeaseId?: string | null;
}): Promise<SandboxLeaseHandle> {
  const provider = requireSandboxProvider(input.config.provider);
  if (input.config.reuseLease && input.reusableProviderLeaseId) {
    const resumedLease = await provider.resumeLease({
      config: input.config,
      providerLeaseId: input.reusableProviderLeaseId,
    });
    if (resumedLease) {
      return resumedLease;
    }
  }

  return await provider.acquireLease({
    config: input.config,
    environmentId: input.environmentId,
    heartbeatRunId: input.heartbeatRunId,
    issueId: input.issueId,
  });
}

export async function resumeSandboxProviderLease(input: {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string;
}): Promise<SandboxLeaseHandle | null> {
  return await requireSandboxProvider(input.config.provider).resumeLease(input);
}

export async function releaseSandboxProviderLease(input: {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string | null;
  status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
}): Promise<void> {
  await requireSandboxProvider(input.config.provider).releaseLease(input);
}

export async function destroySandboxProviderLease(input: {
  config: SandboxEnvironmentConfig;
  providerLeaseId: string | null;
}): Promise<void> {
  await requireSandboxProvider(input.config.provider).destroyLease(input);
}
