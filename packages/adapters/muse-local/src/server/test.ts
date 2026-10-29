import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, ensurePathInEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  ensureAdapterExecutionTargetCommandResolvable,
  runAdapterExecutionTargetProcess,
  prepareAdapterExecutionTargetRuntime,
} from "@paperclipai/adapter-utils/execution-target";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
  });
  const targetIsRemote = target?.kind === "remote";

  const configuredCommand = asString(ctx.config?.command, "muse");
  const fallbackPath = path.join(os.homedir(), ".local/bin/muse");
  const command =
    !targetIsRemote &&
    configuredCommand === "muse" &&
    (await fs.access(fallbackPath).then(() => true).catch(() => false))
      ? fallbackPath
      : configuredCommand;

  const rawCwd = asString(ctx.config?.cwd, "");
  const cwd = resolveAdapterExecutionTargetCwd(target, rawCwd, os.homedir());

  const configEnv = parseObject(ctx.config?.env) as Record<string, string>;
  const env: Record<string, string> = {
    MUSE_NO_AUTO_UPDATE: "1",
    ...configEnv,
  };
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const normalizedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (typeof value === "string") normalizedEnv[key] = value;
  }

  let binaryFound = false;
  try {
    await ensureAdapterExecutionTargetCommandResolvable(
      command,
      target,
      cwd,
      targetIsRemote ? env : runtimeEnv,
    );
    const versionProcess = await runAdapterExecutionTargetProcess(
      `muse-version-${Date.now()}`,
      target,
      command,
      ["--version"],
      {
        cwd,
        env: targetIsRemote ? env : normalizedEnv,
        timeoutSec: 10,
        graceSec: 2,
        onLog: async () => {},
      },
    );
    if ((versionProcess.exitCode ?? 0) === 0) {
      checks.push({
        code: "muse_cli_installed",
        level: "info",
        message: `Muse CLI installed: ${(versionProcess.stdout || "").trim()}`,
      });
      binaryFound = true;
    } else {
      checks.push({
        code: "muse_cli_missing",
        level: "error",
        message: "Muse CLI binary was found but exited with an error.",
        hint: "Run 'curl -fsSL https://dev.meta.ai/install.sh | bash' to reinstall Muse.",
      });
    }
  } catch {
    checks.push({
      code: "muse_cli_missing",
      level: "error",
      message: "Muse CLI binary was not found or failed to execute.",
      hint: "Run 'curl -fsSL https://dev.meta.ai/install.sh | bash' to install Muse.",
    });
  }

  if (binaryFound) {
    const originalXdgConfig = env.XDG_CONFIG_HOME || process.env.XDG_CONFIG_HOME;
    const xdgConfig = env.XDG_CONFIG_HOME || path.join(runtimeEnv.HOME || os.homedir(), ".config");
    const targetAuth = path.join(xdgConfig, "muse", "auth.json");
    const sourceCandidates = [
      env.MUSE_AUTH_PATH,
      originalXdgConfig ? path.join(originalXdgConfig, "muse", "auth.json") : null,
      path.join(runtimeEnv.HOME || os.homedir(), ".config/muse/auth.json"),
    ].filter(Boolean) as string[];

    let hasAuth = false;
    let authContent: string | null = null;
    if (await fs.access(targetAuth).then(() => true).catch(() => false)) {
      hasAuth = true;
      authContent = await fs.readFile(targetAuth, "utf8").catch(() => null);
    } else {
      for (const src of sourceCandidates) {
        if (src && src !== targetAuth && (await fs.access(src).then(() => true).catch(() => false))) {
          try {
            const data = await fs.readFile(src, "utf8");
            await fs.mkdir(path.join(xdgConfig, "muse"), { recursive: true, mode: 0o700 });
            await fs.writeFile(targetAuth, data, { mode: 0o600 });
            hasAuth = true;
            authContent = data;
            break;
          } catch {}
        }
      }
    }
    if (targetIsRemote) {
      hasAuth = Boolean(authContent || env.MUSE_AUTH_PATH || env.META_API_KEY);
    } else if (!hasAuth && (env.META_API_KEY || runtimeEnv.META_API_KEY)) {
      hasAuth = true;
    }

    if (hasAuth) {
      checks.push({
        code: "muse_auth_configured",
        level: "info",
        message: "Muse credentials configured.",
      });

      let effectiveProbeCwd = cwd;
      let probeEnv: Record<string, string> = targetIsRemote ? { ...env } : { ...normalizedEnv };
      let cleanupProbe: (() => Promise<void>) | null = null;
      const probeRunId = `muse-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      if (targetIsRemote && authContent) {
        const assetKey = `probeConfig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const probeTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-muse-test-${Date.now()}-`));
        await fs.mkdir(path.join(probeTmpDir, "muse"), { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(probeTmpDir, "muse", "auth.json"), authContent, { mode: 0o600 });
        const localWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-muse-ws-${Date.now()}-`));
        try {
          const prepared = await prepareAdapterExecutionTargetRuntime({
            runId: probeRunId,
            target,
            adapterKey: "muse",
            workspaceLocalDir: localWorkspaceDir,
            workspaceRemoteDir: cwd,
            syncWorkspace: false,
            workspaceRestoreRetryDelaysMs: [],
            assets: [
              {
                key: assetKey,
                localDir: probeTmpDir,
                restore: async () => {},
              },
            ],
          });
          effectiveProbeCwd = prepared.workspaceRemoteDir ?? effectiveProbeCwd;
          const stagedRemoteConfig = prepared.assetDirs[assetKey];
          if (stagedRemoteConfig) {
            probeEnv.XDG_CONFIG_HOME = stagedRemoteConfig;
            probeEnv.MUSE_AUTH_PATH = path.posix.join(stagedRemoteConfig, "muse", "auth.json");
          }
          cleanupProbe = async () => {
            if (stagedRemoteConfig && targetIsRemote) {
              await runAdapterExecutionTargetProcess(
                probeRunId,
                target,
                "rm",
                ["-rf", stagedRemoteConfig],
                { cwd: effectiveProbeCwd, env: {}, timeoutSec: 10, graceSec: 2, onLog: async () => {} },
              ).catch(() => {});
            }
            await prepared.restoreWorkspace().catch(() => {});
            await fs.rm(localWorkspaceDir, { recursive: true, force: true }).catch(() => {});
            await fs.rm(probeTmpDir, { recursive: true, force: true }).catch(() => {});
          };
        } catch {
          await fs.rm(localWorkspaceDir, { recursive: true, force: true }).catch(() => {});
          await fs.rm(probeTmpDir, { recursive: true, force: true }).catch(() => {});
        }
      }

      try {
        const model = asString(ctx.config?.model, "muse-wonder-1.0");
        const probeArgs = ["exec", "--model", model, "--yolo", "Respond with hello"];
        const probeProcess = await runAdapterExecutionTargetProcess(
          probeRunId,
          target,
          command,
          probeArgs,
          {
            cwd: effectiveProbeCwd,
            env: probeEnv,
            timeoutSec: 25,
            graceSec: 3,
            onLog: async () => {},
          },
        );

        if (probeProcess.timedOut) {
          checks.push({
            code: "muse_hello_probe_failed",
            level: "error",
            message: "Muse hello probe timed out.",
            hint: "Verify your Muse Code subscription and network connectivity.",
          });
        } else if (/\bhello\b/i.test(probeProcess.stdout || "")) {
          checks.push({
            code: "muse_hello_probe_passed",
            level: "info",
            message: "Muse hello probe succeeded.",
          });
        } else {
          checks.push({
            code: "muse_hello_probe_unexpected_output",
            level: "warn",
            message: "Muse probe ran but did not return 'hello' as expected.",
            detail: (probeProcess.stdout || probeProcess.stderr || "").trim().slice(0, 200),
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        checks.push({
          code: "muse_hello_probe_failed",
          level: "error",
          message: `Muse hello probe failed: ${message}`,
          hint: "Verify your Muse Code subscription and API connectivity.",
        });
      } finally {
        await cleanupProbe?.();
      }
    } else {
      checks.push({
        code: "muse_auth_missing",
        level: "warn",
        message: "Muse CLI authentication not found.",
        hint: "Run 'muse login' or connect a Muse Code subscription in Paperclip.",
      });
    }
  }

  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");

  return {
    adapterType: "muse_local",
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
