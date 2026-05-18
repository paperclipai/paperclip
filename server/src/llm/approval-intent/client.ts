import Anthropic from "@anthropic-ai/sdk";
import { PARSE_APPROVAL_OVERRIDE_TOOL, parseApprovalOverrideTool } from "./tools.js";

// Model is spec-mandated — do not change to alias
const MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 5_000;

export interface ToolUseResult {
  action: "default" | "skip" | "transition" | "reassign";
  transition?: string;
  assignee?: string;
  rawIntentSummary: string;
}

const SYSTEM_PROMPT = `You are an approval intent classifier for a code review system.
Given a reviewer's comment on an approval request, classify their intent regarding Jira ticket handling.
Use ONLY the parse_approval_override tool. Do not add prose outside the tool call.`;

export async function callWithToolUse(comment: string): Promise<ToolUseResult> {
  const client = new Anthropic();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        tools: [parseApprovalOverrideTool],
        tool_choice: { type: "tool", name: PARSE_APPROVAL_OVERRIDE_TOOL },
        messages: [
          {
            role: "user",
            content: `Approval comment: "${comment}"`,
          },
        ],
      },
      { signal: controller.signal },
    );

    const toolUseBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
      return { action: "default", rawIntentSummary: "<<no-tool-use>>" };
    }

    const input = toolUseBlock.input as Record<string, unknown>;
    return {
      action: (input.action as ToolUseResult["action"]) ?? "default",
      transition: input.transition as string | undefined,
      assignee: input.assignee as string | undefined,
      rawIntentSummary: (input.rawIntentSummary as string) ?? "",
    };
  } finally {
    clearTimeout(timer);
  }
}
