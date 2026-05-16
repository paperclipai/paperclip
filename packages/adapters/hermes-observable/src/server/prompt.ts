import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildPaperclipEnv, renderTemplate } from "@paperclipai/adapter-utils/server-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function renderWakePayload(context: Record<string, unknown>): string {
  const wakePayload = asRecord(context.paperclipWake);
  if (wakePayload) {
    return JSON.stringify(wakePayload, null, 2);
  }

  const reduced = {
    issueId: asString(context.issueId) || asString(context.taskId) || null,
    taskId: asString(context.taskId) || null,
    wakeReason: asString(context.wakeReason) || null,
    wakeCommentId: asString(context.wakeCommentId) || null,
    commentId: asString(context.commentId) || null,
  };
  return JSON.stringify(reduced, null, 2);
}

function buildExportBlock(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
}

const DEFAULT_INPUT_TEMPLATE = `Current Paperclip heartbeat wake:
{{wakePayload}}

Paperclip runtime env exports for this run:

\`\`\`bash
{{paperclipExportBlock}}
\`\`\`

Execution requirements:

1. Treat the wake payload above as the highest-priority context for this heartbeat.
2. If a task is assigned, use GET {{paperclipApiUrl}}/issues/{{taskId}}/heartbeat-context before broad exploration unless the wake payload already answers the question.
3. Work inside {{workspaceDir}} when repo changes are needed.
4. Start actionable work in the same heartbeat and do not stop at a plan unless the issue explicitly asks for planning.
5. Post a task comment with durable progress before you exit.
`;

const DEFAULT_SYSTEM_INSTRUCTIONS = `You are a Hermes agent working inside Paperclip.

Operational rules:

- Start concrete work in the same heartbeat when the issue is actionable.
- Do not stop at a plan unless planning was explicitly requested.
- Leave durable progress in issue comments, documents, or work products before exit.
- If blocked, update the issue with the unblock owner and action.
- Use Authorization: Bearer $PAPERCLIP_API_KEY for every Paperclip API request.
- Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every Paperclip API write.
- Do not use a browser or board session to write to the Paperclip API when terminal + curl is available.
`;

export interface HermesPromptBundle {
  instructions: string;
  input: string;
  commandNotes: string[];
  promptMetrics: Record<string, number>;
}

export async function buildHermesObservablePrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): Promise<HermesPromptBundle> {
  const commandNotes: string[] = [];
  const context = asRecord(ctx.context) ?? {};
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    PAPERCLIP_RUN_ID: ctx.runId,
    ...(asString(context.taskId) || asString(context.issueId)
      ? { PAPERCLIP_TASK_ID: asString(context.taskId) || asString(context.issueId) }
      : {}),
    ...(asString(context.wakeReason) ? { PAPERCLIP_WAKE_REASON: asString(context.wakeReason) } : {}),
    ...(asString(context.wakeCommentId)
      ? { PAPERCLIP_WAKE_COMMENT_ID: asString(context.wakeCommentId) }
      : {}),
    ...(ctx.authToken ? { PAPERCLIP_API_KEY: ctx.authToken } : {}),
    ...(asString(config.cwd) ? { PAPERCLIP_WORKSPACE_CWD: asString(config.cwd) } : {}),
  };

  const paperclipApiUrl = paperclipEnv.PAPERCLIP_API_URL.replace(/\/+$/, "") + "/api";
  const workspaceDir = asString(config.cwd) || process.cwd();
  const wakePayload = renderWakePayload(context);
  const exportBlock = buildExportBlock(paperclipEnv);

  const vars: Record<string, unknown> = {
    agentId: ctx.agent.id,
    agentName: ctx.agent.name,
    companyId: ctx.agent.companyId,
    runId: ctx.runId,
    taskId: asString(context.taskId) || asString(context.issueId),
    wakeReason: asString(context.wakeReason),
    wakeCommentId: asString(context.wakeCommentId),
    paperclipApiUrl,
    paperclipExportBlock: exportBlock,
    wakePayload,
    workspaceDir,
  };

  let instructions = DEFAULT_SYSTEM_INSTRUCTIONS;
  const instructionsFilePath = asString(config.instructionsFilePath).trim();
  if (instructionsFilePath) {
    const resolvedInstructionsPath = path.resolve(workspaceDir, instructionsFilePath);
    try {
      const fileContents = await readFile(resolvedInstructionsPath, "utf8");
      instructions = `${instructions}

${fileContents}

The above agent instructions were loaded from ${resolvedInstructionsPath}. Resolve any relative file references from ${path.dirname(resolvedInstructionsPath)}/.`;
      commandNotes.push(`Loaded instructions from ${resolvedInstructionsPath}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      commandNotes.push(`Configured instructionsFilePath ${resolvedInstructionsPath}, but file could not be read.`);
      instructions = `${instructions}

Warning: configured instructionsFilePath ${resolvedInstructionsPath} could not be read (${reason}).`;
    }
  }

  const inputTemplate = asString(config.promptTemplate).trim() || DEFAULT_INPUT_TEMPLATE;
  const input = renderTemplate(inputTemplate, vars);

  return {
    instructions,
    input,
    commandNotes,
    promptMetrics: {
      instructionsChars: instructions.length,
      inputChars: input.length,
      wakePayloadChars: wakePayload.length,
    },
  };
}
