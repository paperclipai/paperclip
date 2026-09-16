/**
 * pi-acp 0.0.33 does not forward MCP servers to Pi. Install this runner-owned
 * extension in Pi's private global extension directory instead. The source is
 * self-contained so the verified provider needs no additional package imports.
 * Credentials are supplied only in the admitted child environment, never here.
 */
export const PI_RUNNER_TOOL_EXTENSION = String.raw`
export default async function paperclipRunnerTools(pi) {
  const endpoint = process.env.PAPERCLIP_PI_TOOL_BRIDGE_URL;
  const token = process.env.PAPERCLIP_PI_TOOL_BRIDGE_TOKEN;
  if (!endpoint && !token) return;
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      url.pathname !== "/mcp" || url.search || url.hash ||
      url.username || url.password || !token) {
    throw new Error("Invalid private Paperclip tool bridge");
  }
  const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };
  const maxBytes = 4 * 1024 * 1024;
  async function rpc(method, params, id, signal) {
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("Paperclip tool request is too large");
    const deadline = AbortSignal.timeout(120000);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const cancel = () => {
      if (method !== "tools/call") return;
      // Cancel the server operation as well as the HTTP read. A fresh short
      // deadline lets cancellation reach the bridge after the caller aborts.
      void fetch(url, {
        method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }),
      }).then(response => response.body?.cancel()).catch(() => {});
    };
    abort.throwIfAborted();
    abort.addEventListener("abort", cancel, { once: true });
    let reader;
    try {
      const response = await fetch(url, { method: "POST", headers, body, signal: abort, redirect: "error" });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("Paperclip tool bridge request failed (HTTP " + response.status + ")");
      }
      reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error("Paperclip tool response is too large");
        chunks.push(value);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (message.jsonrpc !== "2.0" || message.id !== id || message.error || !message.result) {
        throw new Error("Paperclip tool bridge returned an invalid response");
      }
      return message.result;
    } finally {
      abort.removeEventListener("abort", cancel);
      await reader?.cancel().catch(() => {});
    }
  }
  const catalog = await rpc("tools/list", {}, "pi-catalog");
  if (!Array.isArray(catalog.tools) || catalog.tools.length > 256) {
    throw new Error("Invalid Paperclip tool catalog");
  }
  const names = new Set();
  for (const tool of catalog.tools) {
    if (typeof tool.name !== "string" || !tool.name || names.has(tool.name) ||
        !tool.inputSchema || tool.inputSchema.type !== "object") {
      throw new Error("Invalid Paperclip tool definition");
    }
    names.add(tool.name);
  }
  for (const tool of catalog.tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description || tool.name,
      parameters: tool.inputSchema,
      async execute(callId, args, signal) {
        const result = await rpc("tools/call", { name: tool.name, arguments: args }, callId, signal);
        if (!Array.isArray(result.content)) throw new Error("Invalid Paperclip tool result");
        if (result.isError) {
          throw new Error(result.content.filter(item => item.type === "text").map(item => item.text).join("\n"));
        }
        return { content: result.content, details: {} };
      },
    });
  }
}
`;
