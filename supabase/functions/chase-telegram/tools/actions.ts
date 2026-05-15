import { escapeHtml, issueLink } from "../lib/html.ts";
import { paperclipGet, paperclipPost } from "../lib/api.ts";
import type { PaperclipAgent, PaperclipIssue, QueryResult } from "../types.ts";

const COMPANY_ID = Deno.env.get("PAPERCLIP_COMPANY_ID") ?? "";

export async function handleCreateIssue(params: {
  title: string;
  description?: string;
  assigneeName?: string;
}): Promise<QueryResult> {
  let assigneeAgentId: string | undefined;
  if (params.assigneeName) {
    const agents = await paperclipGet<PaperclipAgent[]>(
      `/api/companies/${COMPANY_ID}/agents`,
    );
    const nameLower = params.assigneeName.toLowerCase();
    const agent = agents.find(
      (a) => a.name.toLowerCase().includes(nameLower),
    );
    if (agent) {
      assigneeAgentId = agent.id;
    }
  }

  const body: Record<string, unknown> = {
    title: params.title,
    description: params.description ?? "",
    priority: "medium",
    status: "todo",
  };
  if (assigneeAgentId) {
    body.assigneeAgentId = assigneeAgentId;
  }

  const issue = await paperclipPost<PaperclipIssue>(
    `/api/companies/${COMPANY_ID}/issues`,
    body,
  );

  const lines = [
    `<b>Issue Created</b>`,
    "",
    `${issueLink(issue.identifier)} — ${escapeHtml(issue.title)}`,
  ];
  if (params.assigneeName && assigneeAgentId) {
    lines.push(`Assigned to: ${escapeHtml(params.assigneeName)}`);
  }

  return { text: lines.join("\n") };
}
