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

import { fetchPartnerQBankQuestion, searchPartnerQBankQuestions } from "../services/hlt-partner-qbank.js";

describe("HLT Partner QBank client", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches a question with rationales and discussions without exposing the token to the browser", async () => {
    mcpMocks.listTools
      .mockResolvedValueOnce({ tools: [{ name: "get_question" }, { name: "list_discussions" }] })
      .mockResolvedValueOnce({ tools: [{ name: "get_question" }, { name: "list_discussions" }] });
    mcpMocks.callTool
      .mockResolvedValueOnce({
        structuredContent: { item: { id: 50067, question: "<p>Ovarian cancer spread?</p>" } },
      })
      .mockResolvedValueOnce({
        structuredContent: { records: [{ id: 7, title: "Student comment", comments_count: 2 }] },
      });

    const item = await fetchPartnerQBankQuestion({
      appId: 3,
      questionId: "50067",
      apiKey: "test-token",
    });

    expect(item).toMatchObject({
      id: 50067,
      question: "<p>Ovarian cancer spread?</p>",
      discussion_threads: [{ id: 7, title: "Student comment", comments_count: 2 }],
    });
    expect(mcpMocks.transportConstructor).toHaveBeenCalledWith(
      new URL("https://api.hltcorp.com/api/partner/v1/mcp"),
      expect.objectContaining({
        requestInit: expect.objectContaining({
          headers: { "x-mcp-token": "test-token" },
        }),
      }),
    );
    expect(mcpMocks.callTool).toHaveBeenNthCalledWith(1, {
      name: "get_question",
      arguments: { app_id: 3, id: 50067 },
    });
    expect(mcpMocks.callTool).toHaveBeenNthCalledWith(2, {
      name: "list_discussions",
      arguments: { app_id: 3, resource_type: "flashcard", resource_id: 50067, limit: 25, offset: 0 },
    });
    expect(mcpMocks.close).toHaveBeenCalledTimes(2);
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
      includeDiscussions: false,
    });

    expect(item).toMatchObject({ id: "abc", prompt: "Stem" });
    expect(mcpMocks.callTool).toHaveBeenCalledWith({
      name: "qbank.get",
      arguments: { app_id: 3, id: "abc" },
    });
  });

  it("searches visible flashcards with local weighted matching", async () => {
    mcpMocks.listTools
      .mockResolvedValueOnce({ tools: [{ name: "list_flashcards" }, { name: "show_flashcard" }] })
      .mockResolvedValueOnce({ tools: [{ name: "list_flashcards" }, { name: "show_flashcard" }] })
      .mockResolvedValueOnce({ tools: [{ name: "list_flashcards" }, { name: "show_flashcard" }] });
    mcpMocks.callTool
      .mockResolvedValueOnce({ structuredContent: { records: [{ id: 1 }, { id: 2 }] } })
      .mockResolvedValueOnce({ structuredContent: { item: { id: 1, question: "<p>jaundice liver metastasis</p>", rationale: "bilirubin" } } })
      .mockResolvedValueOnce({ structuredContent: { item: { id: 2, question: "<p>skin lesion</p>", rationale: "dermatology" } } });

    const results = await searchPartnerQBankQuestions({ appId: 3, query: "jaundice liver", apiKey: "test-token", includeDiscussions: false });

    expect(results).toHaveLength(1);
    expect(results[0]?.sourceRef).toBe("qbank:app-3/question-1");
    expect(results[0]?.matchedFields).toContain("question");
  });

  it("fails closed when no Partner API token is configured", async () => {
    await expect(fetchPartnerQBankQuestion({ appId: 3, questionId: "50067", apiKey: undefined }))
      .rejects.toThrow("HLT Partner API token is not configured");
    expect(mcpMocks.clientConstructor).not.toHaveBeenCalled();
  });
});
