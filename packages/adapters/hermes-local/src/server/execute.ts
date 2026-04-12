import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntimeServiceReport,
} from "@paperclipai/adapter-utils";
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
import {
  resolveCabinetConfig,
  appendMemory,
  readMemory,
  buildCabinetBootstrapPrompt,
  buildTaskCompletionEntry,
  type CabinetConfig,
} from "./cabinet.js";

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const norm = value.trim().toLowerCase();
    if (norm === "true" || norm === "1") return true;
    if (norm === "false" || norm === "0") return false;
  }
  return fallback;
}

/**
 * Build the bootstrap prompt for hermes agent that includes Cabinet context.
 */
function buildHermesBootstrapPrompt(
  ctx: AdapterExecutionContext,
  cabinetConfig: CabinetConfig,
): string {
  const { runId, agent, context } = ctx;
  const agentName = asString(agent.name, "hermes-agent");

  // Build task description from context
  const taskParts: string[] = [];
  if (context.issueId) taskParts.push(`Issue: ${context.issueId}`);
  if (context.taskId) taskParts.push(`Task: ${context.taskId}`);
  if (context.wakeReason) taskParts.push(`Wake reason: ${context.wakeReason}`);
  const taskDescription = taskParts.join("; ") || `Agent run ${runId}`;

  // Build Cabinet bootstrap
  const cabinetBootstrap = buildCabinetBootstrapPrompt(cabinetConfig, {
    agentName,
    taskDescription,
    runId,
  });

  // Build Paperclip context
  const paperclipLines = [
    `## Paperclip Context`,
    ``,
    `Run ID: ${runId}`,
    `Agent: ${agentName} (${agent.id})`,
    `Company: ${agent.companyId}`,
  ];
  if (context.issueId) paperclipLines.push(`Issue ID: ${context.issueId}`);
  if (context.taskId) paperclipLines.push(`Task ID: ${context.taskId}`);
  if (context.wakeReason) paperclipLines.push(`Wake reason: ${context.wakeReason}`);
  paperclipLines.push("");

  return [paperclipLines.join("\n"), cabinetBootstrap].filter(Boolean).join("\n");
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Hermes adapter missing command");

  const args = asStringArray(config.args);
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };

  // Hermes-specific env vars
  const workspace = asString(config.workspace, "");
  if (workspace) {
    env.HERMES_WORKSPACE = workspace;
  }

  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  // Resolve Cabinet config
  const cabinetConfig = resolveCabinetConfig(config);

  // Build bootstrap prompt with Cabinet context
  const bootstrapPrompt = buildHermesBootstrapPrompt(ctx, cabinetConfig);

  // If Cabinet pull mode, try to read relevant memory before execution
  let cabinetContext = "";
  if (
    (cabinetConfig.memorySync === "pull" || cabinetConfig.memorySync === "bidirectional") &&
    cabinetConfig.slug
  ) {
    const readResult = await readMemory(cabinetConfig, "context.md");
    if (readResult.ok && readResult.content) {
      cabinetContext = `\n## Cabinet Memory (pre-loaded)\n\n${readResult.content}\n\n`;
    }
  }

  if (onMeta) {
    await onMeta({
      adapterType: "hermes_local",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
      prompt: bootstrapPrompt + cabinetContext,
    });
  }

  // Run the hermes process with the bootstrap prompt
  // The prompt is passed via PAPERCLIP_BOOTSTRAP_PROMPT env var
  if (bootstrapPrompt || cabinetContext) {
    env.PAPERCLIP_BOOTSTRAP_PROMPT = bootstrapPrompt + cabinetContext;
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });

  // Capture result output for Cabinet memory append
  const resultOutput = [proc.stdout, proc.stderr].filter(Boolean).join("\n").trim();
  const exitCode = proc.exitCode ?? 0;

  // Cabinet memory push: append task completion to Cabinet
  if (
    (cabinetConfig.memorySync === "push" || cabinetConfig.memorySync === "bidirectional") &&
    cabinetConfig.slug &&
    cabinetConfig.autoAppend
  ) {
    const agentName = asString(agent.name, "hermes-agent");
    const taskParts: string[] = [];
    if (ctx.context.issueId) taskParts.push(`Issue: ${ctx.context.issueId}`);
    if (ctx.context.taskId) taskParts.push(`Task: ${ctx.context.taskId}`);
    const taskDescription = taskParts.join("; ") || `Agent run ${runId}`;

    const entry = buildTaskCompletionEntry({
      agentName,
      runId,
      taskDescription,
      result: resultOutput.slice(0, 4000),
      exitCode,
    });

    // Fire-and-forget Cabinet append (don't block on Cabinet availability)
    appendMemory(cabinetConfig, entry).catch((err) => {
      if (onLog) {
        onLog("stderr", `[hermes_local] Cabinet append failed: ${err.message || err}`);
      }
    });
  }

  // Build runtime service reports for Cabinet status
  const runtimeServices: AdapterRuntimeServiceReport[] = [];
  if (cabinetConfig.memorySync !== "off" && cabinetConfig.slug) {
    runtimeServices.push({
      serviceId: `cabinet:${cabinetConfig.slug}`,
      label: "Cabinet Memory",
      status: "running",
      detail: `Slug: ${cabinetConfig.slug}, Sync: ${cabinetConfig.memorySync}`,
      endpoint: cabinetConfig.endpoint,
    });
  }

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      meta: {
        runtimeServices,
      },
    };
  }

  if (exitCode !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${exitCode}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
      meta: {
        runtimeServices,
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
    meta: {
      runtimeServices,
    },
  };
}
