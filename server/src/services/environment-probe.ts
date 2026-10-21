import type { Environment, EnvironmentProbeResult } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { ensureSshWorkspaceReady } from "@paperclipai/adapter-utils/ssh";
import {
  parseEnvironmentDriverConfig,
  resolveEnvironmentDriverConfigForRuntime,
  type ParsedEnvironmentConfig,
} from "./environment-config.js";
import os from "node:os";
import { isBuiltinSandboxProvider, probeSandboxProvider } from "./sandbox-provider-runtime.js";
import { probePluginEnvironmentDriver, probePluginSandboxProviderDriver } from "./plugin-environment-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { environmentService } from "./environments.js";
import { fingerprintEnvironmentSandboxProviderConfig, SANDBOX_PLATFORM_PROBE_METADATA_KEY } from "./environment-custom-image-runtime.js";
import type { SandboxEnvironmentConfig } from "@paperclipai/shared";
import { isQualifiableDaytonaSnapshot, qualifiedSandboxSnapshotId, readSnapshotIdentity, type SandboxTemplateIdentity } from "./sandbox-snapshot-qualification.js";

export const SANDBOX_PLATFORM_PROBE_COMMAND = "uname -s; uname -m; if version=$(getconf GNU_LIBC_VERSION 2>/dev/null) && [ -n \"$version\" ]; then printf 'glibc\\n%s\\n' \"$version\"; else case \"$(ldd --version 2>&1)\" in *musl*) printf 'musl\\n' ;; *) printf 'unknown\\n' ;; esac; fi";
type PlatformFacts = { platform: string; architecture: string; libc: "glibc" | "musl" | "unknown"; glibcVersion?: string };
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function fingerprint(config: Record<string, unknown>): string {
  return fingerprintEnvironmentSandboxProviderConfig(config as SandboxEnvironmentConfig);
}
function isImmutableImage(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(value);
}
export function parseSandboxPlatformFacts(output: string): PlatformFacts {
  const [os, arch, libc, version] = output.trim().split(/\r?\n/);
  return { platform: os === "Linux" ? "linux" : os === "Darwin" ? "darwin" : "unknown",
    architecture: arch === "x86_64" ? "x64" : arch === "aarch64" || arch === "arm64" ? "arm64" : "unknown",
    libc: libc === "glibc" || libc === "musl" ? libc : "unknown",
    ...(libc === "glibc" ? { glibcVersion: version?.trim() ?? "unknown" } : {}) };
}
async function sandboxBinding(db: Db, environment: Environment, companyId: string) {
  const selectedTemplate: { value: SandboxTemplateIdentity } = { value: null };
  const parsed = await resolveEnvironmentDriverConfigForRuntime(db, companyId, environment, {
    applyCustomImageTemplate: true, readOnlyCustomImageTemplate: true,
    onResolvedCustomImageTemplate: identity => { selectedTemplate.value = identity; },
  });
  if (parsed.driver !== "sandbox") return null;
  const image = parsed.config.image;
  const template = selectedTemplate.value;
  if (isQualifiableDaytonaSnapshot(parsed.config, template)) {
    return { baseConfigFingerprint: fingerprint(environment.config), runtimeConfigFingerprint: fingerprint(parsed.config),
      snapshot: parsed.config.snapshot, template, qualifiedSnapshotId: qualifiedSandboxSnapshotId(environment, companyId, parsed.config, template) };
  }
  if (!isImmutableImage(image) || ["snapshot", "template", "templateRef"].some(key => record(parsed.config)[key])
    || (template && (template.templateKind !== "image" || template.bindingField !== "image"))) return null;
  return { baseConfigFingerprint: fingerprint(environment.config), runtimeConfigFingerprint: fingerprint(parsed.config as unknown as Record<string, unknown>), image, template };
}

export async function readSandboxPlatformQualification(db: Db, environment: Environment, companyId: string): Promise<PlatformFacts | null> {
  const proof = record(record(environment.metadata?.[SANDBOX_PLATFORM_PROBE_METADATA_KEY])[companyId]);
  if (![1, 2].includes(Number(proof.v)) || proof.companyId !== companyId || proof.baseConfigFingerprint !== fingerprint(environment.config)) return null;
  const binding = await sandboxBinding(db, environment, companyId);
  if (!binding || (proof.v === 2 ? !("qualifiedSnapshotId" in binding && binding.qualifiedSnapshotId)
    : !("image" in binding) || proof.image !== binding.image)
    || proof.runtimeConfigFingerprint !== binding.runtimeConfigFingerprint
    || JSON.stringify(proof.template) !== JSON.stringify(binding.template)) return null;
  const facts = record(proof.facts);
  if (typeof facts.platform !== "string" || typeof facts.architecture !== "string"
    || !["glibc", "musl", "unknown"].includes(String(facts.libc))) return null;
  return { platform: facts.platform, architecture: facts.architecture, libc: facts.libc as PlatformFacts["libc"],
    ...(typeof facts.glibcVersion === "string" ? { glibcVersion: facts.glibcVersion } : {}) };
}

export async function probeEnvironment(
  db: Db,
  environment: Environment,
  options: {
    companyId?: string | null;
    pluginWorkerManager?: PluginWorkerManager;
    resolvedConfig?: ParsedEnvironmentConfig;
    applyCustomImageTemplate?: boolean;
    acquireSandboxRuntimeLease?: boolean;
  } = {},
): Promise<EnvironmentProbeResult> {
  const resolvedCompanyId = options.companyId ?? null;
  const savedSandboxProbe = environment.driver === "sandbox" && options.acquireSandboxRuntimeLease === true && resolvedCompanyId;
  const environments = environmentService(db);
  if (savedSandboxProbe) await environments.recordSandboxPlatformProbe({ environmentId: environment.id,
    companyId: savedSandboxProbe, config: environment.config, proof: null });
  const parsed = options.resolvedConfig ?? (
    options.acquireSandboxRuntimeLease === true
      ? parseEnvironmentDriverConfig(environment)
      : resolvedCompanyId || options.applyCustomImageTemplate === true
      ? await resolveEnvironmentDriverConfigForRuntime(db, resolvedCompanyId, environment, {
          applyCustomImageTemplate: options.applyCustomImageTemplate === true,
        })
      : parseEnvironmentDriverConfig(environment)
  );

  if (parsed.driver === "local") {
    return {
      ok: true,
      driver: "local",
      summary: "Local environment is available on this Paperclip host.",
      details: {
        hostname: os.hostname(),
        cwd: process.cwd(),
      },
    };
  }

  if (parsed.driver === "sandbox") {
    if (options.acquireSandboxRuntimeLease) {
      if (!resolvedCompanyId) {
        return {
          ok: false,
          driver: "sandbox",
          summary: "Sandbox environment probe requires a companyId context.",
          details: {
            provider: parsed.config.provider,
          },
        };
      }

      const runtime = environmentRuntimeService(db, {
        pluginWorkerManager: options.pluginWorkerManager,
      });
      const probeEnvironmentConfig = {
        ...environment,
        config: {
          ...(environment.config ?? {}),
          // Test probes should prove a fresh provider boot, not resume a retained
          // agent lease and report success without provider-side activity.
          reuseLease: false,
          // Keep the probe sandbox inspectable in the provider dashboard
          // (archived, provider-side expiry) instead of deleting it the moment
          // the probe finishes.
          archiveOnRelease: true,
        },
      };
      let leaseRecord: Awaited<ReturnType<typeof runtime.acquireRunLease>> | null = null;
      let releaseStatus: "released" | "failed" = "released";
      let qualification: Record<string, unknown> | null = null;
      let details: Record<string, unknown> | null = null;
      try {
        leaseRecord = await runtime.acquireRunLease({
          companyId: resolvedCompanyId,
          environment: probeEnvironmentConfig,
          issueId: null,
          agentId: null,
          heartbeatRunId: null,
          persistedExecutionWorkspace: null,
          adapterType: null,
          resolveSnapshotIdentity: true,
          applyCustomImageTemplate: options.applyCustomImageTemplate === true,
        });
        const metadata = leaseRecord.lease.metadata ?? {};
        const provider = leaseRecord.lease.provider ?? parsed.config.provider;
        const sandboxName = typeof metadata.sandboxName === "string" && metadata.sandboxName.trim().length > 0
          ? metadata.sandboxName.trim()
          : null;
        details = { provider, providerLeaseId: leaseRecord.lease.providerLeaseId, leaseId: leaseRecord.lease.id,
          leasePolicy: leaseRecord.lease.leasePolicy, metadata, platformQualificationRecorded: false,
          platformQualificationDiagnostic: "Platform qualification requires an immutable OCI image or a Daytona snapshot with a verified provider ID. Update the provider plugin and probe again, or select Legacy runner." };
        if ((isImmutableImage(metadata.image) && !metadata.snapshot) || metadata.snapshotIdentity) {
          try {
            const binding = await sandboxBinding(db, environment, resolvedCompanyId);
            const snapshotIdentity = binding && "snapshot" in binding ? readSnapshotIdentity(metadata.snapshotIdentity, binding.snapshot) : null;
            if (binding && (("image" in binding && metadata.image === binding.image && !metadata.snapshot)
              || (snapshotIdentity && metadata.snapshot === binding.snapshot && provider === "daytona"))) {
              const platform = await runtime.execute({ environment: probeEnvironmentConfig, lease: leaseRecord.lease,
                command: "sh", args: ["-c", SANDBOX_PLATFORM_PROBE_COMMAND],
                bypassSession: true, timeoutMs: 10_000, commandTimeoutMs: 10_000 });
              if (platform.exitCode !== 0) throw new Error("platform_probe_failed");
              const facts = parseSandboxPlatformFacts(platform.stdout);
              details.platform = facts;
              if (facts.platform !== "unknown" && facts.architecture !== "unknown"
                && (facts.platform !== "linux" || facts.libc !== "unknown")
                && (facts.libc !== "glibc" || /^(?:glibc\s+)?\d+\.\d+(?:\.\d+)?$/.test(facts.glibcVersion ?? ""))) {
                const { qualifiedSnapshotId: _qualifiedSnapshotId, ...recordedBinding } = { qualifiedSnapshotId: null, ...binding };
                qualification = { v: snapshotIdentity ? 2 : 1, companyId: resolvedCompanyId, ...recordedBinding,
                  ...(snapshotIdentity ? { snapshotIdentity } : {}), facts, probedAt: new Date().toISOString() };
                delete details.platformQualificationDiagnostic;
              } else details.platformQualificationDiagnostic = "The sandbox OS, architecture or libc could not be identified. Legacy remains the creation default.";
            } else details.platformQualificationDiagnostic = "The live lease does not match the selected image or snapshot identity. Probe again.";
          } catch {
            details.platformQualificationDiagnostic = "Platform qualification could not complete; connection readiness does not establish native compatibility. Check the image and probe again.";
          }
        }
        return {
          ok: true,
          driver: "sandbox",
          summary: sandboxName
            ? `Connected to ${provider} sandbox ${sandboxName}.`
            : `Connected to ${provider} sandbox environment.`,
          details,
        };
      } catch (error) {
        releaseStatus = "failed";
        return {
          ok: false,
          driver: "sandbox",
          summary: `Sandbox environment probe failed for provider "${parsed.config.provider}".`,
          details: {
            provider: parsed.config.provider,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      } finally {
        if (leaseRecord) {
          const driver = runtime.getDriver(environment.driver);
          try {
            const releasedLease = await driver?.releaseRunLease({
              environment: probeEnvironmentConfig,
              lease: leaseRecord.lease,
              status: releaseStatus,
            });
            if (qualification && driver && savedSandboxProbe
              && releasedLease?.id === leaseRecord.lease.id
              && releasedLease.companyId === resolvedCompanyId
              && releasedLease.environmentId === environment.id
              && releasedLease.status === "released" && releasedLease.cleanupStatus === "success") {
              const recorded = await environments.recordSandboxPlatformProbe({ environmentId: environment.id, companyId: savedSandboxProbe,
                config: environment.config, proof: qualification });
              if (details) {
                details.platformQualificationRecorded = recorded;
                if (!recorded) details.platformQualificationDiagnostic = "The environment changed during the probe. Probe its current configuration again.";
              }
            } else if (qualification && details) {
              details.platformQualificationDiagnostic = "The probe lease cleanup could not be verified. Resolve pending cleanup and probe again.";
            }
          } catch (releaseError) {
            // Cleanup failures must not mask the connection result shown to
            // the operator, but a leaked sandbox should still be traceable.
            // eslint-disable-next-line no-console
            console.warn(
              `[environment-probe] Failed to release lease ${leaseRecord.lease.id} for provider "${parsed.config.provider}": ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
            );
          }
        }
      }
    }

    if (!isBuiltinSandboxProvider(parsed.config.provider)) {
      if (!options.pluginWorkerManager) {
        return {
          ok: false,
          driver: "sandbox",
          summary: `Sandbox provider "${parsed.config.provider}" requires a running provider plugin.`,
          details: {
            provider: parsed.config.provider,
          },
        };
      }
      return await probePluginSandboxProviderDriver({
        db,
        workerManager: options.pluginWorkerManager,
        companyId: resolvedCompanyId ?? "instance",
        environmentId: environment.id,
        provider: parsed.config.provider,
        config: parsed.config as unknown as Record<string, unknown>,
      });
    }
    return await probeSandboxProvider(parsed.config);
  }

  if (parsed.driver === "plugin") {
    if (!options.pluginWorkerManager) {
      return {
        ok: false,
        driver: "plugin",
        summary: `Plugin environment probes require a plugin worker manager for "${parsed.config.pluginKey}:${parsed.config.driverKey}".`,
        details: {
          pluginKey: parsed.config.pluginKey,
          driverKey: parsed.config.driverKey,
        },
      };
    }
    return await probePluginEnvironmentDriver({
      db,
      workerManager: options.pluginWorkerManager,
      companyId: resolvedCompanyId ?? "instance",
      environmentId: environment.id,
      config: parsed.config,
    });
  }

  try {
    const { remoteCwd } = await ensureSshWorkspaceReady(parsed.config);

    return {
      ok: true,
      driver: "ssh",
      summary: `Connected to ${parsed.config.username}@${parsed.config.host} and verified the remote workspace path.`,
      details: {
        host: parsed.config.host,
        port: parsed.config.port,
        username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath,
        remoteCwd,
      },
    };
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    const stdout =
      error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string"
        ? error.stdout.trim()
        : "";
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : null;
    const message =
      stderr ||
      stdout ||
      (error instanceof Error ? error.message : String(error)) ||
      "SSH probe failed.";

    return {
      ok: false,
      driver: "ssh",
      summary: `SSH probe failed for ${parsed.config.username}@${parsed.config.host}.`,
      details: {
        host: parsed.config.host,
        port: parsed.config.port,
        username: parsed.config.username,
        remoteWorkspacePath: parsed.config.remoteWorkspacePath,
        error: message,
        code,
      },
    };
  }
}
