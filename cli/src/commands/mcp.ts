import type { Command } from "commander";
import { createInterface } from "node:readline";
import { loginMcpDevice, mcpAccessToken, mcpResource, mcpRpc } from "../client/mcp-auth.js";

export function registerMcpCommands(program: Command) {
  const mcp = program.command("mcp").description("Connect an assistant to Paperclip as a consenting human");
  mcp.command("login").requiredOption("--device", "Authorize in a browser without a callback listener")
    .requiredOption("--url <url>", "Canonical Paperclip MCP URL").option("--company <id>", "Restrict consent to this organization")
    .action(async (options: { url: string; company?: string }) => {
      const result = await loginMcpDevice(options.url, options.company);
      console.log(`Connected to ${result.resource}\nOrganization: ${result.companyId}`);
    });
  mcp.command("proxy").description("Expose the authorized Paperclip tools over local MCP stdio")
    .requiredOption("--url <url>", "The exact MCP URL used during login")
    .action(async (options: { url: string }) => {
      const resource = mcpResource(options.url);
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of lines) {
        let message: { id?: string | number; method?: string; params?: Record<string, unknown> };
        if (Buffer.byteLength(line) > 1024 * 1024) continue;
        try { message = JSON.parse(line); } catch { continue; }
        if (!message || typeof message !== "object" || Array.isArray(message)) continue;
        if (message.id === undefined) continue;
        try {
          let result: unknown;
          if (message.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "paperclip", version: "1" } };
          else if (message.method === "ping") result = {};
          else if (message.method === "tools/list" || message.method === "tools/call") result = await mcpRpc(resource, await mcpAccessToken(resource), message.method, message.params ?? {});
          else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not supported." } }) + "\n"); continue; }
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
        } catch (error) {
          // Never log request arguments, raw provider responses, or credentials.
          const text = "Paperclip connection failed. Check access before retrying; a write may already have completed.";
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: text } }) + "\n");
        }
      }
    });
}
