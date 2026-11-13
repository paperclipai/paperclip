import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { ToolGatewayService } from "./tool-gateway.js";

const gateways = new WeakMap<Db, ToolGatewayService>();

export function registerToolGateway(db: Db, gateway: ToolGatewayService): void {
  gateways.set(db, gateway);
}

export function getRegisteredToolGateway(db: Db): ToolGatewayService | undefined {
  return gateways.get(db);
}

export async function listRegisteredPluginToolNames(
  db: Db,
  input: { companyId: string; agentId: string; runId: string },
): Promise<string[]> {
  try {
    const tools = await gateways.get(db)?.listPluginToolsForAgent(input) ?? [];
    return tools.map((tool) => tool.name).sort();
  } catch (err) {
    logger.warn({ err, ...input }, "Could not discover plugin tools for runtime MCP assignment");
    return [];
  }
}
