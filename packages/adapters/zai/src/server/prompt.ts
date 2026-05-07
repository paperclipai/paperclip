import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import type { ZaiMessage } from "../shared/types.js";
import type { ResolvedZaiConfig } from "../shared/config.js";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Build the messages array that will be sent to Z.AI.
 *
 * Order:
 *   1. config.systemPrompt (if present) plus any skill markdown addendum,
 *      merged into a single role=system message.
 *   2. config.messages[] (pre-seeded conversation, e.g. tool_result history).
 *   3. A final user message that combines:
 *      - any configured promptTemplate / message,
 *      - the Paperclip wake text (task context, issueId, wakeReason, etc),
 *      - the structured wake payload as JSON when available.
 */
export function buildMessages(
  ctx: AdapterExecutionContext,
  config: ResolvedZaiConfig,
  options: { skillsAddendum?: string } = {},
): ZaiMessage[] {
  const messages: ZaiMessage[] = [];

  const skillsAddendum = options.skillsAddendum?.trim() ?? "";
  const systemParts: string[] = [];
  if (config.systemPrompt && config.systemPrompt.trim().length > 0) {
    systemParts.push(config.systemPrompt.trim());
  }
  if (skillsAddendum.length > 0) {
    systemParts.push(skillsAddendum);
  }
  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }

  for (const extra of config.extraMessages) {
    messages.push(extra);
  }

  const cfg = parseObject(ctx.agent.adapterConfig);
  const templateMessage =
    nonEmpty(cfg.message) ??
    nonEmpty(cfg.prompt) ??
    nonEmpty(cfg.promptTemplate) ??
    null;

  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake);
  const wakeJson = stringifyPaperclipWakePayload(ctx.context.paperclipWake);

  const paperclipContext = {
    runId: ctx.runId,
    agentId: ctx.agent.id,
    agentName: ctx.agent.name,
    companyId: ctx.agent.companyId,
    taskId: nonEmpty(ctx.context.taskId),
    issueId: nonEmpty(ctx.context.issueId),
    wakeReason: nonEmpty(ctx.context.wakeReason),
    wakeCommentId: nonEmpty(ctx.context.wakeCommentId) ?? nonEmpty(ctx.context.commentId),
  };

  const sections: string[] = [];
  if (templateMessage) sections.push(templateMessage);
  if (wakePrompt) sections.push(wakePrompt);
  if (wakeJson) sections.push(`Structured wake payload JSON:\n\`\`\`json\n${wakeJson}\n\`\`\``);
  sections.push(`Paperclip run context JSON:\n\`\`\`json\n${JSON.stringify(paperclipContext, null, 2)}\n\`\`\``);

  const finalUser = sections.join("\n\n").trim();
  messages.push({
    role: "user",
    content: finalUser.length > 0 ? finalUser : asString(ctx.context.prompt, "Continue the assigned task."),
  });

  return messages;
}
