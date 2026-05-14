import type { Environment, EnvironmentProbeResult } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { ensureSshWorkspaceReady } from "@paperclipai/adapter-utils/ssh";
import * as k8s from "@kubernetes/client-node";
import {
  resolveEnvironmentDriverConfigForRuntime,
  type ParsedEnvironmentConfig,
} from "./environment-config.js";
import os from "node:os";
import { isBuiltinSandboxProvider, probeSandboxProvider } from "./sandbox-provider-runtime.js";
import { probePluginEnvironmentDriver, probePluginSandboxProviderDriver } from "./plugin-environment-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { parseObject } from "../adapters/utils.js";
import { secretService } from "./secrets.js";

export async function probeEnvironment(
  db: Db,
  environment: Environment,
  options: { pluginWorkerManager?: PluginWorkerManager; resolvedConfig?: ParsedEnvironmentConfig } = {},
): Promise<EnvironmentProbeResult> {
  if (environment.driver === "k8s") {
    return await probeK8sEnvironment(db, environment);
  }

  const parsed = options.resolvedConfig ?? await resolveEnvironmentDriverConfigForRuntime(db, environment.companyId, environment);

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
        companyId: environment.companyId,
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
      companyId: environment.companyId,
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

const K8S_PROBE_TIMEOUT_MS = 10_000;

async function probeK8sEnvironment(
  db: Db,
  environment: Environment,
): Promise<EnvironmentProbeResult> {
  const config = parseObject(environment.config);
  const secretRef =
    typeof config.kubeconfigSecretRef === "string" && config.kubeconfigSecretRef.trim().length > 0
      ? config.kubeconfigSecretRef.trim()
      : null;
  const namespace = typeof config.namespace === "string" ? config.namespace : null;
  // Reflects the user's configured intent, not whether resolution succeeded —
  // a "kubeconfig-secret" probe that fails to load the secret should still
  // tell the user it tried the secret path.
  const authMode: "kubeconfig-secret" | "in-cluster" = secretRef ? "kubeconfig-secret" : "in-cluster";

  let kubeconfigYaml: string | null = null;
  if (secretRef) {
    try {
      kubeconfigYaml = await secretService(db).resolveSecretValue(
        environment.companyId,
        secretRef,
        "latest",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        driver: "k8s",
        summary: `k8s probe failed: could not resolve kubeconfig secret '${secretRef}'.`,
        details: {
          error: message,
          stage: "secret-resolution",
          secretRef,
          namespace,
          authMode,
        },
      };
    }
  }

  const kc = new k8s.KubeConfig();
  if (kubeconfigYaml) {
    try {
      kc.loadFromString(kubeconfigYaml);
    } catch {
      // Static error — never echo the YAML body, which could include cert/keys.
      return {
        ok: false,
        driver: "k8s",
        summary: "k8s probe failed: kubeconfig YAML failed to parse.",
        details: {
          error: "kubeconfig YAML failed to parse",
          stage: "kubeconfig-parse",
          secretRef,
          namespace,
          authMode,
        },
      };
    }
  } else {
    // Guard before loadFromCluster: outside a pod the SDK throws ENOENT on
    // /var/run/secrets/kubernetes.io/serviceaccount/ca.crt, which is opaque.
    // Mirrors the pattern in k8s-job-liveness.ts so the probe surfaces a
    // diagnostic the operator can act on.
    if (!process.env.KUBERNETES_SERVICE_HOST) {
      return {
        ok: false,
        driver: "k8s",
        summary: "k8s probe failed: Paperclip is not running in a Kubernetes pod (KUBERNETES_SERVICE_HOST is unset).",
        details: {
          error: "KUBERNETES_SERVICE_HOST is unset",
          stage: "in-cluster-load",
          namespace,
          authMode,
        },
      };
    }
    try {
      kc.loadFromCluster();
    } catch (error) {
      // KUBERNETES_SERVICE_HOST is set but the SA token isn't mounted —
      // typically Helm's serviceAccount.automountToken=false.
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        driver: "k8s",
        summary: "k8s probe failed: in-cluster auth not available (no service account token mounted — set serviceAccount.automountToken=true).",
        details: {
          error: message,
          stage: "in-cluster-load",
          namespace,
          authMode,
        },
      };
    }
  }

  try {
    const versionApi = kc.makeApiClient(k8s.VersionApi);
    const info = await raceWithTimeout(versionApi.getCode(), K8S_PROBE_TIMEOUT_MS);
    const gitVersion = typeof info?.gitVersion === "string" && info.gitVersion.length > 0
      ? info.gitVersion
      : "unknown";
    return {
      ok: true,
      driver: "k8s",
      summary: `Connected to Kubernetes cluster (${gitVersion}).`,
      details: {
        gitVersion,
        major: typeof info?.major === "string" ? info.major : null,
        minor: typeof info?.minor === "string" ? info.minor : null,
        namespace,
        authMode,
      },
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === "k8s probe timed out";
    const statusCode =
      error && typeof error === "object" && "statusCode" in error
        ? (error as { statusCode?: unknown }).statusCode ?? null
        : null;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      driver: "k8s",
      summary: isTimeout
        ? `k8s probe failed: timed out after ${K8S_PROBE_TIMEOUT_MS}ms.`
        : "k8s probe failed: unable to reach the Kubernetes API.",
      details: {
        error: message,
        stage: isTimeout ? "timeout" : "api-call",
        statusCode,
        namespace,
        authMode,
      },
    };
  }
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("k8s probe timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
