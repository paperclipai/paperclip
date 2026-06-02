#!/usr/bin/env node
/**
 * Stdio MCP server that projects Paperclip plugin-registered tools (e.g.
 * paperclip-plugin-hindsight) into Claude Code's MCP surface.
 *
 * Reads PAPERCLIP_* env, fetches the agent-scoped tool list from
 * `/api/companies/:companyId/agents/:agentId/tools`, exposes each tool with
 * its bare name (collisions fall back to a `${pluginKey}_${toolName}` form),
 * and forwards `tools/call` over HTTP to `/api/.../tool-call`.
 *
 * The shim outlives no run: claude_local spawns it per heartbeat and the
 * Claude process disposes it via SIGTERM when the run completes. All HTTP
 * errors surface as MCP tool errors (`isError: true`) rather than crashing
 * the shim, so transient 401s mid-run do not take Claude down with them.
 *
 * The runtime artifact at `dist/server/paperclip-tools-mcp-shim.bundle.js`
 * is a self-contained esbuild bundle (see `build:shim` in package.json) so
 * that remote execution targets can run it from an isolated runtime asset
 * directory with no reachable `node_modules` -- @modelcontextprotocol/sdk
 * and its transitive deps are inlined into the bundle.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface PaperclipToolDescriptor {
  name: string;
  displayName?: string;
  description?: string;
  parametersSchema?: unknown;
  pluginId?: string;
}

interface ExposedTool {
  exposedName: string;
  fullName: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

const SERVER_NAME = "paperclip";
const SERVER_VERSION = "0.1.0";
const REQUIRED_ENV = [
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_AGENT_ID",
] as const;

function readEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`paperclip-tools-mcp-shim: required env var ${name} is missing or empty`);
  }
  return value.trim();
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function sanitizePluginKey(value: string | undefined): string {
  if (!value) return "plugin";
  return value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "plugin";
}

function pluginKeyFromFullName(fullName: string, fallback?: string): string {
  const colon = fullName.indexOf(":");
  if (colon > 0) return fullName.slice(0, colon);
  return fallback ?? fullName;
}

function bareToolName(fullName: string): string {
  const colon = fullName.indexOf(":");
  return colon >= 0 ? fullName.slice(colon + 1) : fullName;
}

function normalizeInputSchema(schema: unknown): ExposedTool["inputSchema"] {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const record = schema as Record<string, unknown>;
    const type = typeof record.type === "string" ? (record.type as string) : "object";
    return {
      type: type === "object" ? "object" : "object",
      properties: (record.properties as Record<string, unknown> | undefined) ?? {},
      ...(Array.isArray(record.required) ? { required: record.required as string[] } : {}),
    };
  }
  return { type: "object", properties: {} };
}

function planExposedTools(tools: PaperclipToolDescriptor[]): {
  exposed: ExposedTool[];
  collisions: string[];
} {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const bare = bareToolName(tool.name);
    counts.set(bare, (counts.get(bare) ?? 0) + 1);
  }
  const collisions: string[] = [];
  const exposed: ExposedTool[] = [];
  for (const tool of tools) {
    const bare = bareToolName(tool.name);
    const colliding = (counts.get(bare) ?? 0) > 1;
    const exposedName = colliding
      ? `${sanitizePluginKey(pluginKeyFromFullName(tool.name, tool.pluginId))}_${bare}`
      : bare;
    if (colliding) collisions.push(bare);
    exposed.push({
      exposedName,
      fullName: tool.name,
      description: tool.description ?? tool.displayName ?? "",
      inputSchema: normalizeInputSchema(tool.parametersSchema),
    });
  }
  return { exposed, collisions };
}

async function fetchPaperclipTools(opts: {
  apiUrl: string;
  apiKey: string;
  companyId: string;
  agentId: string;
}): Promise<PaperclipToolDescriptor[]> {
  const url = `${trimTrailingSlash(opts.apiUrl)}/api/companies/${encodeURIComponent(opts.companyId)}/agents/${encodeURIComponent(opts.agentId)}/tools`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to list paperclip tools (HTTP ${response.status}): ${body.slice(0, 500)}`);
  }
  const parsed = await response.json().catch(() => null);
  if (Array.isArray(parsed)) return parsed as PaperclipToolDescriptor[];
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).tools)) {
    return (parsed as { tools: PaperclipToolDescriptor[] }).tools;
  }
  return [];
}

interface CallToolHttpResult {
  text: string;
  isError: boolean;
}

async function callPaperclipTool(opts: {
  apiUrl: string;
  apiKey: string;
  companyId: string;
  agentId: string;
  runId?: string;
  toolName: string;
  parameters: Record<string, unknown>;
}): Promise<CallToolHttpResult> {
  const url = `${trimTrailingSlash(opts.apiUrl)}/api/companies/${encodeURIComponent(opts.companyId)}/agents/${encodeURIComponent(opts.agentId)}/tool-call`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `Bearer ${opts.apiKey}`,
  };
  if (opts.runId) headers["x-paperclip-run-id"] = opts.runId;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: opts.toolName, parameters: opts.parameters }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `Network error calling paperclip tool "${opts.toolName}": ${msg}`, isError: true };
  }
  const status = response.status;
  const bodyText = await response.text().catch(() => "");

  if (!response.ok) {
    const trimmed = bodyText.slice(0, 2_000) || "<empty body>";
    return {
      text: `Paperclip tool-call failed (HTTP ${status}) for "${opts.toolName}": ${trimmed}`,
      isError: true,
    };
  }

  let parsed: unknown = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = null;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const envelope = parsed as Record<string, unknown>;
    const result = envelope.result;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const r = result as Record<string, unknown>;
      const rawContent = r.content;
      const isError = Boolean(r.error);
      const text =
        typeof rawContent === "string"
          ? rawContent
          : rawContent === undefined && typeof r.error === "string"
            ? (r.error as string)
            : JSON.stringify(rawContent ?? r, null, 2);
      return { text, isError };
    }
    return { text: JSON.stringify(envelope, null, 2), isError: false };
  }

  return { text: bodyText, isError: false };
}

async function runServer(): Promise<void> {
  for (const key of REQUIRED_ENV) readEnv(key);

  const apiUrl = readEnv("PAPERCLIP_API_URL");
  const apiKey = readEnv("PAPERCLIP_API_KEY");
  const companyId = readEnv("PAPERCLIP_COMPANY_ID");
  const agentId = readEnv("PAPERCLIP_AGENT_ID");
  const runId = readOptionalEnv("PAPERCLIP_RUN_ID");

  let cached: { exposed: ExposedTool[]; lookup: Map<string, string> } | null = null;
  const loadTools = async () => {
    if (cached) return cached;
    const tools = await fetchPaperclipTools({ apiUrl, apiKey, companyId, agentId });
    const { exposed, collisions } = planExposedTools(tools);
    if (collisions.length > 0) {
      const unique = Array.from(new Set(collisions));
      process.stderr.write(
        `[paperclip-tools-mcp-shim] tool-name collisions on ${unique.join(", ")}; falling back to plugin-prefixed exposed names for affected entries.\n`,
      );
    }
    const lookup = new Map<string, string>();
    for (const tool of exposed) lookup.set(tool.exposedName, tool.fullName);
    cached = { exposed, lookup };
    return cached;
  };

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { exposed } = await loadTools();
    return {
      tools: exposed.map((tool) => ({
        name: tool.exposedName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = request.params as { name: string; arguments?: Record<string, unknown> };
    const { lookup } = await loadTools();
    const fullName = lookup.get(params.name);
    if (!fullName) {
      return {
        content: [{ type: "text" as const, text: `Unknown paperclip tool: ${params.name}` }],
        isError: true,
      };
    }
    const result = await callPaperclipTool({
      apiUrl,
      apiKey,
      companyId,
      agentId,
      runId,
      toolName: fullName,
      parameters: params.arguments ?? {},
    });
    return {
      content: [{ type: "text" as const, text: result.text }],
      isError: result.isError,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export const __test = {
  planExposedTools,
  normalizeInputSchema,
  fetchPaperclipTools,
  callPaperclipTool,
  trimTrailingSlash,
  sanitizePluginKey,
  pluginKeyFromFullName,
  bareToolName,
};

const isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const url = new URL(import.meta.url);
    return url.pathname === entry || url.pathname.endsWith(entry);
  } catch {
    return false;
  }
})();

if (isMain) {
  void runServer().catch((err) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[paperclip-tools-mcp-shim] fatal: ${msg}\n`);
    process.exit(1);
  });
}
