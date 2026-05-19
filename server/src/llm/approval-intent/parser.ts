import { callWithToolUse } from "./client.js";

export interface ParsedOverride {
  jira: {
    action: "default" | "skip" | "transition" | "reassign";
    transition?: string;
    assignee?: string;
  };
  rawIntentSummary: string;
}

const DEFAULT_RESULT: ParsedOverride = {
  jira: { action: "default" },
  rawIntentSummary: "",
};

const UNAVAILABLE_RESULT: ParsedOverride = {
  jira: { action: "default" },
  rawIntentSummary: "<<llm-unavailable>>",
};

// LLM_INTENT_PROVIDER=noop short-circuits all LLM calls (used in CI)
function isNoopProvider(): boolean {
  return process.env.LLM_INTENT_PROVIDER === "noop";
}

export async function parseApprovalIntent(comment: string): Promise<ParsedOverride> {
  if (!comment || !comment.trim()) {
    return DEFAULT_RESULT;
  }

  if (isNoopProvider()) {
    return DEFAULT_RESULT;
  }

  try {
    const result = await callWithToolUse(comment);
    return {
      jira: {
        action: result.action,
        transition: result.transition,
        assignee: result.assignee,
      },
      rawIntentSummary: result.rawIntentSummary,
    };
  } catch {
    // LLM being unavailable must NEVER block approvals
    return UNAVAILABLE_RESULT;
  }
}
