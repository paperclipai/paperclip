import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
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

interface FakeDriverConfig {
  image: string;
  timeoutMs: number;
  reuseLease: boolean;
}

interface FakeLeaseState {
  providerLeaseId: string;
  rootDir: string;
  remoteCwd: string;
  image: string;
  reuseLease: boolean;
}

const leases = new Map<string, FakeLeaseState>();
const DEFAULT_FAKE_SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const FAKE_SANDBOX_SIGKILL_GRACE_MS = 250;

function parseConfig(raw: Record<string, unknown>): FakeDriverConfig {
  return {
    image: typeof raw.image === "string" && raw.image.trim().length > 0 ? raw.image.trim() : "fake:latest",
    timeoutMs: typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) ? raw.timeoutMs : 300_000,
    reuseLease: raw.reuseLease === true,
  };
}

async function createLeaseState(input: {
  providerLeaseId: string;
  image: string;
  reuseLease: boolean;
}): Promise<FakeLeaseState> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-fake-sandbox-"));
  const remoteCwd = path.join(rootDir, "workspace");
  await mkdir(remoteCwd, { recursive: true });
  const state = {
    providerLeaseId: input.providerLeaseId,
    rootDir,
    remoteCwd,
    image: input.image,
    reuseLease: input.reuseLease,
  };
  leases.set(input.providerLeaseId, state);
  return state;
}

function leaseMetadata(state: FakeLeaseState) {
  return {
    provider: "fake-plugin",
    image: state.image,
    reuseLease: state.reuseLease,
    remoteCwd: state.remoteCwd,
    fakeRootDir: state.rootDir,
  };
}

async function removeLease(providerLeaseId: string | null | undefined): Promise<void> {
  if (!providerLeaseId) return;
  const state = leases.get(providerLeaseId);
  leases.delete(providerLeaseId);
  if (state) {
    await rm(state.rootDir, { recursive: true, force: true });
  }
}

function buildCommandLine(command: string, args: string[] | undefined): string {
  return [command, ...(args ?? [])].join(" ");
}

function buildCommandEnvironment(explicitEnv: Record<string, string> | undefined): Record<string, string> {
  return {
    PATH: explicitEnv?.PATH ?? DEFAULT_FAKE_SANDBOX_PATH,
    ...(explicitEnv ?? {}),
  };
}

async function runCommand(params: PluginEnvironmentExecuteParams, timeoutMs: number): Promise<PluginEnvironmentExecuteResult> {
  const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : process.cwd();
  const startedAt = new Date().toISOString();

  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env: buildCommandEnvironment(params.env),
      shell: false,
      stdio: [params.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            child.kill("SIGKILL");
          }, FAKE_SANDBOX_SIGKILL_GRACE_MS);
        }, timeoutMs)
      : null;

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: timedOut ? null : code,
        signal,
        timedOut,
        stdout,
        stderr,
        metadata: {
          startedAt,
          commandLine: buildCommandLine(params.command, params.args),
        },
      });
    });

    if (params.stdin != null && child.stdin) {
      child.stdin.write(params.stdin);
      child.stdin.end();
    }
  });
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Fake sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Fake sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseConfig(params.config);
    return {
      ok: true,
      normalizedConfig: { ...config },
    };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseConfig(params.config);
    return {
      ok: true,
      summary: `Fake sandbox provider is ready for image ${config.image}.`,
      metadata: {
        provider: "fake-plugin",
        image: config.image,
        timeoutMs: config.timeoutMs,
        reuseLease: config.reuseLease,
      },
    };
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseConfig(params.config);
    const providerLeaseId = config.reuseLease
      ? `fake-plugin://${params.environmentId}`
      : `fake-plugin://${params.runId}/${randomUUID()}`;
    const existing = leases.get(providerLeaseId);
    const state = existing ?? await createLeaseState({
      providerLeaseId,
      image: config.image,
      reuseLease: config.reuseLease,
    });

    return {
      providerLeaseId,
      metadata: {
        ...leaseMetadata(state),
        resumedLease: Boolean(existing),
      },
    };
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseConfig(params.config);
    const existing = leases.get(params.providerLeaseId);
    const state = existing ?? await createLeaseState({
      providerLeaseId: params.providerLeaseId,
      image: config.image,
      reuseLease: config.reuseLease,
    });

    return {
      providerLeaseId: state.providerLeaseId,
      metadata: {
        ...leaseMetadata(state),
        resumedLease: true,
      },
    };
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    const config = parseConfig(params.config);
    if (!config.reuseLease) {
      await removeLease(params.providerLeaseId);
    }
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    await removeLease(params.providerLeaseId);
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const state = params.lease.providerLeaseId
      ? leases.get(params.lease.providerLeaseId)
      : null;
    const remoteCwd =
      state?.remoteCwd ??
      (typeof params.lease.metadata?.remoteCwd === "string" ? params.lease.metadata.remoteCwd : null) ??
      params.workspace.remotePath ??
      params.workspace.localPath ??
      path.join(os.tmpdir(), "paperclip-fake-sandbox-workspace");

    await mkdir(remoteCwd, { recursive: true });

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "fake-plugin",
        remoteCwd,
      },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    const config = parseConfig(params.config);
    return await runCommand(params, params.timeoutMs ?? config.timeoutMs);
  },
});

export default plugin;
