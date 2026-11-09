const ACCESS_DISABLED_MESSAGE = "App is not enabled for Slack MCP server access.";
const MAX_ERROR_BYTES = 8 * 1024;

/** Recognize only Slack's documented-endpoint response for missing app setup.
 * Never return provider text or its embedded account/settings links to callers. */
export async function isSlackMcpAccessDisabledResponse(
  endpoint: string,
  response: Response,
): Promise<boolean> {
  const url = new URL(endpoint);
  if (url.origin !== "https://mcp.slack.com" || url.pathname !== "/mcp"
    || response.status !== 400
    || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return false;

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
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const error = payload?.error;
    return payload?.jsonrpc === "2.0" && error?.code === -32600
      && typeof error.message === "string"
      && (error.message === ACCESS_DISABLED_MESSAGE || error.message.startsWith(`${ACCESS_DISABLED_MESSAGE} `));
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
