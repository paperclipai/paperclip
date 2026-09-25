import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { ToolGatewayHttpError, type ToolGatewayDescriptor, type ToolGatewayService } from "../tool-gateway.js";

type WorkMode = "standard" | "planning" | "ask";

// Execution must use the app's configured gateway, including deployment
// restrictions, OAuth refresh, and approval delivery. Never fall back to an
// isolated gateway whose defaults differ from the running instance.
const assignedMcpGateways = new WeakMap<Db, ToolGatewayService>();

export function registerAssignedMcpGateway(db: Db, gateway: ToolGatewayService): void {
  assignedMcpGateways.set(db, gateway);
}

export function getAssignedMcpGateway(db: Db): ToolGatewayService {
  const gateway = assignedMcpGateways.get(db);
  if (!gateway) throw new Error("assigned_mcp_gateway_unavailable");
  return gateway;
}

function assignedToolName(name: string): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const separator = name.lastIndexOf(":");
  const readable = separator >= 0
    ? `${sanitize(name.slice(0, separator)).slice(0, 20) || "tool"}_${sanitize(name.slice(separator + 1)).slice(-26) || "action"}`
    : sanitize(name).slice(0, 47) || "tool";
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `app_${readable}_${digest}`;
}

/** Server-owned MCP bindings projected into the runner's existing tool channel. */
export async function createAssignedMcpTools(input: {
  gateway: ToolGatewayService;
  gatewayPublicId: string;
  bearerToken: string;
  workMode?: WorkMode;
}) {
  const listed = await input.gateway.listToolsForNamedGateway({
    gatewayPublicId: input.gatewayPublicId,
    bearerToken: input.bearerToken,
  });
  const tools = new Map<string, ToolGatewayDescriptor>();
  for (const descriptor of listed) {
    const name = assignedToolName(descriptor.name);
    if (tools.has(name)) throw new Error("assigned_mcp_tool_name_collision");
    tools.set(name, descriptor);
  }
  const permits = (tool: ToolGatewayDescriptor, mode: WorkMode = input.workMode ?? "standard") => mode === "standard" || tool.risk === "read";

  return {
    definitions(): Array<Record<string, unknown>> {
      return [...tools].filter(([, tool]) => permits(tool)).map(([name, tool]) => ({
        name,
        description: `${tool.displayName}: ${tool.description}`,
        inputSchema: structuredClone(tool.parametersSchema),
      }));
    },
    has(name: string): boolean {
      return tools.has(name);
    },
    async execute(call: { tool: string; arguments: unknown }, currentWorkMode?: WorkMode): Promise<unknown> {
      const descriptor = tools.get(call.tool);
      if (!descriptor) throw new Error("assigned_mcp_tool_unknown");
      if (!permits(descriptor) || !permits(descriptor, currentWorkMode)) throw new Error("paperclip_runner_tool_mode_denied");
      // Reauthorize through the existing gateway on every call. Discovery is
      // not a grant: revocation, policy, approval, and audit remain server-owned.
      const result = await input.gateway.executeTool({
        gatewayPublicId: input.gatewayPublicId,
        sessionToken: input.bearerToken,
        tool: descriptor.name,
        parameters: call.arguments,
      });
      if (result.status !== "completed" && result.status !== "replayed") {
        throw new Error("assigned_mcp_tool_execution_incomplete");
      }
      // The gateway normally throws provider errors. Keep a malformed or older
      // provider response from being reported as successful through PRP.
      if (result.result && typeof result.result === "object" && "isError" in result.result && result.result.isError === true) {
        throw new ToolGatewayHttpError(502, "The assigned tool returned an error.", "tool_error");
      }
      return result.result;
    },
  };
}
