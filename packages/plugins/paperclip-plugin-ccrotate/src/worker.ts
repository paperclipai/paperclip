import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginEnvironmentAcquireLeaseParams,
  type PluginEnvironmentDestroyLeaseParams,
  type PluginEnvironmentExecuteParams,
  type PluginEnvironmentExecuteResult,
  type PluginEnvironmentLease,
  type PluginEnvironmentProbeParams,
  type PluginEnvironmentProbeResult,
  type PluginEnvironmentRealizeWorkspaceParams,
  type PluginEnvironmentRealizeWorkspaceResult,
  type PluginEnvironmentReleaseLeaseParams,
  type PluginEnvironmentResumeLeaseParams,
  type PluginEnvironmentValidateConfigParams,
  type PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import { parseDriverConfig } from "./config.js";
import { runSshCommand, rsyncToRemote, shellQuote } from "./ssh.js";
import type { CcrotateDriverConfig, CcrotateLeaseState } from "./types.js";

const leases = new Map<string, CcrotateLeaseState>();
let currentContext: PluginContext | null = null;

function logger() {
  return currentContext?.logger;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function ccrotateRotate(config: CcrotateDriverConfig): Promise<string | null> {
  const result = await runSshCommand(config.ssh, {
    command: "ccrotate",
    args: ["next", "--target", config.target, "-y"],
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `ccrotate next exited with code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return await readCurrentEmail(config);
}

async function readCurrentEmail(config: CcrotateDriverConfig): Promise<string | null> {
  const credentialsFile = config.target === "claude"
    ? "$HOME/.claude/.credentials.json"
    : "$HOME/.codex/auth.json";
  const result = await runSshCommand(config.ssh, {
    command: "sh",
    args: ["-c", `cat ${credentialsFile} 2>/dev/null || true`],
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const email = pickEmail(parsed);
    return email;
  } catch {
    return null;
  }
}

function pickEmail(parsed: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    parsed.email,
    (parsed.user as Record<string, unknown> | undefined)?.email,
    (parsed.account as Record<string, unknown> | undefined)?.email,
    (parsed.tokens as Record<string, unknown> | undefined)?.email,
    (parsed.OPENAI_API_KEY as Record<string, unknown> | undefined)?.email,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.includes("@")) return candidate;
  }
  return null;
}

function matchesRateLimit(text: string, patterns: string[]): boolean {
  if (text.length === 0) return false;
  return patterns.some((pattern) => text.includes(pattern));
}

async function probeRemote(config: CcrotateDriverConfig): Promise<{ ok: boolean; summary: string }> {
  const ssh = await runSshCommand(config.ssh, {
    command: "sh",
    args: ["-c", "command -v ccrotate >/dev/null 2>&1 && ccrotate --version 2>/dev/null || echo MISSING"],
    timeoutMs: 10_000,
  });
  if (ssh.exitCode !== 0) {
    return { ok: false, summary: `SSH probe failed (exit ${ssh.exitCode}): ${ssh.stderr.trim() || "no output"}` };
  }
  const out = ssh.stdout.trim();
  if (out === "MISSING" || out.length === 0) {
    return { ok: false, summary: `ccrotate is not on PATH at ${config.ssh.user}@${config.ssh.host}` };
  }
  return { ok: true, summary: `ccrotate ${out} reachable on ${config.ssh.host} for target=${config.target}` };
}

function leaseRoot(config: CcrotateDriverConfig, runId: string): string {
  const safeId = runId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.posix.join(config.remoteWorkspaceRoot, safeId);
}

async function ensureRemoteDir(config: CcrotateDriverConfig, dir: string): Promise<void> {
  const result = await runSshCommand(config.ssh, {
    command: "mkdir",
    args: ["-p", dir],
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`mkdir -p ${dir} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
}

async function removeRemoteDir(config: CcrotateDriverConfig, dir: string): Promise<void> {
  if (!dir || dir === "/" || dir.length < 2) return;
  await runSshCommand(config.ssh, {
    command: "rm",
    args: ["-rf", dir],
    timeoutMs: 30_000,
  });
}

async function executeOnce(
  config: CcrotateDriverConfig,
  params: PluginEnvironmentExecuteParams,
): Promise<PluginEnvironmentExecuteResult> {
  const startedAt = new Date().toISOString();
  const result = await runSshCommand(config.ssh, {
    command: params.command,
    args: params.args ?? [],
    env: params.env,
    cwd: params.cwd,
    stdin: params.stdin,
    timeoutMs: params.timeoutMs ?? 600_000,
  });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    metadata: {
      startedAt,
      finishedAt: new Date().toISOString(),
      provider: "ccrotate",
      target: config.target,
      commandLine: [params.command, ...(params.args ?? [])].map((part) => shellQuote(part)).join(" "),
    },
  };
}

async function rotateAndLog(config: CcrotateDriverConfig, reason: string): Promise<string | null> {
  logger()?.info("ccrotate rotating account", { reason, target: config.target });
  try {
    const email = await ccrotateRotate(config);
    logger()?.info("ccrotate rotated", { reason, email, target: config.target });
    return email;
  } catch (error) {
    logger()?.warn("ccrotate rotation failed", { reason, error: describeError(error) });
    throw error;
  }
}

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    ctx.logger.info("ccrotate plugin setup", {});
  },

  async onHealth() {
    return {
      status: "ok",
      message: "ccrotate plugin ready",
      details: { activeLeases: leases.size },
    };
  },

  async onShutdown() {
    leases.clear();
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    try {
      const config = parseDriverConfig(params.config);
      return { ok: true, normalizedConfig: config as unknown as Record<string, unknown> };
    } catch (error) {
      return { ok: false, errors: [describeError(error)] };
    }
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    let config: CcrotateDriverConfig;
    try {
      config = parseDriverConfig(params.config);
    } catch (error) {
      return {
        ok: false,
        summary: `Invalid config: ${describeError(error)}`,
        diagnostics: [{ severity: "error", message: describeError(error) }],
      };
    }
    try {
      const probe = await probeRemote(config);
      return {
        ok: probe.ok,
        summary: probe.summary,
        metadata: {
          host: config.ssh.host,
          user: config.ssh.user,
          target: config.target,
        },
      };
    } catch (error) {
      return {
        ok: false,
        summary: `Probe failed: ${describeError(error)}`,
        diagnostics: [{ severity: "error", message: describeError(error) }],
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const providerLeaseId = `ccrotate://${config.target}/${params.runId}/${randomUUID()}`;
    const remoteCwd = leaseRoot(config, params.runId);

    await ensureRemoteDir(config, remoteCwd);

    let rotatedEmail: string | null = null;
    try {
      rotatedEmail = await rotateAndLog(config, "acquireLease");
    } catch (error) {
      logger()?.warn("ccrotate could not rotate at lease acquire; using current account", {
        error: describeError(error),
      });
      rotatedEmail = await readCurrentEmail(config).catch(() => null);
    }

    const state: CcrotateLeaseState = {
      providerLeaseId,
      remoteCwd,
      rotatedEmail,
      rotatedAt: new Date().toISOString(),
      target: config.target,
    };
    leases.set(providerLeaseId, state);

    return {
      providerLeaseId,
      metadata: {
        provider: "ccrotate",
        target: config.target,
        rotatedEmail: rotatedEmail ?? null,
        remoteCwd,
      },
    };
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const existing = leases.get(params.providerLeaseId);
    if (existing) {
      return {
        providerLeaseId: existing.providerLeaseId,
        metadata: {
          provider: "ccrotate",
          target: existing.target,
          rotatedEmail: existing.rotatedEmail,
          remoteCwd: existing.remoteCwd,
          resumed: true,
        },
      };
    }
    const remoteCwd =
      (typeof params.leaseMetadata?.remoteCwd === "string" ? params.leaseMetadata.remoteCwd : null) ??
      path.posix.join(config.remoteWorkspaceRoot, params.providerLeaseId.replace(/[^a-zA-Z0-9._-]/g, "_"));
    await ensureRemoteDir(config, remoteCwd);

    const reconstructed: CcrotateLeaseState = {
      providerLeaseId: params.providerLeaseId,
      remoteCwd,
      rotatedEmail:
        typeof params.leaseMetadata?.rotatedEmail === "string"
          ? params.leaseMetadata.rotatedEmail
          : null,
      rotatedAt: new Date().toISOString(),
      target: config.target,
    };
    leases.set(reconstructed.providerLeaseId, reconstructed);
    return {
      providerLeaseId: reconstructed.providerLeaseId,
      metadata: {
        provider: "ccrotate",
        target: reconstructed.target,
        rotatedEmail: reconstructed.rotatedEmail,
        remoteCwd: reconstructed.remoteCwd,
        resumed: true,
      },
    };
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    const state = params.providerLeaseId ? leases.get(params.providerLeaseId) : null;
    if (state) leases.delete(state.providerLeaseId);
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    let config: CcrotateDriverConfig;
    try {
      config = parseDriverConfig(params.config);
    } catch (error) {
      logger()?.warn("ccrotate destroyLease invoked with invalid config", { error: describeError(error) });
      if (params.providerLeaseId) leases.delete(params.providerLeaseId);
      return;
    }
    const state = params.providerLeaseId ? leases.get(params.providerLeaseId) : null;
    if (state) {
      await removeRemoteDir(config, state.remoteCwd).catch((error) => {
        logger()?.warn("ccrotate failed to remove remote workspace", {
          error: describeError(error),
          remoteCwd: state.remoteCwd,
        });
      });
      leases.delete(state.providerLeaseId);
    }
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const state = params.lease.providerLeaseId ? leases.get(params.lease.providerLeaseId) : null;
    const remoteCwd =
      state?.remoteCwd ??
      (typeof params.lease.metadata?.remoteCwd === "string" ? params.lease.metadata.remoteCwd : null) ??
      params.workspace.remotePath ??
      leaseRoot(config, params.lease.providerLeaseId ?? randomUUID());

    await ensureRemoteDir(config, remoteCwd);

    if (params.workspace.localPath) {
      try {
        await rsyncToRemote(config.ssh, params.workspace.localPath, remoteCwd);
      } catch (error) {
        logger()?.warn("ccrotate rsync failed; continuing with empty remote workspace", {
          error: describeError(error),
          localPath: params.workspace.localPath,
          remoteCwd,
        });
      }
    }

    if (state) state.remoteCwd = remoteCwd;

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "ccrotate",
        target: config.target,
        remoteCwd,
      },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    const config = parseDriverConfig(params.config);

    let attempt = 0;
    let last: PluginEnvironmentExecuteResult = await executeOnce(config, params);
    const rotations: Array<{ attempt: number; email: string | null; reason: string }> = [];

    // For codex specifically, an in-flight session caches auth.json in memory,
    // so just rotating credentials on disk would not affect a still-running
    // process. Respawning the SSH command after rotation is the relaunch — the
    // new ssh exec spawns a fresh codex/claude process that re-reads the
    // rotated ~/.{codex,claude} credentials at startup. This is also why
    // streaming/long-lived sessions are not safe to mid-run rotate from here.
    while (attempt < config.midRunRetries) {
      const combined = `${last.stdout}\n${last.stderr}`;
      if (!matchesRateLimit(combined, config.rateLimitPatterns)) break;

      attempt += 1;
      try {
        const email = await rotateAndLog(config, `rate-limit-attempt-${attempt}`);
        rotations.push({ attempt, email, reason: "rate-limit-detected" });
      } catch (error) {
        logger()?.warn("ccrotate mid-run rotation failed; returning prior result", {
          error: describeError(error),
        });
        break;
      }

      last = await executeOnce(config, params);
    }

    if (rotations.length > 0) {
      const baseMeta = (last.metadata as Record<string, unknown> | undefined) ?? {};
      last = {
        ...last,
        metadata: {
          ...baseMeta,
          rotations,
        },
      };
    }
    return last;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
