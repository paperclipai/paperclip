import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asBoolean, asStringArray, parseObject } from "../server-utils.js";

export const PAPERCLIP_MCP_SERVER_NAME = "paperclip-api";

export const DEFAULT_PAPERCLIP_MCP_TOOLS = [
  "paperclipGetIssue",
  "paperclipGetHeartbeatContext",
  "paperclipListComments",
  "paperclipCheckoutIssue",
  "paperclipUpdateIssue",
  "paperclipAddComment",
] as const;

export const PAPERCLIP_MCP_FORWARDED_ENV = [
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
] as const;

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface PaperclipMcpSelection {
  tools: string[];
  rejectedTools: string[];
}

export function readPaperclipMcpSelection(config: Record<string, unknown>): PaperclipMcpSelection | null {
  const raw = config.paperclipMcp;
  if (raw === true) return { tools: [...DEFAULT_PAPERCLIP_MCP_TOOLS], rejectedTools: [] };
  const section = parseObject(raw);
  if (!asBoolean(section.enabled, false)) return null;
  const requested = Array.isArray(section.tools) ? asStringArray(section.tools) : [...DEFAULT_PAPERCLIP_MCP_TOOLS];
  const tools: string[] = [];
  const rejectedTools: string[] = [];
  for (const name of requested) {
    if (!TOOL_NAME_PATTERN.test(name)) rejectedTools.push(name);
    else if (!tools.includes(name)) tools.push(name);
  }
  return { tools, rejectedTools };
}

export async function resolvePaperclipMcpEntrypoint(): Promise<string | null> {
  let moduleDir: string;
  try {
    moduleDir = path.dirname(fileURLToPath(import.meta.resolve("@paperclipai/mcp-server")));
  } catch {
    return null;
  }
  for (const candidate of [
    path.join(moduleDir, "stdio.js"),
    path.join(moduleDir, "..", "dist", "stdio.js"),
  ]) {
    try {
      return await fs.realpath(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

export function buildPaperclipMcpServerConfig(input: {
  entrypoint: string;
  tools: string[];
  nodeExecutable: string;
}): Record<string, unknown> {
  return {
    command: input.nodeExecutable,
    args: [input.entrypoint],
    env_vars: [...PAPERCLIP_MCP_FORWARDED_ENV],
    default_tools_approval_mode: "approve",
    enabled_tools: input.tools,
  };
}
