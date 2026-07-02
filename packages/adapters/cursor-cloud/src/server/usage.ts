export type CursorRunUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
};

type FetchCursorRunUsageInput = {
  apiKey: string;
  agentId: string;
  runId: string;
  fetchImpl?: typeof fetch;
};

export async function fetchCursorRunUsage(
  input: FetchCursorRunUsageInput,
): Promise<CursorRunUsage | null> {
  const fetchFn = input.fetchImpl ?? fetch;
  const url = new URL(
    `https://api.cursor.com/v1/agents/${encodeURIComponent(input.agentId)}/usage`,
  );
  url.searchParams.set("runId", input.runId);

  const res = await fetchFn(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) return null;

  const body = (await res.json()) as {
    runs?: Array<{
      runId?: string;
      usage?: Partial<CursorRunUsage>;
    }>;
  };

  const entry = body.runs?.find((r) => r.runId === input.runId) ?? body.runs?.[0];
  const u = entry?.usage;
  if (!u) return null;

  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheWriteTokens: u.cacheWriteTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    totalTokens: u.totalTokens ?? 0,
  };
}

export function mapUsageToAdapterResult(usage: CursorRunUsage) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cacheReadTokens,
  };
}
