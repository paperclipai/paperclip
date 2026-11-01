import { definePlugin } from "@paperclipai/plugin-sdk";
import {
  openshellProviderConfigSchema,
  type OpenShellProviderConfig,
  type OpenShellLeaseMetadata,
} from "./types.js";
import {
  getClient,
  healthCheck,
  createSandbox,
  getSandbox,
  waitForReady,
  execSandbox,
  deleteSandbox,
} from "./openshell-grpc-client.js";

const READY_TIMEOUT_MS = 120_000;
const RESUME_READY_TIMEOUT_MS = 30_000;

const DEFAULT_SANDBOX_POLICY = {
  version: 1,
  filesystem: {
    includeWorkdir: true,
    readWrite: ["/workspace", "/tmp", "/home"],
  },
  networkPolicies: {
    allow_model_apis: {
      name: "allow_model_apis",
      endpoints: [
        {
          host: "api.anthropic.com",
          port: 443,
          protocol: "tcp",
          tls: "tls",
          access: "allow",
        },
        {
          host: "api.openai.com",
          port: 443,
          protocol: "tcp",
          tls: "tls",
          access: "allow",
        },
        {
          host: "generativelanguage.googleapis.com",
          port: 443,
          protocol: "tcp",
          tls: "tls",
          access: "allow",
        },
      ],
    },
  },
};

function newSandboxName(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `pc-${ts}-${rand}`;
}

function parseConfig(
  raw: Record<string, unknown>
): OpenShellProviderConfig | null {
  const result = openshellProviderConfigSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function buildClient(config: OpenShellProviderConfig) {
  return getClient(config.gatewayEndpoint, {
    useTls: config.useTls,
    caCert: config.caCert,
  });
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function wrapCommandWithEnv(
  command: string[],
  env?: Record<string, string>
): string[] {
  if (!env || Object.keys(env).length === 0) return command;

  const exports = Object.entries(env)
    .filter(([k]) => ENV_KEY_RE.test(k))
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("; ");

  if (!exports) return command;

  return ["/bin/sh", "-lc", `${exports}; exec ${command.map(shellQuote).join(" ")}`];
}

/**
 * POSIX single-quote escaping. Each embedded single quote is replaced with
 * the sequence '\'' which closes the current quoted region, appends a
 * backslash-escaped literal single quote, and reopens a new quoted region.
 * This is the same pattern used by the K8s provider (pod-exec.ts shQuote).
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("OpenShell sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok" as const, message: "OpenShell sandbox provider ready" };
  },

  async onEnvironmentValidateConfig(params) {
    const result = openshellProviderConfigSchema.safeParse(params.config);

    if (!result.success) {
      return {
        ok: false,
        errors: result.error.issues.map(
          (i) => `${i.path.join(".")}: ${i.message}`
        ),
      };
    }

    if (!result.data.useTls && !result.data.allowInsecure) {
      return {
        ok: false,
        errors: [
          "useTls is false but allowInsecure is not set. " +
            "Plaintext gRPC carries sandbox lifecycle and command streams. " +
            "Set allowInsecure=true to acknowledge the risk for trusted in-cluster networks, " +
            "or set useTls=true (default) for production.",
        ],
      };
    }

    const warnings: string[] = [];
    if (!result.data.useTls) {
      warnings.push(
        "gRPC connection uses plaintext (insecure). " +
          "Ensure the gateway is only reachable from trusted networks."
      );
    }

    return {
      ok: true,
      normalizedConfig: result.data as unknown as Record<string, unknown>,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async onEnvironmentProbe(params) {
    const config = parseConfig(params.config);
    if (!config) {
      return {
        ok: false,
        summary: "Invalid provider config",
        diagnostics: [
          {
            severity: "error" as const,
            message: "Config validation failed; check gatewayEndpoint.",
          },
        ],
      };
    }

    try {
      const client = buildClient(config);
      const result = await healthCheck(client);

      if (result.ok) {
        return {
          ok: true,
          summary: `OpenShell gateway at ${config.gatewayEndpoint} is healthy (version: ${result.version || "unknown"})`,
          metadata: {
            provider: "openshell",
            version: result.version,
            endpoint: config.gatewayEndpoint,
          },
        };
      }

      return {
        ok: false,
        summary: `OpenShell gateway at ${config.gatewayEndpoint} is not healthy`,
        diagnostics: [
          {
            severity: "error" as const,
            message: "Health check returned unhealthy status.",
          },
        ],
      };
    } catch (err: any) {
      return {
        ok: false,
        summary: `Cannot reach OpenShell gateway at ${config.gatewayEndpoint}`,
        diagnostics: [
          {
            severity: "error" as const,
            message: `Connection failed: ${err.message}`,
          },
        ],
      };
    }
  },

  async onEnvironmentAcquireLease(params) {
    const config = parseConfig(params.config);
    if (!config) throw new Error("Invalid OpenShell provider config");

    const client = buildClient(config);
    const sandboxName = newSandboxName();
    const image = config.sandboxImage;
    const policy = config.defaultPolicy ?? DEFAULT_SANDBOX_POLICY;

    const environment: Record<string, string> = {
      PAPERCLIP_RUN_ID: params.runId,
    };
    if (params.agentId) environment.PAPERCLIP_AGENT_ID = params.agentId;

    const labels: Record<string, string> = {
      "paperclip.ai/run-id": params.runId,
      ...config.labels,
    };
    if (params.agentId) labels["paperclip.ai/agent-id"] = params.agentId;
    if (params.companyId) labels["paperclip.ai/company-id"] = params.companyId;

    const sbInfo = await createSandbox(client, {
      name: sandboxName,
      image,
      environment,
      labels,
      policy,
      gpu: config.gpu,
      gpuCount: config.gpuCount,
    });

    const readyInfo = await waitForReady(client, sandboxName, READY_TIMEOUT_MS);

    return {
      providerLeaseId: sandboxName,
      metadata: {
        sandboxName,
        sandboxId: readyInfo.id,
        endpoint: config.gatewayEndpoint,
        phase: readyInfo.phase,
        image,
      } satisfies OpenShellLeaseMetadata as unknown as Record<string, unknown>,
    };
  },

  async onEnvironmentResumeLease(params) {
    const config = parseConfig(params.config);
    if (!config) {
      return {
        providerLeaseId: null,
        metadata: { expired: true, reason: "Invalid config" },
      };
    }

    const client = buildClient(config);
    const name = params.providerLeaseId;

    try {
      const info = await getSandbox(client, name);
      if (!info || info.phase !== "SANDBOX_PHASE_READY") {
        return {
          providerLeaseId: null,
          metadata: {
            expired: true,
            reason: info
              ? `Sandbox phase is ${info.phase}, not READY`
              : "Sandbox not found",
          },
        };
      }

      return {
        providerLeaseId: name,
        metadata: {
          sandboxName: info.name,
          sandboxId: info.id,
          endpoint: config.gatewayEndpoint,
          phase: info.phase,
          image: (params.leaseMetadata as any)?.image || config.sandboxImage,
          resumedLease: true,
        },
      };
    } catch (err: any) {
      return {
        providerLeaseId: null,
        metadata: { expired: true, reason: `Resume check failed: ${err.message}` },
      };
    }
  },

  async onEnvironmentRealizeWorkspace(params) {
    const config = parseConfig(params.config);
    const cwd =
      params.workspace?.remotePath?.trim() ||
      config?.workspacePath ||
      "/workspace";

    return {
      cwd,
      metadata: { provider: "openshell", remoteCwd: cwd },
    };
  },

  async onEnvironmentExecute(params) {
    const config = parseConfig(params.config);
    if (!config) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Invalid OpenShell provider config",
        timedOut: false,
      };
    }

    const leaseMetadata = params.lease?.metadata as
      | OpenShellLeaseMetadata
      | undefined;
    const sandboxId = leaseMetadata?.sandboxId;

    if (!sandboxId) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "No sandbox ID in lease metadata — cannot execute. " +
          "providerLeaseId: " +
          (params.lease?.providerLeaseId || "none"),
        timedOut: false,
      };
    }

    const client = buildClient(config);

    let command: string[];
    if (params.args && params.args.length > 0) {
      command = [params.command, ...params.args];
    } else {
      command = ["/bin/sh", "-lc", params.command];
    }

    if (params.env && Object.keys(params.env).length > 0) {
      command = wrapCommandWithEnv(command, params.env);
    }

    const timeoutSecs = params.timeoutMs
      ? Math.ceil(params.timeoutMs / 1000)
      : config.timeoutSeconds;

    try {
      const result = await execSandbox(client, sandboxId, command, {
        timeoutSeconds: timeoutSecs,
        cwd: params.cwd,
        stdin: params.stdin,
      });

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        metadata: {
          provider: "openshell",
          sandboxId,
          sandboxName: leaseMetadata?.sandboxName,
        },
      };
    } catch (err: any) {
      return {
        exitCode: null,
        stdout: "",
        stderr: `ExecSandbox failed: ${err.message}`,
        timedOut: err.message?.includes("timeout") ?? false,
        metadata: { provider: "openshell", sandboxId, error: err.message },
      };
    }
  },

  async onEnvironmentReleaseLease(params) {
    if (!params.providerLeaseId) return;

    const config = parseConfig(params.config);
    if (!config) return;

    const client = buildClient(config);
    try {
      await deleteSandbox(client, params.providerLeaseId);
    } catch {
      // best-effort cleanup; swallow errors
    }
  },

  async onEnvironmentDestroyLease(params) {
    if (!params.providerLeaseId) return;

    const config = parseConfig(params.config);
    if (!config) return;

    const client = buildClient(config);
    try {
      await deleteSandbox(client, params.providerLeaseId);
    } catch {
      // force teardown — swallow all errors
    }
  },
});

export default plugin;
