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
