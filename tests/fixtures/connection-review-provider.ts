import { createServer, type Server } from "node:http";
import { listenOnFetchAllowedPort } from "../e2e/fetch-allowed-port.js";

export async function startReviewProvider(
  successText = "Pages: Roadmap, Meeting notes",
) {
  const captures: Array<{ method: string; toolName: string | null }> = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const payload = JSON.parse(
      Buffer.concat(chunks).toString("utf8") || "{}",
    ) as {
      id?: string | number;
      method?: string;
      params?: { name?: string; arguments?: { query?: string } };
    };
    captures.push({
      method: String(payload.method ?? "<unknown>"),
      toolName: payload.params?.name ?? null,
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
                name: "notion:list_pages",
                title: "List fixture pages",
                description:
                  "Reads deterministic pages from the fake Notion provider.",
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
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            isError: payload.params?.arguments?.query === "fail",
            content: [
              {
                type: "text",
                text:
                  payload.params?.arguments?.query === "fail"
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
  const port = await listenOnFetchAllowedPort(server);
  return {
    url: `http://127.0.0.1:${port}/`,
    captures,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
