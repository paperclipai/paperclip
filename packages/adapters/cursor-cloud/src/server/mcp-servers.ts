import type { McpServerConfig } from "@cursor/sdk";
import type { CursorCloudAdapterConfig } from "./repos.js";
import { assertAllowedMcpTransport } from "./mcp-transport.js";

export function resolveCursorCloudMcpServers(input: {
  config: CursorCloudAdapterConfig;
  resolvedSecrets?: Record<string, string>;
}): Record<string, McpServerConfig> {
  const servers = input.config.mcpServers ?? [];
  const out: Record<string, McpServerConfig> = {};
  for (const srv of servers) {
    assertAllowedMcpTransport(srv);
    const transport = srv.transport ?? (srv.command ? "stdio" : "http");
    if (transport === "http") {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(srv.headers ?? {})) {
        headers[key] = input.resolvedSecrets?.[value] ?? value;
      }
      out[srv.name] = {
        type: "http",
        url: srv.url ?? "",
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    } else {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(srv.env ?? {})) {
        env[key] = input.resolvedSecrets?.[value] ?? value;
      }
      out[srv.name] = {
        type: "stdio",
        command: srv.command ?? "",
        ...(srv.args ? { args: srv.args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }
  }
  return out;
}
