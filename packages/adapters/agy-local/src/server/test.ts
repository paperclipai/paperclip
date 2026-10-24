import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  adapterExecutionTargetUsesManagedHome,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  maybeRunSandboxInstallCommand,
  prepareAdapterExecutionTargetRuntime,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADAPTER_AUTH_MISSING_CHECK_CODE,
  DEFAULT_AGY_LOCAL_MODEL,
  resolveAgyModelEffort,
  SANDBOX_INSTALL_COMMAND,
} from "../index.js";
import { detectAgyAuthRequired, parseAgyJsonl } from "./parse.js";
import {
  copyBackAgyAuth,
  ensureAgyApiKeySettings,
  resolveAgyOAuthTokenPath,
  stageAgyHomeForSync,
} from "./credentials.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agy");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const targetIsSandbox = target?.kind === "remote" && target.transport === "sandbox";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `agy-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "agy_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "agy_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "agy_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  if (targetIsRemote) {
    const installCheck = await maybeRunSandboxInstallCommand({
      runId,
      target,
      adapterKey: "agy",
      installCommand: SANDBOX_INSTALL_COMMAND,
      detectCommand: command,
      env,
    });
    if (installCheck) checks.push(installCheck);
  }

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
    });
    checks.push({
      code: "agy_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "agy_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canRunProbe = checks.every(
    (check) => check.code !== "agy_cwd_invalid" && check.code !== "agy_command_unresolvable",
  );

  if (canRunProbe) {
    let preparedRuntime: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | null = null;
    let preparedRuntimeWorkspaceLocalDir: string | null = null;
    let stagedHomeLocalDir: string | null = null;

    try {
      if (runtimeEnv.GEMINI_API_KEY && !targetIsRemote) {
        try {
          await ensureAgyApiKeySettings(runtimeEnv.HOME || os.homedir(), runtimeEnv);
        } catch {
          // Continue probe even if settings write fails
        }
      }

      if (targetIsRemote) {
        preparedRuntimeWorkspaceLocalDir = await fs.promises.mkdtemp(
          path.join(os.tmpdir(), `paperclip-agy-envtest-${runId}-`),
        );
        stagedHomeLocalDir = await stageAgyHomeForSync({
          homedir: runtimeEnv.HOME || os.homedir(),
          env: runtimeEnv,
          runId,
        });
        const hostTokenPath =
          resolveAgyOAuthTokenPath(runtimeEnv.HOME || os.homedir(), runtimeEnv) ??
          path.join(runtimeEnv.HOME || os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");

        preparedRuntime = await prepareAdapterExecutionTargetRuntime({
          runId,
          target,
          adapterKey: "agy",
          workspaceLocalDir: preparedRuntimeWorkspaceLocalDir,
          workspaceRemoteDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          assets: [
            {
              key: "agy-home",
              localDir: stagedHomeLocalDir,
              followSymlinks: true,
              restore: async ({ assetDir, readFile }) => {
                await copyBackAgyAuth({
                  readSandboxAuth: () => readFile(path.posix.join(assetDir, "antigravity-oauth-token")),
                  hostTokenPath,
                  log: () => {},
                  env: process.env,
                });
              },
            },
          ],
        });

        const managedHome = adapterExecutionTargetUsesManagedHome(target);
        const managedRemoteHomeDir =
          managedHome && preparedRuntime.runtimeRootDir ? preparedRuntime.runtimeRootDir : null;
        if (managedRemoteHomeDir) {
          env.HOME = managedRemoteHomeDir;
        }
        if (preparedRuntime.assetDirs["agy-home"]) {
          // Point the CLI home at the staged asset directory itself; never
          // delete or replace the remote user's ~/.gemini/antigravity-cli.
          const stagedAgyHomeRemote = preparedRuntime.assetDirs["agy-home"];
          env.ANTIGRAVITY_CLI_HOME = stagedAgyHomeRemote;
          env.GEMINI_CLI_HOME = stagedAgyHomeRemote;
        }
      }

      const model = asString(config.model, DEFAULT_AGY_LOCAL_MODEL).trim();
      const effort = asString(config.effort, "").trim();
      // When unset, omit --mode to match real execution under Antigravity default edit mode
      const mode = asString(config.mode, "").trim();
      const agentPersona = asString(config.agent ?? config.agentPersona, "").trim();
      const sandbox = Boolean(config.sandbox);
      const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 60));
      const extraArgs = asStringArray(config.extraArgs);
      const inputFormat = asString(config.inputFormat, "stream-json").trim().toLowerCase();
      const useStreamJsonInput = inputFormat !== "text";

      const args = [
        "--output-format",
        "stream-json",
        "--input-format",
        useStreamJsonInput ? "stream-json" : "text",
      ];
      if (!useStreamJsonInput) {
        args.push("--print", "Respond with hello.");
      }
      if (sandbox) args.push("--sandbox");
      if (agentPersona) args.push("--agent", agentPersona);
      const resolvedModelEffort = resolveAgyModelEffort(model, effort);
      if (resolvedModelEffort.warning) {
        checks.push({
          code: "agy_model_effort_unsupported",
          level: "warn",
          message: resolvedModelEffort.warning,
        });
      }
      if (resolvedModelEffort.model) args.push("--model", resolvedModelEffort.model);
      if (resolvedModelEffort.effort) args.push("--effort", resolvedModelEffort.effort);
      if (mode) args.push("--mode", mode);
      if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
      if (extraArgs.length > 0) args.push(...extraArgs);

      const stdin = useStreamJsonInput
        ? JSON.stringify({ event: "user", message: { content: "Respond with hello." } }) + "\n"
        : undefined;

      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        args,
        {
          cwd,
          env,
          stdin,
          timeoutSec: helloProbeTimeoutSec,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      const parsed = parseAgyJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authMeta = detectAgyAuthRequired({
        stdout: probe.stdout,
        stderr: probe.stderr,
        parsed,
      });

      if (probe.timedOut) {
        checks.push({
          code: "agy_hello_probe_timed_out",
          level: "warn",
          message: "Antigravity hello probe timed out.",
          hint: "Verify agy can run `agy --print \"hello\"` from this directory manually.",
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "agy_hello_probe_auth_required",
          level: "warn",
          message: "Antigravity CLI is installed, but authentication is required.",
          hint: "Provide an API key or log in via `agy auth login`.",
        });
        if (targetIsSandbox) {
          checks.push({
            code: ADAPTER_AUTH_MISSING_CHECK_CODE,
            level: "warn",
            message: "This environment has no ready authentication for this adapter.",
            hint: "Provide credentials for this adapter, or start login in the environment.",
          });
        }
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "agy_hello_probe_passed" : "agy_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Antigravity hello probe succeeded."
            : "Antigravity probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
        });
      } else {
        checks.push({
          code: "agy_hello_probe_failed",
          level: "error",
          message: "Antigravity hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `agy --print \"hello\" --output-format stream-json` in this working directory to debug.",
        });
      }
    } finally {
      await preparedRuntime?.restoreWorkspace().catch(() => {});
      if (preparedRuntimeWorkspaceLocalDir) {
        await fs.promises.rm(preparedRuntimeWorkspaceLocalDir, { recursive: true, force: true }).catch(() => {});
      }
      if (stagedHomeLocalDir) {
        await fs.promises.rm(stagedHomeLocalDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
