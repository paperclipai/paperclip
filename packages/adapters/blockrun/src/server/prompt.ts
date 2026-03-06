interface AgentInfo {
  id: string;
  name: string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function buildSystemPrompt(
  agent: AgentInfo,
  context: Record<string, unknown>,
  customSystemPrompt: string,
): string {
  const parts: string[] = [];

  parts.push(`You are "${agent.name}", an AI agent operating within the Paperclip orchestration system.`);
  parts.push("");

  if (customSystemPrompt) {
    parts.push(customSystemPrompt);
    parts.push("");
  }

  parts.push("## Your Operating Protocol");
  parts.push("");
  parts.push("When you receive a task:");
  parts.push("1. Analyze the task requirements and context thoroughly.");
  parts.push("2. Provide clear, actionable analysis and recommendations.");
  parts.push("3. If you can produce deliverables (text, plans, code snippets), include them.");
  parts.push("4. Note any blockers, dependencies, or questions that need resolution.");
  parts.push("5. Suggest concrete next steps.");
  parts.push("");
  parts.push("Respond concisely and focus on delivering value. Avoid filler.");

  return parts.join("\n");
}

export function buildUserPrompt(context: Record<string, unknown>): string {
  const parts: string[] = [];

  const wakeReason = nonEmpty(context.wakeReason);
  if (wakeReason) {
    parts.push(`[Wake Reason: ${wakeReason}]`);
    parts.push("");
  }

  const issueTitle = nonEmpty(context.issueTitle) ?? nonEmpty(context.taskTitle);
  if (issueTitle) {
    parts.push(`## Task: ${issueTitle}`);
    parts.push("");
  }

  const issueStatus = nonEmpty(context.issueStatus) ?? nonEmpty(context.taskStatus);
  const issuePriority = nonEmpty(context.issuePriority) ?? nonEmpty(context.taskPriority);
  if (issueStatus || issuePriority) {
    const meta: string[] = [];
    if (issueStatus) meta.push(`Status: ${issueStatus}`);
    if (issuePriority) meta.push(`Priority: ${issuePriority}`);
    parts.push(meta.join(" | "));
    parts.push("");
  }

  const issueBody = nonEmpty(context.issueBody) ?? nonEmpty(context.taskDescription);
  if (issueBody) {
    parts.push("### Description");
    parts.push(issueBody);
    parts.push("");
  }

  const parentTitle = nonEmpty(context.parentIssueTitle);
  if (parentTitle) {
    parts.push(`### Parent Task: ${parentTitle}`);
    const parentBody = nonEmpty(context.parentIssueBody);
    if (parentBody) {
      parts.push(parentBody);
    }
    parts.push("");
  }

  const ancestry = nonEmpty(context.issueAncestry);
  if (ancestry) {
    parts.push("### Task Ancestry (Context Chain)");
    parts.push(ancestry);
    parts.push("");
  }

  const wakeComment = nonEmpty(context.wakeCommentBody);
  if (wakeComment) {
    const commentAuthor = nonEmpty(context.wakeCommentAuthor) ?? "someone";
    parts.push(`### Triggering Comment (from ${commentAuthor})`);
    parts.push(wakeComment);
    parts.push("");
  }

  const approvalStatus = nonEmpty(context.approvalStatus);
  if (approvalStatus) {
    parts.push(`### Approval Status: ${approvalStatus}`);
    const approvalNotes = nonEmpty(context.approvalNotes);
    if (approvalNotes) {
      parts.push(approvalNotes);
    }
    parts.push("");
  }

  // Fallback if no structured context was available
  if (parts.length === 0 || (parts.length === 2 && wakeReason)) {
    const prompt = nonEmpty(context.prompt) ?? nonEmpty(context.bootstrapPrompt);
    if (prompt) {
      parts.push(prompt);
    } else {
      parts.push("You have been woken for a heartbeat. Check your assignments and report status.");
    }
  }

  parts.push("");
  parts.push("Process this task and provide your output.");

  return parts.join("\n");
}
