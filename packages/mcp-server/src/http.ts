import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPaperclipMcpServer } from "./index.js";
import type { PaperclipMcpConfig } from "./config.js";

export interface PaperclipStreamableHttpOptions {
  body?: unknown;
}

export async function handlePaperclipStreamableHttpRequest(
  config: PaperclipMcpConfig,
  req: IncomingMessage,
  res: ServerResponse,
  options: PaperclipStreamableHttpOptions = {},
) {
  const { server } = createPaperclipMcpServer(config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, options.body);
  } finally {
    await server.close();
  }
}
