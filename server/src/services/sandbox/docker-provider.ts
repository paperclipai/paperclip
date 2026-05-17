/**
 * Phase 4A-1 (LET-310) / Phase 4A-S6 (LET-352): DockerSandboxProvider
 * scaffold.
 *
 * Backend-only, default-off, mocked — preview / stub. This provider
 * records intended boundary metadata (capabilities, quotas, network
 * policy, policy hash) onto the lease but performs NO real Docker
 * run/build/pull/start/stop. Real container isolation has not shipped
 * yet — see ADR LET-328 for the buy-vs-build decision driving this stub
 * state. The recorded capability/quota/network values describe what a
 * future real provider *would* enforce.
 *
 * Capability defaults match the LET-307 boundary model:
 *   - rootless user namespace
 *   - drop all linux capabilities
 *   - seccomp default profile
 *   - read-only root filesystem
 *   - cgroups-v2 with quota ceilings
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  EnvironmentLeaseStatus,
  EnvironmentProbeResult,
  PluginSandboxEnvironmentConfig,
  SandboxEnvironmentConfig,
} from "@paperclipai/shared";
import { redactLearningEvidence } from "@paperclipai/shared";
import {
  DEFAULT_SANDBOX_NETWORK_POLICY,
  networkPolicyToMetadata,
  parseSandboxNetworkPolicy,
  type SandboxNetworkPolicy,
} from "./network-policy.js";
import {
  DEFAULT_SANDBOX_QUOTA_CEILINGS,
  parseSandboxQuotas,
  sandboxQuotasToMetadata,
  type SandboxQuotaCeilings,
} from "./quotas.js";
import type {
  AcquireSandboxLeaseInput,
  DestroySandboxLeaseInput,
  PrepareSandboxWorkspaceInput,
  PreparedSandboxWorkspace,
  ReleaseSandboxLeaseInput,
  ResumeSandboxLeaseInput,
  SandboxExecuteInput,
  SandboxExecuteResult,
  SandboxLeaseHandle,
  SandboxProvider,
  SandboxProviderValidationResult,
} from "../sandbox-provider-runtime.js";

export const DOCKER_SANDBOX_PROVIDER_KEY = "docker" as const;

export const DOCKER_SANDBOX_DEFAULT_FLAG = false;

export interface DockerSandboxCapabilityDefaults {
  rootless: boolean;
  dropAllCapabilities: boolean;
  seccompProfile: "default" | "unconfined";
  readOnlyRootfs: boolean;
  noNewPrivileges: boolean;
  cgroupsVersion: "v1" | "v2";
}

export const DEFAULT_DOCKER_SANDBOX_CAPABILITIES: DockerSandboxCapabilityDefaults = Object.freeze({
  rootless: true,
  dropAllCapabilities: true,
  seccompProfile: "default",
  readOnlyRootfs: true,
  noNewPrivileges: true,
  cgroupsVersion: "v2",
});

export interface DockerSandboxConfig extends PluginSandboxEnvironmentConfig {
  provider: typeof DOCKER_SANDBOX_PROVIDER_KEY;
  image: string;
  reuseLease: boolean;
  capabilities?: Partial<DockerSandboxCapabilityDefaults>;
  quotas?: Parameters<typeof parseSandboxQuotas>[0];
  network?: unknown;
}

function isDockerConfig(config: SandboxEnvironmentConfig): config is DockerSandboxConfig {
  return config.provider === DOCKER_SANDBOX_PROVIDER_KEY;
}

function assertDockerConfig(config: SandboxEnvironmentConfig): asserts config is DockerSandboxConfig {
  if (!isDockerConfig(config)) {
    throw new Error(`Docker sandbox provider received config for provider "${config.provider}".`);
  }
}

function isDockerSandboxEnabled(): boolean {
  const flag = process.env.PAPERCLIP_DOCKER_SANDBOX_ENABLED;
  if (!flag) return DOCKER_SANDBOX_DEFAULT_FLAG;
  return flag === "1" || flag.toLowerCase() === "true";
}

function mergeCapabilities(
  overrides: Partial<DockerSandboxCapabilityDefaults> | undefined,
): DockerSandboxCapabilityDefaults {
  if (!overrides) return DEFAULT_DOCKER_SANDBOX_CAPABILITIES;
  return {
    ...DEFAULT_DOCKER_SANDBOX_CAPABILITIES,
    ...overrides,
  };
}

export interface DockerSandboxPolicySnapshot {
  capabilities: DockerSandboxCapabilityDefaults;
  quotas: SandboxQuotaCeilings;
  network: SandboxNetworkPolicy;
  image: string;
}

export function hashDockerSandboxPolicy(snapshot: DockerSandboxPolicySnapshot): string {
  const canonical = JSON.stringify({
    image: snapshot.image,
    capabilities: snapshot.capabilities,
    quotas: snapshot.quotas,
    network: networkPolicyToMetadata(snapshot.network),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function resolvePolicySnapshot(config: DockerSandboxConfig): DockerSandboxPolicySnapshot {
  return {
    image: config.image,
    capabilities: mergeCapabilities(config.capabilities),
    quotas: config.quotas
      ? parseSandboxQuotas(config.quotas)
      : DEFAULT_SANDBOX_QUOTA_CEILINGS,
    network: config.network === undefined
      ? DEFAULT_SANDBOX_NETWORK_POLICY
      : parseSandboxNetworkPolicy(config.network),
  };
}

/**
 * Records intended audit metadata that future container-start code paths
 * MUST call before any docker invocation. Exported separately so a test
 * can assert the redaction-before-start ordering invariant without
 * needing the rest of the boundary stack.
 */
export function buildDockerSandboxStartAudit(input: {
  providerLeaseId: string;
  policy: DockerSandboxPolicySnapshot;
  message: string;
}): { providerLeaseId: string; policyHash: string; message: string } {
  return {
    providerLeaseId: input.providerLeaseId,
    policyHash: hashDockerSandboxPolicy(input.policy),
    message: redactLearningEvidence(input.message),
  };
}

class DockerSandboxNotEnabledError extends Error {
  readonly code = "DOCKER_SANDBOX_NOT_ENABLED";
  constructor() {
    super(
      "Docker sandbox provider is scaffolded but not enabled. Set PAPERCLIP_DOCKER_SANDBOX_ENABLED=1 once the runtime is ready.",
    );
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly provider = DOCKER_SANDBOX_PROVIDER_KEY;

  async validateConfig(config: SandboxEnvironmentConfig): Promise<SandboxProviderValidationResult> {
    assertDockerConfig(config);
    if (typeof config.image !== "string" || config.image.trim().length === 0) {
      return { ok: false, summary: "Docker sandbox config is missing 'image'." };
    }
    let snapshot: DockerSandboxPolicySnapshot;
    try {
      snapshot = resolvePolicySnapshot(config);
    } catch (error) {
      return {
        ok: false,
        summary: `Docker sandbox config rejected: ${(error as Error).message}`,
      };
    }
    return {
      ok: true,
      summary: `Docker sandbox provider scaffold accepted config for image ${config.image} (enabled=${isDockerSandboxEnabled()}).`,
      details: {
        provider: this.provider,
        image: config.image,
        enabled: isDockerSandboxEnabled(),
        capabilities: snapshot.capabilities,
        quotas: sandboxQuotasToMetadata(snapshot.quotas),
        network: networkPolicyToMetadata(snapshot.network),
        policyHash: hashDockerSandboxPolicy(snapshot),
      },
    };
  }

  async probe(config: SandboxEnvironmentConfig): Promise<EnvironmentProbeResult> {
    assertDockerConfig(config);
    const enabled = isDockerSandboxEnabled();
    return {
      ok: enabled,
      driver: "sandbox",
      summary: enabled
        ? `Docker sandbox provider is enabled in scaffold mode for image ${config.image}.`
        : "Docker sandbox provider is scaffolded but disabled by default.",
      details: {
        provider: this.provider,
        enabled,
        image: config.image,
      },
    };
  }

  async acquireLease(input: AcquireSandboxLeaseInput): Promise<SandboxLeaseHandle> {
    assertDockerConfig(input.config);
    if (!isDockerSandboxEnabled()) {
      throw new DockerSandboxNotEnabledError();
    }
    const snapshot = resolvePolicySnapshot(input.config);
    const providerLeaseId = `sandbox://docker/${input.environmentId}/${randomUUID()}`;
    return {
      providerLeaseId,
      metadata: {
        provider: this.provider,
        image: snapshot.image,
        reuseLease: input.config.reuseLease,
        sandboxState: "requested",
        kind: "docker",
        capabilities: snapshot.capabilities,
        quotas: sandboxQuotasToMetadata(snapshot.quotas),
        network: networkPolicyToMetadata(snapshot.network),
        policyHash: hashDockerSandboxPolicy(snapshot),
      },
    };
  }

  async resumeLease(input: ResumeSandboxLeaseInput): Promise<SandboxLeaseHandle | null> {
    assertDockerConfig(input.config);
    if (!isDockerSandboxEnabled()) return null;
    const snapshot = resolvePolicySnapshot(input.config);
    return {
      providerLeaseId: input.providerLeaseId,
      metadata: {
        provider: this.provider,
        image: snapshot.image,
        reuseLease: input.config.reuseLease,
        sandboxState: "running",
        resumedLease: true,
        kind: "docker",
        policyHash: hashDockerSandboxPolicy(snapshot),
      },
    };
  }

  async releaseLease(_input: ReleaseSandboxLeaseInput): Promise<void> {
    // Scaffold: no real Docker call. Cleanup hooks are wired in a later child.
    return;
  }

  async destroyLease(_input: DestroySandboxLeaseInput): Promise<void> {
    // Scaffold: no destructive host action.
    return;
  }

  matchesReusableLease(input: {
    config: SandboxEnvironmentConfig;
    lease: { providerLeaseId: string | null; metadata: Record<string, unknown> | null };
  }): boolean {
    assertDockerConfig(input.config);
    const meta = input.lease.metadata ?? {};
    return (
      typeof input.lease.providerLeaseId === "string" &&
      input.lease.providerLeaseId.length > 0 &&
      meta.provider === this.provider &&
      meta.reuseLease === true &&
      meta.image === input.config.image
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
    } satisfies DockerSandboxConfig;
  }

  async prepareWorkspace(_input: PrepareSandboxWorkspaceInput): Promise<PreparedSandboxWorkspace> {
    return { remotePath: null, metadata: { provider: this.provider, scaffold: true } };
  }

  async execute(_input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
    throw new DockerSandboxNotEnabledError();
  }
}

export type DockerSandboxReleaseStatus = Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;

export const __testing = {
  DockerSandboxNotEnabledError,
  isDockerSandboxEnabled,
  resolvePolicySnapshot,
};
