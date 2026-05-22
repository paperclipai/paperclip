import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginLogger,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import { CloudflareBridgeError, createCloudflareBridgeClient } from "./bridge-client.js";
import {
  parseCloudflareDriverConfig,
  validateCloudflareDriverConfig,
} from "./config.js";

const SANDBOX_EXEC_CHANNEL_ENV = "PAPERCLIP_SANDBOX_EXEC_CHANNEL";
const SANDBOX_EXEC_CHANNEL_BRIDGE = "bridge";
const CLOUDFLARE_EXEC_STDOUT_PREFIX = "[cloudflare exec stdout]";
const CLOUDFLARE_EXEC_STDERR_PREFIX = "[cloudflare exec stderr]";

function isLostLeaseError(error: unknown): boolean {
  return error instanceof CloudflareBridgeError && (error.status === 404 || error.status === 409);
}

function bridgeClientFor(rawConfig: Record<string, unknown>) {
  const config = parseCloudflareDriverConfig(rawConfig);
  return {
    config,
    client: createCloudflareBridgeClient({ config }),
  };
}

function lostLeaseExecuteResult(error: CloudflareBridgeError): PluginEnvironmentExecuteResult {
  return {
    exitCode: 1,
    timedOut: false,
    signal: null,
    stdout: "",
    stderr:
      error.message.trim().length > 0
        ? `${error.message}\n`
        : "Cloudflare sandbox lease is no longer available.\n",
  };
}

function readIssueId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveWorkspaceIssueId(params: PluginEnvironmentRealizeWorkspaceParams): string | null {
  const directIssueId = readIssueId(params.issueId);
  if (directIssueId) return directIssueId;

  const request = params.workspace.metadata?.workspaceRealizationRequest;
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  return readIssueId((request as { issueId?: unknown }).issueId);
}

function wrapWorkspacePreparationError(remoteCwd: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to prepare Cloudflare sandbox workspace at ${remoteCwd}: ${message}`);
}

function resolveRemoteCwd(
  config: ReturnType<typeof parseCloudflareDriverConfig>,
  params: PluginEnvironmentRealizeWorkspaceParams,
): string {
  const leaseRemoteCwd =
    typeof params.lease.metadata?.remoteCwd === "string" && params.lease.metadata.remoteCwd.trim().length > 0
      ? params.lease.metadata.remoteCwd.trim()
      : null;
  return leaseRemoteCwd ?? params.workspace.remotePath ?? params.workspace.localPath ?? config.requestedCwd;
}

function resolveExecuteSession(
  config: ReturnType<typeof parseCloudflareDriverConfig>,
  env: Record<string, string> | undefined,
) {
  if (env?.[SANDBOX_EXEC_CHANNEL_ENV] !== SANDBOX_EXEC_CHANNEL_BRIDGE) {
    return {
      sessionStrategy: config.sessionStrategy,
      sessionId: config.sessionId,
    } as const;
  }

  const baseSessionId = config.sessionId.trim().length > 0 ? config.sessionId : "paperclip";
  return {
    sessionStrategy: "named" as const,
    sessionId: `${baseSessionId}-bridge`,
  };
}

function sanitizeExecuteEnv(env: Record<string, string> | undefined) {
  if (!env || !(SANDBOX_EXEC_CHANNEL_ENV in env)) {
    return env;
  }
  const nextEnv = { ...env };
  delete nextEnv[SANDBOX_EXEC_CHANNEL_ENV];
  return nextEnv;
}

function logCloudflareExecChunk(
  logger: PluginLogger | null,
  stream: "stdout" | "stderr",
  chunk: string,
) {
  if (!logger || chunk.length === 0) return;
  const lines = chunk
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (const line of lines) {
    if (stream === "stderr") {
      logger.warn(`${CLOUDFLARE_EXEC_STDERR_PREFIX} ${line}`);
    } else {
      logger.info(`${CLOUDFLARE_EXEC_STDOUT_PREFIX} ${line}`);
    }
  }
}

let pluginLogger: PluginLogger | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    pluginLogger = ctx.logger;
    ctx.logger.info("Cloudflare sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Cloudflare sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseCloudflareDriverConfig(params.config);
    const errors = validateCloudflareDriverConfig(config);
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return {
      ok: true,
      normalizedConfig: { ...config },
    };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const { config, client } = bridgeClientFor(params.config);
    try {
      const result = await client.probe(
        {
          requestedCwd: config.requestedCwd,
          keepAlive: config.keepAlive,
          sleepAfter: config.sleepAfter,
          normalizeId: config.normalizeId,
          sessionStrategy: config.sessionStrategy,
          sessionId: config.sessionId,
          timeoutMs: config.timeoutMs,
        },
        { environmentId: params.environmentId, issueId: params.issueId },
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        summary: "Cloudflare sandbox bridge probe failed.",
        metadata: {
          provider: "cloudflare",
          error: message,
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const { config, client } = bridgeClientFor(params.config);
    return await client.acquireLease(
      {
        environmentId: params.environmentId,
        runId: params.runId,
        issueId: params.issueId,
        reuseLease: config.reuseLease,
        keepAlive: config.keepAlive,
        sleepAfter: config.sleepAfter,
        normalizeId: config.normalizeId,
        requestedCwd: params.requestedCwd?.trim() || config.requestedCwd,
        sessionStrategy: config.sessionStrategy,
        sessionId: config.sessionId,
        timeoutMs: config.timeoutMs,
      },
      { environmentId: params.environmentId, runId: params.runId, issueId: params.issueId },
    );
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const { config, client } = bridgeClientFor(params.config);
    try {
      return await client.resumeLease(
        {
          providerLeaseId: params.providerLeaseId,
          requestedCwd:
            typeof params.leaseMetadata?.remoteCwd === "string" && params.leaseMetadata.remoteCwd.trim().length > 0
              ? params.leaseMetadata.remoteCwd.trim()
              : config.requestedCwd,
          sessionStrategy: config.sessionStrategy,
          sessionId: config.sessionId,
          keepAlive: config.keepAlive,
          sleepAfter: config.sleepAfter,
          normalizeId: config.normalizeId,
          timeoutMs: config.timeoutMs,
        },
        { environmentId: params.environmentId, issueId: params.issueId },
      );
    } catch (error) {
      if (isLostLeaseError(error)) {
        return {
          providerLeaseId: null,
          metadata: {
            provider: "cloudflare",
            expired: true,
          },
        };
      }
      throw error;
    }
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const { config, client } = bridgeClientFor(params.config);
    await client.releaseLease(
      {
        providerLeaseId: params.providerLeaseId,
        reuseLease: config.reuseLease,
        keepAlive: config.keepAlive,
      },
      { environmentId: params.environmentId, issueId: params.issueId },
    );
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const { client } = bridgeClientFor(params.config);
    await client.destroyLease(params.providerLeaseId, {
      environmentId: params.environmentId,
      issueId: params.issueId,
    });
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const { config, client } = bridgeClientFor(params.config);
    const remoteCwd = resolveRemoteCwd(config, params);
    const issueId = resolveWorkspaceIssueId(params);

    if (params.lease.providerLeaseId) {
      try {
        await client.execute(
          {
            providerLeaseId: params.lease.providerLeaseId,
            command: "mkdir",
            args: ["-p", remoteCwd],
            cwd: "/",
            timeoutMs: config.timeoutMs,
            sessionStrategy: config.sessionStrategy,
            sessionId: config.sessionId,
          },
          { environmentId: params.environmentId, issueId },
        );
      } catch (error) {
        throw wrapWorkspacePreparationError(remoteCwd, error);
      }
    }

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "cloudflare",
        remoteCwd,
      },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        signal: null,
        stdout: "",
        stderr: "No provider lease ID available for execution.\n",
      };
    }

    const { config, client } = bridgeClientFor(params.config);
    const session = resolveExecuteSession(config, params.env);
    try {
      const streamingOptions = pluginLogger
        ? {
            onOutput: async (stream: "stdout" | "stderr", chunk: string) => {
              logCloudflareExecChunk(pluginLogger, stream, chunk);
            },
          }
        : undefined;
      return await client.execute(
        {
          providerLeaseId: params.lease.providerLeaseId,
          command: params.command,
          args: params.args,
          cwd: params.cwd,
          env: sanitizeExecuteEnv(params.env),
          stdin: params.stdin ?? null,
          timeoutMs: params.timeoutMs ?? config.timeoutMs,
          sessionStrategy: session.sessionStrategy,
          sessionId: session.sessionId,
        },
        { environmentId: params.environmentId, issueId: params.issueId },
        streamingOptions,
      );
    } catch (error) {
      if (error instanceof CloudflareBridgeError && isLostLeaseError(error)) {
        return lostLeaseExecuteResult(error);
      }
      throw error;
    }
  },
});

export default plugin;
