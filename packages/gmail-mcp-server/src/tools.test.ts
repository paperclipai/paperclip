import { describe, expect, it, vi } from "vitest";
import { createToolDefinitions } from "./tools.js";
import type { GmailClient } from "./google-client.js";
import type { ToolResult } from "./tools.js";

function makeClient(): GmailClient {
  return {
    getProfile: vi.fn().mockResolvedValue({ emailAddress: "me@example.test", messagesTotal: 10, threadsTotal: 5 }),
    searchThreads: vi.fn().mockResolvedValue({
      threads: [{ threadId: "t1", snippet: "hi", from: "a@example.com", to: null, subject: "Hi", date: "today" }],
      nextPageToken: null,
    }),
    getThread: vi.fn().mockResolvedValue({
      threadId: "t1",
      messages: [{
        id: "m1",
        threadId: "t1",
        from: "a@example.com",
        to: "me@example.test",
        cc: null,
        subject: "Hi",
        date: "today",
        snippet: "hi",
        body: "hi there",
        bodyTruncated: false,
        attachmentFilenames: [],
      }],
    }),
    getMessage: vi.fn().mockResolvedValue({
      id: "m1",
      threadId: "t1",
      from: "a@example.com",
      to: "me@example.test",
      cc: null,
      subject: "Hi",
      date: "today",
      snippet: "hi",
      body: "hi there",
      bodyTruncated: false,
      attachmentFilenames: [],
    }),
    listLabels: vi.fn().mockResolvedValue([{ id: "INBOX", name: "INBOX", type: "system" }]),
    listDrafts: vi.fn().mockResolvedValue({ drafts: [], nextPageToken: null }),
    getDraft: vi.fn().mockResolvedValue({
      draftId: "d1",
      message: {
        id: "m2", threadId: "t2", from: null, to: "a@example.com", cc: null, subject: "Draft",
        date: null, snippet: "", body: "draft body", bodyTruncated: false, attachmentFilenames: [],
      },
    }),
    createDraft: vi.fn().mockResolvedValue({
      draftId: "d2",
      message: {
        id: "m3", threadId: "t3", from: null, to: "a@example.com", cc: null, subject: "New",
        date: null, snippet: "", body: "new body", bodyTruncated: false, attachmentFilenames: [],
      },
    }),
  };
}

function tools(client = makeClient()) {
  return createToolDefinitions({
    client,
    secretRedactions: ["client-secret-value", "refresh-token-value"],
  });
}

function getTool(name: string, client?: GmailClient) {
  const tool = tools(client).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function responseText(response: ToolResult) {
  const block = response.content.find((entry) => entry.type === "text");
  return block?.type === "text" ? block.text : "";
}

describe("Gmail MCP tools", () => {
  it("exposes exactly the documented tool set, with no send/trash/delete/label-mutation tool", () => {
    const names = tools().map((tool) => tool.name).sort();
    expect(names).toEqual([
      "create_draft",
      "get_draft",
      "get_message",
      "get_profile",
      "get_thread",
      "list_drafts",
      "list_labels",
      "search_threads",
    ].sort());
  });

  it("annotates every tool as read-only except create_draft, and marks nothing destructive", () => {
    for (const tool of tools()) {
      expect(tool.annotations.destructiveHint).not.toBe(true);
      if (tool.name === "create_draft") {
        expect(tool.annotations.readOnlyHint).toBe(false);
      } else {
        expect(tool.annotations.readOnlyHint).toBe(true);
      }
    }
  });

  it("gets the profile", async () => {
    const response = await getTool("get_profile").execute({});
    expect(response.isError).toBeUndefined();
    expect(responseText(response)).toContain("me@example.test");
  });

  it("searches threads with defaulted max_results", async () => {
    const client = makeClient();
    const response = await getTool("search_threads", client).execute({ q: "from:a@example.com" });

    expect(client.searchThreads).toHaveBeenCalledWith({ query: "from:a@example.com", maxResults: 25, pageToken: undefined });
    expect(responseText(response)).toContain("t1");
  });

  it("rejects a max_results above 50 before calling Gmail", async () => {
    const client = makeClient();
    const response = await getTool("search_threads", client).execute({ q: "x", max_results: 51 });

    expect(response.isError).toBe(true);
    expect(client.searchThreads).not.toHaveBeenCalled();
  });

  it("rejects a create_draft call with more than 50 recipients before calling Gmail", async () => {
    const client = makeClient();
    const response = await getTool("create_draft", client).execute({
      to: Array.from({ length: 51 }, (_, i) => `user${i}@example.com`),
      subject: "Hi",
      body: "Body",
    });

    expect(response.isError).toBe(true);
    expect(client.createDraft).not.toHaveBeenCalled();
  });

  it("rejects a non-email recipient", async () => {
    const client = makeClient();
    const response = await getTool("create_draft", client).execute({
      to: ["not-an-email"],
      subject: "Hi",
      body: "Body",
    });

    expect(response.isError).toBe(true);
    expect(client.createDraft).not.toHaveBeenCalled();
  });

  it("creates a draft and threads reply_to_message_id through to the client", async () => {
    const client = makeClient();
    const response = await getTool("create_draft", client).execute({
      to: ["a@example.com"],
      subject: "Re: Hi",
      body: "Reply body",
      reply_to_message_id: "orig-id",
    });

    expect(client.createDraft).toHaveBeenCalledWith({
      to: ["a@example.com"],
      cc: undefined,
      bcc: undefined,
      subject: "Re: Hi",
      body: "Reply body",
      replyToMessageId: "orig-id",
    });
    expect(response.isError).toBeUndefined();
  });

  it("redacts configured secrets out of error messages", async () => {
    const client = makeClient();
    (client.getMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("token refresh failed for refresh-token-value"),
    );
    const response = await getTool("get_message", client).execute({ message_id: "m1" });

    expect(response.isError).toBe(true);
    expect(responseText(response)).not.toContain("refresh-token-value");
    expect(responseText(response)).toContain("[REDACTED]");
  });

  it.each([
    ["get_thread", { thread_id: "t1" }, "getThread"],
    ["get_message", { message_id: "m1" }, "getMessage"],
    ["list_labels", {}, "listLabels"],
    ["list_drafts", {}, "listDrafts"],
    ["get_draft", { draft_id: "d1" }, "getDraft"],
  ] as const)("runs happy path for %s", async (toolName, input, clientMethod) => {
    const client = makeClient();
    const response = await getTool(toolName, client).execute(input);

    expect(response.isError).toBeUndefined();
    expect(client[clientMethod]).toHaveBeenCalled();
  });
});
