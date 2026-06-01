import { afterEach, describe, expect, it, vi } from "vitest";

const mcpMocks = vi.hoisted(() => {
  const connect = vi.fn();
  const listTools = vi.fn();
  const callTool = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  const clientConstructor = vi.fn(() => ({ connect, listTools, callTool }));
  const transportConstructor = vi.fn(() => ({ close }));
  return { connect, listTools, callTool, close, clientConstructor, transportConstructor };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: mcpMocks.clientConstructor,
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: mcpMocks.transportConstructor,
}));

import { fetchPartnerQBankQuestion } from "../services/hlt-partner-qbank.js";

describe("HLT Partner QBank client", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches a question by app and question id without exposing the token to the browser", async () => {
    mcpMocks.listTools.mockResolvedValue({ tools: [{ name: "get_question" }] });
    mcpMocks.callTool.mockResolvedValue({
      structuredContent: { item: { id: 50067, question: "<p>Ovarian cancer spread?</p>" } },
    });

    const item = await fetchPartnerQBankQuestion({
      appId: 3,
      questionId: "50067",
      apiKey: "test-token",
    });

    expect(item).toMatchObject({ id: 50067, question: "<p>Ovarian cancer spread?</p>" });
    expect(mcpMocks.transportConstructor).toHaveBeenCalledWith(
      new URL("https://api.hltcorp.com/api/partner/v1/mcp"),
      expect.objectContaining({
        requestInit: expect.objectContaining({
          headers: { "x-mcp-token": "test-token" },
        }),
      }),
    );
    expect(mcpMocks.callTool).toHaveBeenCalledWith({
      name: "get_question",
      arguments: { app_id: 3, id: "50067" },
    });
    expect(mcpMocks.close).toHaveBeenCalled();
  });

  it("accepts JSON text content returned by MCP callTool", async () => {
    mcpMocks.listTools.mockResolvedValue({ tools: [{ name: "qbank.get" }] });
    mcpMocks.callTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ question: { id: "abc", prompt: "Stem" } }) }],
    });

    const item = await fetchPartnerQBankQuestion({
      appId: "3",
      questionId: "abc",
      apiKey: "test-token",
    });

    expect(item).toMatchObject({ id: "abc", prompt: "Stem" });
    expect(mcpMocks.callTool).toHaveBeenCalledWith({
      name: "qbank.get",
      arguments: { app_id: 3, id: "abc" },
    });
  });

  it("fails closed when no Partner API token is configured", async () => {
    await expect(fetchPartnerQBankQuestion({ appId: 3, questionId: "50067", apiKey: undefined }))
      .rejects.toThrow("HLT Partner API token is not configured");
    expect(mcpMocks.clientConstructor).not.toHaveBeenCalled();
  });
});
