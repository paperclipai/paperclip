import type { EvalBraintrustConfig } from "./braintrust.js";

export async function queryBraintrustRows(config: EvalBraintrustConfig, sql: string, transport: typeof fetch, signal: AbortSignal): Promise<Record<string, unknown>[]> {
  const response = await transport("https://api.braintrust.dev/btql", {
    method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query: sql, fmt: "json" }),
  });
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    if (!response.ok) throw new Error("query_rejected");
    while (reader) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; if (size > 1_048_576) throw new Error("query_oversized");
      chunks.push(next.value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!payload || !Array.isArray(payload.data) || payload.data.some((row: unknown) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("invalid_query_result");
    return payload.data;
  } finally { await reader?.cancel().catch(() => {}); }
}

