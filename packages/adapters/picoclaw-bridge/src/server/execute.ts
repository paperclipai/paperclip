import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  runChildProcess,
  buildPaperclipEnv,
  asNumber,
  asString,
  asStringArray,
  parseObject,
  stringifyPaperclipWakePayload,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";

async function readPicoSkillContent(agentId: string): Promise<string | null> {
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  const skillPath = path.join(
    os.homedir(),
    ".paperclip",
    "instances",
    instanceId,
    "workspaces",
    agentId,
    "skills",
    "paperclip",
    "SKILL.md",
  );
  try {
    return await fs.readFile(skillPath, "utf-8");
  } catch {
    return null;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, agent, runId, context, onLog, authToken } = ctx;

  const command = asString(config.command, "picoclaw");
  const cwd = asString(config.cwd, os.homedir());
  const timeoutSec = asNumber(config.timeoutSec, 300);
  const graceSec = asNumber(config.graceSec, 10);
  const model = asString(config.model, "");
  const extraArgs = asStringArray(config.extraArgs);

  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake);
  const basePrompt = renderTemplate(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE, { agent });
  const skillContent = await readPicoSkillContent(agent.id);
  const skillPreamble = skillContent
    ? `${skillContent}\n\n## Begin Heartbeat\n\n`
    : `You have a "paperclip" skill installed in your workspace. Load it first with your skills tool, then follow the heartbeat procedure it describes.\n\n`;
  const prompt = skillPreamble + basePrompt + (wakePrompt ? `\n\n${wakePrompt}` : "");

  const configEnv = parseObject(config.env);
  const hasExplicitApiKey =
    typeof configEnv.PAPERCLIP_API_KEY === "string" && configEnv.PAPERCLIP_API_KEY.trim().length > 0;

  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  if (!hasExplicitApiKey && authToken) env.PAPERCLIP_API_KEY = authToken;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim()
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim()
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim()
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  for (const [k, v] of Object.entries(configEnv)) {
    if (typeof v === "string") env[k] = v;
  }

  const args = ["agent", "--session", `paperclip-${runId}`, "-m", prompt];
  if (model) args.push("--model", model);
  if (extraArgs.length > 0) args.push(...extraArgs);

  const result = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
  });

  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
  };
}
