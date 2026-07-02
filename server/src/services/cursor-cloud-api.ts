type CursorRunSnapshot = {
  id: string;
  status: string;
  agentId: string;
  git?: {
    branches?: Array<{ repoUrl: string; branch?: string; prUrl?: string }>;
  };
};

export async function fetchCursorCloudRun(input: {
  apiKey: string;
  agentId: string;
  runId: string;
  fetchImpl?: typeof fetch;
}): Promise<CursorRunSnapshot | null> {
  const fetchFn = input.fetchImpl ?? fetch;
  const url = `https://api.cursor.com/v1/agents/${encodeURIComponent(input.agentId)}/runs/${encodeURIComponent(input.runId)}`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id : input.runId;
  const status = typeof body.status === "string" ? body.status : "unknown";
  const agentId = typeof body.agentId === "string" ? body.agentId : input.agentId;
  return {
    id,
    status,
    agentId,
    git: body.git as CursorRunSnapshot["git"],
  };
}
