import os from "node:os";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  runChildProcess,
  buildPaperclipEnv,
  asNumber,
  asString,
} from "@paperclipai/adapter-utils/server-utils";

function buildPrompt(context: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof context.taskTitle === "string") parts.push(`Task: ${context.taskTitle}`);
  if (typeof context.taskBody === "string" && context.taskBody) parts.push(context.taskBody);
  if (Array.isArray(context.comments)) {
    for (const c of context.comments) {
      if (typeof c?.body === "string") parts.push(`Comment: ${c.body}`);
    }
  }
  return parts.join("\n\n") || "No task context provided.";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, agent, runId, context, onLog } = ctx;
  const cwd = asString(config.cwd, os.homedir());
  const timeoutSec = asNumber(config.timeoutSec, 300);
  const prompt = buildPrompt(context);
  const env = buildPaperclipEnv(agent);

  const result = await runChildProcess(
    runId,
    "picoclaw",
    ["agent", "--session", `paperclip-${runId}`, "-m", prompt],
    { cwd, env, timeoutSec, graceSec: 10, onLog },
  );

  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
  };
}
