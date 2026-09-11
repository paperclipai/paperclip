import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import {
  RUNNER_RESOURCE_WAIT_ERROR_CODE,
  RUNNER_TIMEOUT_EXIT_CODE,
  readRunnerAdmissionRejection,
  readRunnerResourceWait,
  readRunnerTimeoutEvidence,
} from "../../services/execution-resource-admission.js";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  isForbiddenConfigEnvKey,
  isPaperclipRuntimeEnvKey,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  resolveCommandForLogs,
  runChildProcess,
} from "../utils.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta, authToken } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const args = asStringArray(config.args);
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v !== "string") continue;
    // Runtime PAPERCLIP_* always wins over config, and PAPERCLIP_API_KEY is
    // never accepted from config — the harness-minted run token is the only
    // source. Other PAPERCLIP_* keys Paperclip did not assign flow through.
    if (isForbiddenConfigEnvKey(k)) continue;
    if (isPaperclipRuntimeEnvKey(k) && k in env) continue;
    env[k] = v;
  }
  env.PAPERCLIP_RUN_ID = runId;
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  // runtimeEnv is only used to resolve the command path and log HOME below;
  // the child env is built inside runChildProcess from
  // sanitizeInheritedPaperclipEnv(process.env) + env, so a PAPERCLIP_API_KEY
  // on the server process never reaches the child.
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  if (onMeta) {
    await onMeta({
      adapterType: "process",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn: ctx.onSpawn,
  });

  // A contained runner that refused before model launch reports the outcome as
  // a structured envelope with a reserved exit code. Native maps that onto its
  // workspace-busy deferral so contention costs no failure attempt; both the
  // reserved code and the envelope are required, so a worker cannot manufacture
  // a deferral and a real failure that merely exits 95 stays a failure.
  const runnerResourceWait = readRunnerResourceWait({
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    runId,
  });

  if (proc.timedOut) {
    // A timeout is still a timeout. The evidence only says whether the worker
    // reached the model and how much it did, so the bounded continuation can
    // resume the same session instead of restarting the task.
    const runnerTimeout = readRunnerTimeoutEvidence({
      exitCode: proc.exitCode,
      stdout: proc.stdout,
      runId,
    });
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      ...(runnerTimeout
        ? {
            resultJson: {
              stdout: proc.stdout,
              stderr: proc.stderr,
              runnerTimeout,
            },
          }
        : {}),
    };
  }

  if (runnerResourceWait) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorCode: RUNNER_RESOURCE_WAIT_ERROR_CODE,
      errorMessage: `Run deferred before model launch: ${
        runnerResourceWait.detail ?? runnerResourceWait.reasonCode
      }`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
        runnerResourceWait,
      },
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    // The launcher's wall clock can expire before native's, so the child exits
    // with the reserved timeout code on its own. A timeout is still a timeout,
    // but the envelope — not the bare code — is the evidence: it binds the run
    // identity and states explicitly whether the model started and the session
    // is resumable, so the bounded continuation can resume the same session. A
    // bare, malformed, or mismatched 124 from an unrelated failure never
    // fabricates resumability and stays an ordinary failure.
    if ((proc.exitCode ?? 0) === RUNNER_TIMEOUT_EXIT_CODE) {
      const launcherRunnerTimeout = readRunnerTimeoutEvidence({
        exitCode: proc.exitCode,
        stdout: proc.stdout,
        runId,
      });
      if (launcherRunnerTimeout) {
        return {
          exitCode: proc.exitCode,
          signal: proc.signal,
          timedOut: true,
          errorMessage: `Run exceeded its wall-clock limit (exit code ${RUNNER_TIMEOUT_EXIT_CODE})`,
          resultJson: {
            stdout: proc.stdout,
            stderr: proc.stderr,
            runnerTimeout: launcherRunnerTimeout,
          },
        };
      }
    }
    const runnerAdmissionRejection = readRunnerAdmissionRejection({
      exitCode: proc.exitCode,
      stdout: proc.stdout,
      runId,
    });
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      ...(runnerAdmissionRejection ? { errorCode: runnerAdmissionRejection.reasonCode } : {}),
      errorMessage: runnerAdmissionRejection
        ? `Run refused before model launch: ${runnerAdmissionRejection.reasonCode}`
        : `Process exited with code ${proc.exitCode ?? -1}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
        ...(runnerAdmissionRejection ? { runnerAdmissionRejection } : {}),
      },
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
