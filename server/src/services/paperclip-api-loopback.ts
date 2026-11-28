/**
 * A dedicated agent tool's own call to the Paperclip HTTP API, authenticated
 * as the run, so the route's company, permission and activity rules apply to
 * the tool exactly as to a direct API call. Callers parse the response.
 */
export function fetchPaperclipApi(input: {
  apiUrl: string;
  token: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  fetcher?: typeof fetch;
}): Promise<Response> {
  const base = `${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api`;
  return (input.fetcher ?? fetch)(`${base}${input.path}`, {
    method: input.method,
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json", ...input.headers },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
}
