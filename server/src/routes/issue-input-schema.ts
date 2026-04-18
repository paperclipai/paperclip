import { z } from "zod";
import { createIssueSchema } from "@paperclipai/shared";

/**
 * Wraps createIssueSchema with a preprocessor that aliases the common LLM
 * mistake of sending `assigneeId` instead of `assigneeAgentId`. Without this,
 * Zod silently strips the unknown field and the issue is created with no
 * assignee and no wakeup — silent delegation failure.
 *
 * @see https://github.com/paperclipai/paperclip/issues/3458
 */
export const createIssueInputSchema = z.preprocess((input) => {
  if (typeof input !== "object" || input === null) return input;
  const data = input as Record<string, unknown>;
  if (data.assigneeId !== undefined && data.assigneeAgentId === undefined) {
    const { assigneeId, ...rest } = data;
    return { ...rest, assigneeAgentId: assigneeId };
  }
  return input;
}, createIssueSchema);
