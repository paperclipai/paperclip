export function getConfig() {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!apiUrl || !companyId) throw new Error("Missing PAPERCLIP_API_URL or PAPERCLIP_COMPANY_ID");
  return { apiUrl, apiKey: apiKey ?? "", companyId };
}

async function api(method: string, path: string, body?: unknown) {
  const { apiUrl, apiKey } = getConfig();
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function findOrCreateDailyIssue(agentId: string): Promise<{ id: string }> {
  const { companyId } = getConfig();
  const today = new Date().toISOString().slice(0, 10);
  const title = `Daily Report ${today}`;

  const result = await api("GET", `/api/companies/${companyId}/issues?search=${encodeURIComponent(title)}&status=backlog,in_progress`);
  const items = Array.isArray(result) ? result : result?.items ?? [];
  const existing = items.find((i: any) => i.title === title);
  if (existing) return existing;

  return api("POST", `/api/companies/${companyId}/issues`, {
    title,
    body: `Automated daily report for ${today}`,
    status: "backlog",
    createdByAgentId: agentId,
  });
}

export async function addComment(issueId: string, body: string): Promise<void> {
  await api("POST", `/api/issues/${issueId}/comments`, { body });
}

export async function getComments(issueId: string): Promise<Array<{ id: string; body: string; authorAgentId: string | null }>> {
  const result = await api("GET", `/api/issues/${issueId}/comments`);
  return Array.isArray(result) ? result : result?.items ?? [];
}

export async function closeIssue(issueId: string): Promise<void> {
  await api("PATCH", `/api/issues/${issueId}`, { status: "done" });
}
