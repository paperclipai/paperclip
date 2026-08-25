import fs from "node:fs/promises";
import type { PaperclipConfig } from "../config/schema.js";
import { resolvePaperclipInstanceId } from "../config/home.js";
import { readInstallManifest } from "../install-store.js";
import {
  detectServiceManager,
  resolveServiceShimPath,
  type ServiceManagerDetection,
} from "../services/service-manager.js";
import { buildLocalHealthUrl } from "../utils/health-url.js";
import type { CheckResult } from "./index.js";

type HealthResult = { ok: boolean; version: string | null; error?: string };
type ServiceCheckDependencies = {
  detect: (instanceId: string) => Promise<ServiceManagerDetection>;
  probe: (config: PaperclipConfig) => Promise<HealthResult>;
  shimPresent: () => Promise<boolean>;
};

async function probeHealth(config: PaperclipConfig): Promise<HealthResult> {
  try {
    const response = await fetch(buildLocalHealthUrl(config.server.host, config.server.port), {
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await response.json()) as {
      status?: unknown;
      serverVersion?: unknown;
      version?: unknown;
    };
    const version = typeof body.serverVersion === "string"
      ? body.serverVersion
      : typeof body.version === "string"
        ? body.version
        : null;
    return { ok: response.ok && body.status === "ok", version };
  } catch (error) {
    return { ok: false, version: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function serviceHealthChecks(
  config: PaperclipConfig,
  dependencies: Partial<ServiceCheckDependencies> = {},
): Promise<CheckResult[]> {
  if (process.env.PAPERCLIP_SERVICE_MANAGED === "1") return [];

  const deps: ServiceCheckDependencies = {
    detect: (instanceId) => detectServiceManager({ instanceId }),
    probe: probeHealth,
    shimPresent: async () => {
      try {
        await fs.access(resolveServiceShimPath());
        return true;
      } catch {
        return false;
      }
    },
    ...dependencies,
  };
  const instanceId = resolvePaperclipInstanceId();
  const detection = await deps.detect(instanceId);
  if (!detection.supported) {
    return [{ name: "Background service", status: "pass", message: detection.reason }];
  }

  const manager = detection.manager;
  const status = await manager.status();
  if (!status.installed) {
    return [
      {
        name: "Background service",
        status: "pass",
        message: `Not installed for instance ${instanceId} (optional)`,
      },
    ];
  }

  const results: CheckResult[] = [];
  let definitionCurrent = false;
  try {
    definitionCurrent = (await fs.readFile(manager.definitionPath, "utf8")) === manager.renderDefinition();
  } catch {
    definitionCurrent = false;
  }
  results.push(
    definitionCurrent
      ? { name: "Service definition", status: "pass", message: manager.definitionPath }
      : {
          name: "Service definition",
          status: "fail",
          message: `Missing or drifted definition at ${manager.definitionPath}`,
          repairHint: "Run `paperclipai service install` to regenerate the service definition",
        },
  );

  const health = await deps.probe(config);
  const shimPresent = status.active ? true : await deps.shimPresent();
  results.push(
    status.active
      ? { name: "Service runtime", status: "pass", message: `${status.serviceName} is active` }
      : !shimPresent
        ? {
            name: "Service runtime",
            status: "fail",
            message: `${status.serviceName} cannot start: its binary is missing at ${resolveServiceShimPath()}`,
            repairHint: "Run `paperclipai install` to restore the managed payload and shim, then `paperclipai service start`",
          }
        : health.ok
          ? {
              name: "Service runtime",
              status: "fail",
              message: `${status.serviceName} is inactive but the configured port is serving another Paperclip process`,
              repairHint: "Run `paperclipai service start`, or stop the conflicting foreground process first",
            }
          : {
              name: "Service runtime",
              status: "fail",
              message: `${status.serviceName} is ${status.detail ?? "inactive"}`,
              repairHint: "Run `paperclipai service start`; inspect `paperclipai service logs` if it does not stay up",
            },
  );

  let expectedVersion: string | null = null;
  try {
    expectedVersion = readInstallManifest()?.version ?? null;
  } catch {}
  results.push(
    !health.ok
      ? {
          name: "Service health",
          status: "fail",
          message: health.error ?? "Health endpoint did not report ok",
          repairHint: "Inspect `paperclipai service status` and `paperclipai service logs`",
        }
      : expectedVersion && health.version !== expectedVersion
        ? {
            name: "Service version",
            status: "fail",
            message: `Running ${health.version ?? "unknown"}; managed install is ${expectedVersion}`,
            repairHint: "Run `paperclipai service restart --expected-version " + expectedVersion + "`",
          }
        : status.active
          ? {
              name: "Service health",
              status: "pass",
              message: `Healthy${health.version ? ` at version ${health.version}` : ""}`,
            }
          : {
              name: "Service health",
              status: "warn",
              message: `The configured port answers healthy${health.version ? ` (version ${health.version})` : ""}, but not from ${status.serviceName} — the service is inactive`,
            },
  );

  if (status.enabled && status.linger === false) {
    results.push({
      name: "Service linger",
      status: "warn",
      message: "Start-on-login is enabled but systemd user lingering is off",
      repairHint: "Re-run `paperclipai service install --enable-linger` if the service must survive logout",
    });
  }

  return results;
}
