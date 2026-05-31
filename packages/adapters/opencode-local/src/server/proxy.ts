/**
 * Transparent HTTP normalization proxy for the opencode-local adapter.
 *
 * When a model (e.g. qwen3:30b-a3b in thinking mode) omits the `description`
 * field from bash tool-call arguments, opencode rejects with:
 *   SchemaError(Missing key at ["description"])
 *
 * This proxy sits between opencode and Ollama (or any OpenAI-compat upstream).
 * For /chat/completions streaming (SSE) responses it:
 *   1. Buffers the full SSE body.
 *   2. Reconstructs accumulated tool-call arguments from the delta stream.
 *   3. If a bash tool call has `command` but no `description`, injects `description: ""`.
 *   4. Re-emits the (possibly patched) SSE body to opencode.
 *
 * For all other paths (non-completions, non-streaming) the response is
 * forwarded byte-for-byte unchanged. Blast radius is therefore zero for any
 * model that already includes `description` correctly.
 */

import http from "node:http";
import net from "node:net";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ToolCallAcc {
  id: string;
  type: string;
  name: string;
  args: string;
}

// ---------------------------------------------------------------------------
// SSE parsing helpers
// ---------------------------------------------------------------------------

/**
 * Walk every SSE data line and accumulate tool-call argument strings indexed
 * by their `index` field. This handles the common streaming pattern where
 * `name` and `arguments` arrive in separate delta chunks.
 */
function buildToolCallMap(sseBody: string): Map<number, ToolCallAcc> {
  const toolCalls = new Map<number, ToolCallAcc>();
  for (const line of sseBody.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(line.slice(6)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices as Array<Record<string, unknown>>) {
      const delta =
        typeof choice.delta === "object" && choice.delta !== null
          ? (choice.delta as Record<string, unknown>)
          : {};
      const tcs = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const tc of tcs as Array<Record<string, unknown>>) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        if (!toolCalls.has(idx)) {
          toolCalls.set(idx, { id: "", type: "function", name: "", args: "" });
        }
        const acc = toolCalls.get(idx)!;
        if (typeof tc.id === "string" && tc.id) acc.id = tc.id;
        if (typeof tc.type === "string" && tc.type) acc.type = tc.type;
        const fn =
          typeof tc.function === "object" && tc.function !== null
            ? (tc.function as Record<string, unknown>)
            : {};
        if (typeof fn.name === "string") acc.name += fn.name;
        if (typeof fn.arguments === "string") acc.args += fn.arguments;
      }
    }
  }
  return toolCalls;
}

/**
 * Returns true if at least one bash tool call is missing the `description`
 * field while having a `command` field.
 */
export function needsBashDescriptionPatch(toolCalls: Map<number, ToolCallAcc>): boolean {
  for (const [, tc] of toolCalls) {
    if (tc.name.toLowerCase() !== "bash") continue;
    try {
      const args = JSON.parse(tc.args) as Record<string, unknown>;
      if (typeof args.command === "string" && !("description" in args)) return true;
    } catch {
      // unparseable arguments — skip
    }
  }
  return false;
}

/**
 * Mutates `toolCalls` in-place: injects `description: ""` into bash tool
 * calls that have `command` but no `description`.
 */
function patchToolCallArgs(toolCalls: Map<number, ToolCallAcc>): void {
  for (const [, tc] of toolCalls) {
    if (tc.name.toLowerCase() !== "bash") continue;
    try {
      const args = JSON.parse(tc.args) as Record<string, unknown>;
      if (typeof args.command === "string" && !("description" in args)) {
        args.description = "";
        tc.args = JSON.stringify(args);
      }
    } catch {
      // unparseable — leave as-is
    }
  }
}

/** Extract stream metadata from the first parseable SSE data line. */
function extractSseMeta(
  sseBody: string,
): { id?: string; created?: number; model?: string; system_fingerprint?: string } {
  for (const line of sseBody.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const chunk = JSON.parse(line.slice(6)) as Record<string, unknown>;
      return {
        id: typeof chunk.id === "string" ? chunk.id : undefined,
        created: typeof chunk.created === "number" ? chunk.created : undefined,
        model: typeof chunk.model === "string" ? chunk.model : undefined,
        system_fingerprint:
          typeof chunk.system_fingerprint === "string"
            ? chunk.system_fingerprint
            : undefined,
      };
    } catch {
      continue;
    }
  }
  return {};
}

/**
 * Reconstruct a minimal valid SSE body from the (patched) accumulated tool
 * calls. The AI SDK only needs three chunks: role assignment, tool-call
 * arguments, and finish_reason.
 */
export function reconstructSse(
  sseBody: string,
  toolCalls: Map<number, ToolCallAcc>,
): string {
  const meta = extractSseMeta(sseBody);
  const base = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    ...(meta.system_fingerprint ? { system_fingerprint: meta.system_fingerprint } : {}),
  };

  const toolCallsArr = Array.from(toolCalls.entries()).map(([idx, tc]) => ({
    index: idx,
    ...(tc.id ? { id: tc.id } : {}),
    type: tc.type || "function",
    function: { name: tc.name, arguments: tc.args },
  }));

  const chunks = [
    JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }),
    JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { tool_calls: toolCallsArr }, finish_reason: null }],
    }),
    JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }),
  ];

  return chunks.map((c) => `data: ${c}`).join("\n\n") + "\n\ndata: [DONE]\n\n";
}

/**
 * Inspect a full SSE body and, if any bash tool call is missing `description`,
 * return a patched SSE body; otherwise return the original unchanged.
 */
export function maybePatchSseBody(sseBody: string): string {
  const toolCalls = buildToolCallMap(sseBody);
  if (!needsBashDescriptionPatch(toolCalls)) return sseBody;
  patchToolCallArgs(toolCalls);
  return reconstructSse(sseBody, toolCalls);
}

/**
 * Inspect a non-streaming JSON completions response body and, if any bash
 * tool call is missing `description`, inject `description: ""`.
 */
export function maybePatchJsonBody(jsonBody: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonBody) as Record<string, unknown>;
  } catch {
    return jsonBody;
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  let patched = false;
  for (const choice of choices as Array<Record<string, unknown>>) {
    const message =
      typeof choice.message === "object" && choice.message !== null
        ? (choice.message as Record<string, unknown>)
        : {};
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const tc of toolCalls as Array<Record<string, unknown>>) {
      const fn =
        typeof tc.function === "object" && tc.function !== null
          ? (tc.function as Record<string, unknown>)
          : {};
      if (typeof fn.name !== "string" || fn.name.toLowerCase() !== "bash") continue;
      if (typeof fn.arguments !== "string") continue;
      try {
        const args = JSON.parse(fn.arguments) as Record<string, unknown>;
        if (typeof args.command === "string" && !("description" in args)) {
          args.description = "";
          fn.arguments = JSON.stringify(args);
          patched = true;
        }
      } catch {
        // unparseable — leave as-is
      }
    }
  }

  return patched ? JSON.stringify(parsed) : jsonBody;
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

/**
 * Start a local HTTP normalization proxy that forwards all requests to
 * `upstreamBaseUrl` and patches bash tool-call arguments in
 * `/chat/completions` responses when `description` is absent.
 *
 * Returns the base URL to inject into opencode's Ollama provider config (e.g.
 * `http://127.0.0.1:<port>/v1`) and a `stop()` function to shut down the
 * server.
 */
export async function startBashToolNormalizationProxy(upstreamBaseUrl: string): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const upstream = new URL(upstreamBaseUrl);
  const upstreamHostname = upstream.hostname;
  const upstreamPort = parseInt(
    upstream.port || (upstream.protocol === "https:" ? "443" : "80"),
    10,
  );

  const server = http.createServer((clientReq, clientRes) => {
    const reqChunks: Buffer[] = [];
    clientReq.on("data", (c: Buffer) => reqChunks.push(c));
    clientReq.on("end", () => {
      const reqBody = Buffer.concat(reqChunks);
      const isCompletions = (clientReq.url ?? "").includes("/chat/completions");

      const upstreamReqOptions: http.RequestOptions = {
        hostname: upstreamHostname,
        port: upstreamPort,
        path: clientReq.url,
        method: clientReq.method ?? "GET",
        headers: {
          ...clientReq.headers,
          host: upstream.port
            ? `${upstreamHostname}:${upstreamPort}`
            : upstreamHostname,
        },
      };

      const upstreamReq = http.request(upstreamReqOptions, (upstreamRes) => {
        const resChunks: Buffer[] = [];
        upstreamRes.on("data", (c: Buffer) => resChunks.push(c));
        upstreamRes.on("end", () => {
          let rawBody = Buffer.concat(resChunks).toString("utf8");
          const contentType = (upstreamRes.headers["content-type"] ?? "") as string;

          if (isCompletions) {
            if (contentType.includes("text/event-stream")) {
              rawBody = maybePatchSseBody(rawBody);
            } else if (contentType.includes("application/json")) {
              rawBody = maybePatchJsonBody(rawBody);
            }
          }

          const resHeaders = { ...upstreamRes.headers };
          // Remove transfer-encoding since we're sending the full body at once.
          delete resHeaders["transfer-encoding"];
          clientRes.writeHead(upstreamRes.statusCode ?? 200, {
            ...resHeaders,
            "content-length": Buffer.byteLength(rawBody).toString(),
          });
          clientRes.end(rawBody);
        });

        upstreamRes.on("error", (err: Error) => {
          if (!clientRes.headersSent) clientRes.writeHead(502);
          clientRes.end(`Upstream error: ${err.message}`);
        });
      });

      upstreamReq.on("error", (err: Error) => {
        if (!clientRes.headersSent) clientRes.writeHead(502);
        clientRes.end(`Proxy error: ${err.message}`);
      });

      if (reqBody.length > 0) upstreamReq.write(reqBody);
      upstreamReq.end();
    });

    clientReq.on("error", () => {
      // Client disconnected before the response was sent — nothing to do.
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as net.AddressInfo;
  // Return the same path prefix as the upstream so opencode's AI SDK
  // constructs identical request paths (e.g. /v1/chat/completions).
  const proxyUrl = `http://127.0.0.1:${address.port}${upstream.pathname}`;

  return {
    url: proxyUrl,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
