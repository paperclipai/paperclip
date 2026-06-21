import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  resolveCommandForLogs,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta } = ctx;
  const command = asString(config.command, "ollama");
  const model = asString(config.model, "llama3.2");
  const host = asString(config.host, "http://localhost:11434");
  const numCtx = asNumber(config.numCtx, 0);
  const temperature = asNumber(config.temperature, 0);
  const topP = asNumber(config.topP, 0);
  
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { 
    ...buildPaperclipEnv(agent),
    OLLAMA_HOST: host,
  };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "OLLAMA_HOST"],
    resolvedCommand,
  });

  // Build ollama arguments
  const args = ["run", model];
  if (numCtx > 0) args.push("--num-ctx", String(numCtx));
  if (temperature > 0) args.push("--temperature", String(temperature));
  if (topP > 0) args.push("--top-p", String(topP));
  
  const extraArgs = asStringArray(config.extraArgs);
  args.push(...extraArgs);

  const timeoutSec = asNumber(config.timeoutSec, 300);
  const graceSec = asNumber(config.graceSec, 10);

  if (onMeta) {
    await onMeta({
      adapterType: "ollama_local",
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
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
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
