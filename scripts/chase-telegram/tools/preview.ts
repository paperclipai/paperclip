import { escapeHtml } from "../lib/html.ts";

export function formatTaskPreview(params: {
  title: string;
  assigneeDisplay?: string;
  description?: string;
}): string {
  const lines = [
    "I can create that task.",
    "",
    `<b>Title:</b> ${escapeHtml(params.title)}`,
  ];
  if (params.assigneeDisplay) {
    lines.push(`<b>Assignee:</b> ${escapeHtml(params.assigneeDisplay)}`);
  }
  if (params.description) {
    lines.push(`<b>Details:</b> ${escapeHtml(params.description)}`);
  }
  lines.push(
    "",
    "Create this task?",
    "Reply <b>YES</b> to create, or <b>CANCEL</b> to cancel.",
  );
  return lines.join("\n");
}

export function formatAssigneePrompt(params: {
  title: string;
  description?: string;
}): string {
  const lines = [
    "Who should own this task?",
    "",
    `<b>Title:</b> ${escapeHtml(params.title)}`,
  ];
  if (params.description) {
    lines.push(`<b>Details:</b> ${escapeHtml(params.description)}`);
  }
  lines.push(
    "",
    "Reply with an agent name (e.g. <b>Hunter</b>), or reply <b>UNASSIGNED</b> to create it without an assignee.",
  );
  return lines.join("\n");
}
