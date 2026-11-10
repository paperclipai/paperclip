import type { AgentApiKeyScope } from "@paperclipai/shared";
import { forbidden } from "../../errors.js";

const taskTools = new Set([
  "get_identity", "get_task_context", "get_task_history", "get_task",
  "list_documents", "read_document", "list_document_revisions", "write_document",
  "list_task_documents", "read_task_document", "write_task_document", "comment_on_task",
  "report_progress", "set_task_title", "request_human_input", "register_deliverable",
  "list_assigned_skills", "read_assigned_skill", "search_api", "call_api",
  "read_current_wake_comments", "list_chat_attachments", "read_chat_attachment",
  "reuse_chat_attachment", "list_task_attachments", "read_task_attachment",
]);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

export function nativeRunKeyScope(input: {
  contextSnapshot?: unknown;
  issueId: string;
  workMode?: string;
}): AgentApiKeyScope {
  const snapshot = record(input.contextSnapshot);
  const admitted = record(snapshot.paperclipAgentJwtScope);
  const skillTest = admitted.kind === "skill_test" || (admitted.kind !== "standard"
    && (Boolean(snapshot.paperclipSkillTest) || input.workMode === "skill_test"
      || record(snapshot.paperclipIssue).workMode === "skill_test"));
  return skillTest ? { kind: "skill_test", issueId: input.issueId } : { kind: "standard" };
}

export function nativeSkillTestToolAllowed(tool: string) {
  return taskTools.has(tool);
}

export function assertNativeSkillTestTool(scope: AgentApiKeyScope, tool: string) {
  if (scope.kind === "skill_test" && !nativeSkillTestToolAllowed(tool)) {
    throw forbidden("Skill-test runs may only use their own harness task and admitted skill contents.");
  }
}
