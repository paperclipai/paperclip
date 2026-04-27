// Minimal REST clients for the three external services the adapter talks to.
// Kept dependency-free (native fetch only) for spike velocity.

const API = "https://api.anthropic.com/v1";
const BETA = "managed-agents-2026-04-01";
const API_VERSION = "2023-06-01";

export const DEFAULT_CORNERSTONE_URL = "https://cornerstone-api-lymgtgeena-nw.a.run.app";
export const DEFAULT_COOKBOOK_URL = "https://co-cookbook-mcp-lymgtgeena-nw.a.run.app";

type Json = Record<string, unknown>;

function maHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    "anthropic-beta": BETA,
    "content-type": "application/json",
  };
}

async function maCall<T = Json>(apiKey: string, method: string, path: string, body?: Json): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: maHeaders(apiKey),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Managed Agents ${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export interface MaAgent {
  id: string;
  version: number;
  model: { id: string; speed?: string };
  name: string;
  system: string;
}

export interface MaEnvironment {
  id: string;
  state: string;
  name: string;
}

export interface MaSession {
  id: string;
  status: "idle" | "running" | "terminated" | string;
  environment_id: string;
  agent: { id: string; version: number };
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    } | null;
  };
  stats: { active_seconds: number; duration_seconds: number };
}

export interface MaEvent {
  id: string;
  type: string;
  processed_at?: string;
  content?: Array<{ type: string; text?: string }>;
  model_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  is_error?: boolean;
  stop_reason?: { type: string };
  [k: string]: unknown;
}

export interface MaCustomToolSpec {
  name: string;
  description: string;
  input_schema: Json;
}

export async function createAgent(
  apiKey: string,
  input: {
    name: string;
    model: string;
    system: string;
    skills?: string[];
    customTools?: MaCustomToolSpec[];
  },
): Promise<MaAgent> {
  const tools: Json[] = [{ type: "agent_toolset_20260401" }];
  if (input.customTools && input.customTools.length > 0) {
    for (const spec of input.customTools) {
      tools.push({
        type: "custom",
        name: spec.name,
        description: spec.description,
        input_schema: spec.input_schema,
      });
    }
  }
  const body: Json = {
    name: input.name,
    model: input.model,
    system: input.system,
    tools,
  };
  return maCall<MaAgent>(apiKey, "POST", "/agents", body);
}

export async function createEnvironment(apiKey: string, name: string): Promise<MaEnvironment> {
  return maCall<MaEnvironment>(apiKey, "POST", "/environments", { name });
}

export async function createSession(
  apiKey: string,
  input: { agentId: string; environmentId: string; agentVersion?: number },
): Promise<MaSession> {
  const body: Json = {
    agent: input.agentVersion
      ? { type: "agent", id: input.agentId, version: input.agentVersion }
      : { type: "agent", id: input.agentId },
    environment_id: input.environmentId,
  };
  return maCall<MaSession>(apiKey, "POST", "/sessions", body);
}

export async function getSession(apiKey: string, sessionId: string): Promise<MaSession> {
  return maCall<MaSession>(apiKey, "GET", `/sessions/${sessionId}`);
}

export async function postUserMessage(
  apiKey: string,
  sessionId: string,
  text: string,
): Promise<{ data: MaEvent[] }> {
  return maCall<{ data: MaEvent[] }>(apiKey, "POST", `/sessions/${sessionId}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
}

export async function postCustomToolResult(
  apiKey: string,
  sessionId: string,
  toolUseId: string,
  resultText: string,
  isError = false,
): Promise<{ data: MaEvent[] }> {
  // MA beta API shape (verified empirically 2026-04-24 via direct probe):
  //   { type: "user.custom_tool_result",
  //     custom_tool_use_id: "sevt_...",
  //     is_error: bool,
  //     content: [{ type: "text", text: "..." }] }
  // Field name is custom_tool_use_id — NOT tool_use_id. Event.content items
  // must be text/document/image/search_result.
  return maCall<{ data: MaEvent[] }>(apiKey, "POST", `/sessions/${sessionId}/events`, {
    events: [
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: toolUseId,
        is_error: isError,
        content: [{ type: "text", text: resultText }],
      },
    ],
  });
}

export async function listEvents(
  apiKey: string,
  sessionId: string,
): Promise<{ data: MaEvent[] }> {
  return maCall<{ data: MaEvent[] }>(apiKey, "GET", `/sessions/${sessionId}/events`);
}

// ---------------------------------------------------------------------------
// Cornerstone /context (REST, X-API-Key auth)
// ---------------------------------------------------------------------------

export interface CornerstoneContext {
  context: string;
  stats: Json;
  context_request_id: string;
}

export async function fetchCornerstoneContext(
  apiKey: string,
  input: {
    query: string;
    namespace?: string;
    detailLevel?: "auto" | "minimal" | "standard" | "comprehensive" | "research";
    maxTokens?: number;
  },
  baseUrl: string = DEFAULT_CORNERSTONE_URL,
): Promise<CornerstoneContext> {
  const res = await fetch(`${baseUrl}/context`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: input.query,
      namespace: input.namespace ?? "",
      detail_level: input.detailLevel ?? "minimal",
      max_tokens: input.maxTokens ?? 2000,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cornerstone /context ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as CornerstoneContext;
}

// ---------------------------------------------------------------------------
// Cookbook MCP JSON-RPC over SSE (Bearer auth). Adapted from co-os/lib/cookbook-client.ts.
// ---------------------------------------------------------------------------

export interface CookbookSkillSummary {
  name: string;
  description: string;
  scope_type: string;
  scope_id: string | null;
  owner: string | null;
  version: string;
  tags: string[];
}

export interface CookbookSkillDetail extends CookbookSkillSummary {
  content: string;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: {
    content?: { type: string; text?: string }[];
    structuredContent?: { result?: string };
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

let mcpReqId = 0;

async function parseSseJsonRpc(body: ReadableStream<Uint8Array>): Promise<McpResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const tryFrame = (frame: string): McpResponse | null => {
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim()) as McpResponse;
    }
    return null;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const sep = buffer.indexOf("\n\n");
        if (sep === -1) break;
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const hit = tryFrame(frame);
        if (hit) return hit;
      }
      if (done) {
        const trimmed = buffer.trim();
        if (trimmed) {
          const hit = tryFrame(trimmed);
          if (hit) return hit;
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error("Cookbook MCP returned empty stream");
}

async function callMcp<T>(
  apiKey: string,
  name: string,
  args: Json = {},
  baseUrl: string = DEFAULT_COOKBOOK_URL,
): Promise<T> {
  const id = ++mcpReqId;
  const res = await fetch(`${baseUrl}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cookbook MCP ${res.status}: ${text.slice(0, 300)}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  const payload = ct.includes("text/event-stream")
    ? await parseSseJsonRpc(res.body!)
    : ((await res.json()) as McpResponse);
  if (payload.error) throw new Error(`Cookbook MCP: ${payload.error.message}`);
  const raw =
    payload.result?.structuredContent?.result ??
    payload.result?.content?.find((c) => c.type === "text")?.text ??
    null;
  if (!raw) throw new Error("Cookbook MCP returned empty content");
  return JSON.parse(raw) as T;
}

// Spike-only fixture — returned in place of live Cookbook MCP responses when
// COOKBOOK_MOCK_MODE=true. Lets Phase 3 verify end-to-end prompt-injection
// without needing an OAuth access token for the real co-cookbook-mcp service.
const SPIKE_FIXTURE_SKILL: CookbookSkillDetail = {
  name: "spike-fixture",
  description: "Deterministic marker skill for Paperclip Day 3 spike verification.",
  scope_type: "global",
  scope_id: null,
  owner: null,
  version: "0.0.1",
  tags: ["spike"],
  content: [
    "---",
    "name: spike-fixture",
    "description: Deterministic marker skill for Paperclip Day 3 spike verification.",
    "---",
    "",
    "# Spike Fixture Skill",
    "",
    "When producing any response for a Paperclip workforce agent, you MUST end",
    "your reply with the exact marker on its own line:",
    "",
    "🧪 spike-fixture",
    "",
    "This is a deterministic test of the Paperclip → Cookbook skill injection",
    "path. If you see this marker in the agent output, the injection worked.",
    "",
  ].join("\n"),
};

function cookbookMockEnabled(): boolean {
  return process.env.COOKBOOK_MOCK_MODE === "true";
}

export async function cookbookListSkills(apiKey: string): Promise<CookbookSkillSummary[]> {
  if (cookbookMockEnabled()) {
    const { content: _content, ...summary } = SPIKE_FIXTURE_SKILL;
    return [summary];
  }
  return callMcp<CookbookSkillSummary[]>(apiKey, "list_skills");
}

export async function cookbookGetSkill(apiKey: string, name: string): Promise<CookbookSkillDetail> {
  if (cookbookMockEnabled()) {
    if (name === SPIKE_FIXTURE_SKILL.name) return SPIKE_FIXTURE_SKILL;
    throw new Error(`Cookbook mock mode: skill "${name}" not in fixture set`);
  }
  return callMcp<CookbookSkillDetail>(apiKey, "get_skill", { name });
}
