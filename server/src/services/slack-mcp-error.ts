const ACCESS_DISABLED_MESSAGE = "App is not enabled for Slack MCP server access.";
const MAX_ERROR_BYTES = 8 * 1024;

/** Recognize only Slack's documented-endpoint response for missing app setup.
 * Never return provider text or its embedded account/settings links to callers. */
export async function isSlackMcpAccessDisabledResponse(
  endpoint: string,
  response: Response,
): Promise<boolean> {
  const url = new URL(endpoint);
  // A streamable-HTTP MCP endpoint may answer either as JSON or as an event
  // stream, and Slack picks per request. Requiring `application/json` alone
  // drops the recognition on an `text/event-stream` reply, and the operator
  // is told "Remote app returned HTTP 400" instead of which setting to change.
  // The body is still parsed strictly below, so widening this only decides
  // whether the payload is read at all.
  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (url.origin !== "https://mcp.slack.com" || url.pathname !== "/mcp"
    || response.status !== 400
    || (contentType !== "application/json" && contentType !== "text/event-stream")) return false;

  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, 2_000);
  timeout.unref();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) return false;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ERROR_BYTES) return false;
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    // An event-stream reply carries the same JSON-RPC object inside SSE
    // framing, so take the `data:` payloads when that is what arrived.
    const candidates =
      contentType === "text/event-stream"
        ? body
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trim())
        : [body];
    return candidates.some((candidate) => {
      let payload: { jsonrpc?: unknown; error?: { code?: unknown; message?: unknown } };
      try {
        payload = JSON.parse(candidate);
      } catch {
        return false;
      }
      const error = payload?.error;
      return payload?.jsonrpc === "2.0" && error?.code === -32600
        && typeof error.message === "string"
        && (error.message === ACCESS_DISABLED_MESSAGE || error.message.startsWith(`${ACCESS_DISABLED_MESSAGE} `));
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
