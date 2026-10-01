const HONEYCOMB_QUERY_URL =
  "https://ui.honeycomb.io/paperclip/environments/test/datasets/paperclip/";

export const HONEYCOMB_RUN_HASH_ATTRIBUTE = "paperclip.task.run.run_id";

export async function hashPaperclipRunId(
  runId: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(runId),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 12);
}

export function buildHoneycombRunQueryUrl(runIdHash: string): string {
  const query = {
    time_range: 60 * 60 * 24 * 7,
    granularity: 0,
    calculations: [{ op: "COUNT" }],
    breakdowns: ["trace.trace_id"],
    filters: [
      { column: "service.name", op: "=", value: "paperclip" },
      { column: "name", op: "=", value: "task.run" },
      { column: HONEYCOMB_RUN_HASH_ATTRIBUTE, op: "=", value: runIdHash },
    ],
    filter_combination: "AND",
    orders: [],
    havings: [],
    limit: 100,
  };
  const url = new URL(HONEYCOMB_QUERY_URL);
  url.searchParams.set("query", JSON.stringify(query));
  return url.toString();
}

export async function buildHoneycombRunUrl(
  runId: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  return buildHoneycombRunQueryUrl(await hashPaperclipRunId(runId, subtle));
}
