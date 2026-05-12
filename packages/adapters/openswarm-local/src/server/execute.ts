import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  asBoolean,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  joinPromptSections,
  renderPaperclipWakePrompt,
  resolveCommandForLogs,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import fs from "node:fs/promises";

type Flavor = "unohee" | "vrsen";

function readFlavor(value: unknown): Flavor {
  return value === "vrsen" ? "vrsen" : "unohee";
}

async function readInstructionsFile(filePath: string | null): Promise<string> {
  if (!filePath) return "";
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.trim();
  } catch {
    return "";
  }
}

function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  instructions: string,
): string {
  const wakeDoc = renderPaperclipWakePrompt(ctx.context.paperclipWake, {
    resumedSession: false,
  });
  const promptTemplate = asString(config.promptTemplate, "").trim();
  return joinPromptSections([instructions, promptTemplate, wakeDoc]);
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta } = ctx;
  const flavor = readFlavor(config.flavor);
  const command = asString(config.command, "openswarm");
  const cwd = asString(config.cwd, process.cwd());

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  const instructionsPath = asString(config.instructionsFilePath, "").trim();
  const instructions = await readInstructionsFile(instructionsPath || null);
  const prompt = buildPrompt(ctx, config, instructions);

  if (!prompt.trim()) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage:
        "openswarm_local: empty prompt after rendering wake payload + template",
    };
  }

  const extraArgs = asStringArray(config.extraArgs);
  const args: string[] = [];

  if (flavor === "unohee") {
    // unohee/OpenSwarm: `openswarm exec "<prompt>" -p <cwd> [--local] [--pipeline]`
    args.push("exec", prompt, "-p", cwd);
    const localOnly = asBoolean(config.localOnly, true);
    const pipeline = asBoolean(config.pipeline, true);
    if (localOnly) args.push("--local");
    if (pipeline) args.push("--pipeline");
  } else {
    // vrsen/OpenSwarm: one-prompt-to-deliverable; CLI takes the prompt as a
    // positional argument.
    args.push(prompt);
  }

  if (extraArgs.length > 0) args.push(...extraArgs);

  const timeoutSec = asNumber(config.timeoutSec, 1800);
  const graceSec = asNumber(config.graceSec, 15);

  const resolvedCommand = await resolveCommandForLogs(
    command,
    cwd,
    runtimeEnv,
  );
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "PATH"],
    resolvedCommand,
  });

  if (onMeta) {
    await onMeta({
      adapterType: "openswarm_local",
      command: resolvedCommand,
      cwd,
      // prompt is logged inline as a separate field rather than bloating
      // commandArgs (which can echo into transcripts and the dashboard).
      commandArgs: args.map((arg, i) =>
        i === args.indexOf(prompt) && arg === prompt
          ? "<paperclip-wake-prompt>"
          : arg,
      ),
      env: loggedEnv,
      prompt,
    });
  }

  await onLog(
    "stderr",
    `[openswarm:${flavor}] starting ${resolvedCommand} for run ${runId} in ${cwd}\n`,
  );

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
      errorMessage: `openswarm_local timed out after ${timeoutSec}s`,
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `openswarm exited with code ${proc.exitCode ?? -1}`,
      resultJson: {
        flavor,
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
      flavor,
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
