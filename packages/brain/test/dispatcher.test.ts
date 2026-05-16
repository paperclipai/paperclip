import { describe, it, expect } from "vitest";
import { dispatch } from "../src/mcp-server/dispatcher.js";
import type { BrainTools } from "../src/mcp-server/tools.js";
import type { TokenIdentity } from "../src/mcp-server/auth.js";

function makeRecordingTools(): { tools: BrainTools; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    search_vault: [],
    get_note: [],
    list_scope: [],
  };
  const tools: BrainTools = {
    async search_vault(args) {
      calls.search_vault!.push(args);
      return [];
    },
    async get_note(args) {
      calls.get_note!.push(args);
      return null;
    },
    async list_scope(args) {
      calls.list_scope!.push(args);
      return { allowedFolders: [], noteCount: 0 };
    },
  };
  return { tools, calls };
}

const N8N_IDENTITY: TokenIdentity = { defaultAgentId: "n8n", allowedAgentIds: ["n8n"] };
const WALTER_IDENTITY: TokenIdentity = { defaultAgentId: "walter", allowedAgentIds: ["walter"] };
const PAPERCLIP_IDENTITY: TokenIdentity = {
  defaultAgentId: "PAPERCLIP",
  allowedAgentIds: ["PAPERCLIP", "CEO", "CFO", "walter"],
};

describe("dispatch — cross-token impersonation (security)", () => {
  it("get_note: n8n token MUST NOT be allowed to claim agentId='walter'", async () => {
    const { tools, calls } = makeRecordingTools();
    const result = await dispatch({
      tools,
      identity: N8N_IDENTITY,
      body: { tool: "get_note", args: { agentId: "walter", path: "Marketing/x.md" } },
    });

    expect(result.status).toBe(403);
    expect(result.audit.ok).toBe(false);
    expect(result.audit.agentId).toBe("n8n");
    expect(calls.get_note).toHaveLength(0);
  });

  it("search_vault: n8n token MUST NOT be allowed to claim agentId='walter'", async () => {
    const { tools, calls } = makeRecordingTools();
    const result = await dispatch({
      tools,
      identity: N8N_IDENTITY,
      body: { tool: "search_vault", args: { agentId: "walter", query: "secrets" } },
    });

    expect(result.status).toBe(403);
    expect(calls.search_vault).toHaveLength(0);
  });

  it("list_scope: n8n token MUST NOT be allowed to claim agentId='walter'", async () => {
    const { tools, calls } = makeRecordingTools();
    const result = await dispatch({
      tools,
      identity: N8N_IDENTITY,
      body: { tool: "list_scope", args: { agentId: "walter" } },
    });

    expect(result.status).toBe(403);
    expect(calls.list_scope).toHaveLength(0);
  });

  it("walter token MUST NOT be allowed to claim agentId='n8n'", async () => {
    const { tools } = makeRecordingTools();
    const result = await dispatch({
      tools,
      identity: WALTER_IDENTITY,
      body: { tool: "get_note", args: { agentId: "n8n", path: "x" } },
    });
    expect(result.status).toBe(403);
  });

  it("Paperclip token MUST NOT be allowed to claim arbitrary agentId not in its allowlist", async () => {
    const { tools } = makeRecordingTools();
    const result = await dispatch({
      tools,
      identity: PAPERCLIP_IDENTITY,
      body: { tool: "get_note", args: { agentId: "n8n", path: "x" } },
    });
    expect(result.status).toBe(403);
  });
});

describe("dispatch — legitimate in-token override (Paperclip multi-agent)", () => {
  it("Paperclip token can claim agentId='CEO' (in its allowlist)", async () => {
    const { tools, calls } = makeRecordingTools();
    const result = await dispatch({
      tools,
      identity: PAPERCLIP_IDENTITY,
      body: { tool: "search_vault", args: { agentId: "CEO", query: "foo" } },
    });
    expect(result.status).toBe(200);
    expect((calls.search_vault![0] as { agentId: string }).agentId).toBe("CEO");
    expect(result.audit.agentId).toBe("CEO");
  });

  it("Paperclip token can claim agentId='walter' (in its allowlist)", async () => {
    const { tools, calls } = makeRecordingTools();
    const result = await dispatch({
      tools,
      identity: PAPERCLIP_IDENTITY,
      body: { tool: "get_note", args: { agentId: "walter", path: "x" } },
    });
    expect(result.status).toBe(200);
    expect((calls.get_note![0] as { agentId: string }).agentId).toBe("walter");
  });
});

describe("dispatch — default agentId (no override)", () => {
  it("walter token without body.agentId uses defaultAgentId='walter'", async () => {
    const { tools, calls } = makeRecordingTools();
    const result = await dispatch({
      tools,
      identity: WALTER_IDENTITY,
      body: { tool: "search_vault", args: { query: "foo" } },
    });
    expect(result.status).toBe(200);
    expect((calls.search_vault![0] as { agentId: string }).agentId).toBe("walter");
  });

  it("Paperclip token without body.agentId uses defaultAgentId='PAPERCLIP'", async () => {
    const { tools, calls } = makeRecordingTools();
    const result = await dispatch({
      tools,
      identity: PAPERCLIP_IDENTITY,
      body: { tool: "list_scope", args: {} },
    });
    expect(result.status).toBe(200);
    expect((calls.list_scope![0] as { agentId: string }).agentId).toBe("PAPERCLIP");
  });
});

describe("dispatch — invalid request", () => {
  it("returns 400 on missing tool", async () => {
    const { tools } = makeRecordingTools();
    const result = await dispatch({
      tools,
      identity: WALTER_IDENTITY,
      body: { args: {} },
    });
    expect(result.status).toBe(400);
    expect(result.audit.ok).toBe(false);
  });

  it("returns 400 on unknown tool", async () => {
    const { tools } = makeRecordingTools();
    const result = await dispatch({
      tools,
      identity: WALTER_IDENTITY,
      body: { tool: "delete_everything", args: {} },
    });
    expect(result.status).toBe(400);
  });
});
