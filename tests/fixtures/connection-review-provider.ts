import { createServer, type Server } from "node:http";
import { listenOnFetchAllowedPort } from "../e2e/fetch-allowed-port.js";

export async function startReviewProvider(
  successText = "Pages: Roadmap, Meeting notes",
  bearerToken?: string,
  tool?: { name: string; title: string; description: string },
) {
  const captures: Array<{ method: string; toolName: string | null; authorized?: boolean }> = [];
  const server: Server = createServer(async (req, res) => {
    const authorized = !bearerToken || req.headers.authorization === `Bearer ${bearerToken}`;
    if (!authorized) {
      if (captures.length < 10_000) captures.push({ method: "<unauthorized>", toolName: null, authorized: false });
      req.resume();
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Service credential required" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 65_536) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk as Buffer);
      }
    } catch { res.destroy(); return; }
    let payload: { id?: string | number; method?: string; params?: { name?: string; arguments?: { query?: string } } };
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || payload.method !== undefined && typeof payload.method !== "string") throw new Error("invalid_request");
    } catch { res.writeHead(400); res.end(); return; }
    if (captures.length >= 10_000) { res.writeHead(429); res.end(); return; }
    captures.push({ method: String(payload.method ?? "<unknown>").slice(0, 120),
      toolName: typeof payload.params?.name === "string" ? payload.params.name.slice(0, 128) : null,
      ...(bearerToken ? { authorized: true } : {}),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (payload.method === "tools/list") {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            tools: [
              {
                name: tool?.name ?? "notion:list_pages",
                title: tool?.title ?? "List fixture pages",
                description: tool?.description ?? "Reads deterministic pages from the fake Notion provider.",
                annotations: { readOnlyHint: true },
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  additionalProperties: false,
                },
              },
            ],
          },
        }),
      );
      return;
    }
    if (payload.method === "tools/call") {
      const unavailable = payload.params?.arguments?.query === "fail" || payload.params?.name !== (tool?.name ?? "notion:list_pages");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            isError: unavailable,
            content: [
              {
                type: "text",
                text:
                  unavailable
                    ? "Fixture provider unavailable"
                    : successText,
              },
            ],
          },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? null, result: {} }),
    );
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const port = await listenOnFetchAllowedPort(server);
  return {
    url: `http://127.0.0.1:${port}/`,
    captures,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
