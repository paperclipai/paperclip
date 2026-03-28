// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";

// Mock the API modules before importing conversations
vi.mock("./issues", () => ({
  issuesApi: {
    list: vi.fn(),
    create: vi.fn(),
    addComment: vi.fn(),
  },
}));

vi.mock("./agents", () => ({
  agentsApi: {
    wakeup: vi.fn(),
  },
}));

import {
  CONVERSATION_PREFIX,
  isConversationIssue,
  conversationAgentLabel,
  listConversations,
  ensureConversation,
  sendMessage,
} from "./conversations";
import { issuesApi } from "./issues";
import { agentsApi } from "./agents";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    kind: "task",
    title: "Test Issue",
    description: null,
    status: "backlog",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-21T00:00:00Z"),
    updatedAt: new Date("2026-03-21T00:00:00Z"),
    ...overrides,
  } as Issue;
}

// ─── isConversationIssue ────────────────────────────────────────────────────

describe("isConversationIssue", () => {
  it("returns true for issues with kind=conversation", () => {
    const issue = makeIssue({ kind: "conversation", title: "Conversation: Shadow" });
    expect(isConversationIssue(issue)).toBe(true);
  });

  it("returns false for task issues even with conversation prefix", () => {
    const issue = makeIssue({ kind: "task", title: "Conversation: Shadow" });
    expect(isConversationIssue(issue)).toBe(false);
  });

  it("returns true for titled conversations with a topic", () => {
    const issue = makeIssue({ kind: "conversation", title: "Conversation: Shadow — Project Status" });
    expect(isConversationIssue(issue)).toBe(true);
  });

  it("returns false for regular issues", () => {
    const issue = makeIssue({ title: "Fix login bug" });
    expect(isConversationIssue(issue)).toBe(false);
  });

  it("returns false when title contains the prefix mid-string", () => {
    const issue = makeIssue({ title: "Re: Conversation: Shadow" });
    expect(isConversationIssue(issue)).toBe(false);
  });

  it("returns false for issues with a null-ish title", () => {
    const issue = makeIssue({ title: undefined as unknown as string });
    expect(isConversationIssue(issue)).toBe(false);
  });
});

// ─── conversationAgentLabel ─────────────────────────────────────────────────

describe("conversationAgentLabel", () => {
  it("extracts the agent name from a conversation title", () => {
    const issue = makeIssue({ kind: "conversation", title: "Conversation: Shadow" });
    expect(conversationAgentLabel(issue)).toBe("Shadow");
  });

  it("extracts full label including topic suffix", () => {
    const issue = makeIssue({ kind: "conversation", title: "Conversation: Shadow — Deploy Plan" });
    expect(conversationAgentLabel(issue)).toBe("Shadow — Deploy Plan");
  });

  it("returns empty string for non-conversation issues", () => {
    const issue = makeIssue({ title: "Fix login bug" });
    expect(conversationAgentLabel(issue)).toBe("");
  });
});

// ─── listConversations ──────────────────────────────────────────────────────

describe("listConversations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes kind=conversation to the API and sorts by updatedAt descending", async () => {
    const convo1 = makeIssue({
      id: "c1",
      kind: "conversation",
      title: "Conversation: Shadow",
      status: "blocked",
      updatedAt: new Date("2026-03-20T00:00:00Z"),
    });
    const convo2 = makeIssue({
      id: "c2",
      kind: "conversation",
      title: "Conversation: Forge",
      status: "blocked",
      updatedAt: new Date("2026-03-21T00:00:00Z"),
    });

    vi.mocked(issuesApi.list).mockResolvedValue([convo1, convo2]);

    const result = await listConversations("company-1");
    expect(result.map((i) => i.id)).toEqual(["c2", "c1"]);
    expect(issuesApi.list).toHaveBeenCalledWith("company-1", { kind: "conversation" });
  });

  it("excludes done/cancelled conversations by default", async () => {
    const open = makeIssue({
      id: "c1",
      kind: "conversation",
      title: "Conversation: Shadow",
      status: "blocked",
    });
    const done = makeIssue({
      id: "c2",
      kind: "conversation",
      title: "Conversation: Forge",
      status: "done",
    });
    const cancelled = makeIssue({
      id: "c3",
      kind: "conversation",
      title: "Conversation: Atlas",
      status: "cancelled",
    });

    vi.mocked(issuesApi.list).mockResolvedValue([open, done, cancelled]);

    const result = await listConversations("company-1");
    expect(result.map((i) => i.id)).toEqual(["c1"]);
  });

  it("includes closed conversations when includeClosed is true", async () => {
    const open = makeIssue({
      id: "c1",
      kind: "conversation",
      title: "Conversation: Shadow",
      status: "blocked",
      updatedAt: new Date("2026-03-20T00:00:00Z"),
    });
    const done = makeIssue({
      id: "c2",
      kind: "conversation",
      title: "Conversation: Forge",
      status: "done",
      updatedAt: new Date("2026-03-21T00:00:00Z"),
    });

    vi.mocked(issuesApi.list).mockResolvedValue([open, done]);

    const result = await listConversations("company-1", { includeClosed: true });
    expect(result.map((i) => i.id)).toEqual(["c2", "c1"]);
  });
});

// ─── ensureConversation ─────────────────────────────────────────────────────

describe("ensureConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an existing conversation if one exists", async () => {
    const existing = makeIssue({
      id: "existing",
      kind: "conversation",
      title: "Conversation: Shadow",
      status: "blocked",
      assigneeAgentId: "agent-1",
    });

    vi.mocked(issuesApi.list).mockResolvedValue([existing]);

    const result = await ensureConversation("company-1", "agent-1", "Shadow");
    expect(result.id).toBe("existing");
    expect(issuesApi.create).not.toHaveBeenCalled();
  });

  it("creates a new conversation when none exists", async () => {
    const created = makeIssue({
      id: "new-convo",
      title: `${CONVERSATION_PREFIX}Shadow`,
      status: "blocked",
      assigneeAgentId: "agent-1",
    });

    vi.mocked(issuesApi.list).mockResolvedValue([]);
    vi.mocked(issuesApi.create).mockResolvedValue(created);

    const result = await ensureConversation("company-1", "agent-1", "Shadow");
    expect(result.id).toBe("new-convo");
    expect(issuesApi.create).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent calls for the same agent", async () => {
    const created = makeIssue({
      id: "deduped",
      title: `${CONVERSATION_PREFIX}Shadow`,
      status: "blocked",
      assigneeAgentId: "agent-1",
    });

    vi.mocked(issuesApi.list).mockResolvedValue([]);
    vi.mocked(issuesApi.create).mockResolvedValue(created);

    const [result1, result2] = await Promise.all([
      ensureConversation("company-1", "agent-1", "Shadow"),
      ensureConversation("company-1", "agent-1", "Shadow"),
    ]);

    expect(result1.id).toBe("deduped");
    expect(result2.id).toBe("deduped");
    expect(issuesApi.list).toHaveBeenCalledOnce();
    expect(issuesApi.create).toHaveBeenCalledOnce();
  });

  it("allows separate calls for different agents", async () => {
    const convo1 = makeIssue({
      id: "convo-1",
      title: `${CONVERSATION_PREFIX}Shadow`,
      assigneeAgentId: "agent-1",
    });
    const convo2 = makeIssue({
      id: "convo-2",
      title: `${CONVERSATION_PREFIX}Forge`,
      assigneeAgentId: "agent-2",
    });

    vi.mocked(issuesApi.list).mockResolvedValue([]);
    vi.mocked(issuesApi.create)
      .mockResolvedValueOnce(convo1)
      .mockResolvedValueOnce(convo2);

    const [result1, result2] = await Promise.all([
      ensureConversation("company-1", "agent-1", "Shadow"),
      ensureConversation("company-1", "agent-2", "Forge"),
    ]);

    expect(result1.id).toBe("convo-1");
    expect(result2.id).toBe("convo-2");
    expect(issuesApi.create).toHaveBeenCalledTimes(2);
  });

  it("cleans up the in-flight map after failure", async () => {
    vi.mocked(issuesApi.list).mockRejectedValueOnce(new Error("network error"));

    await expect(
      ensureConversation("company-1", "agent-1", "Shadow"),
    ).rejects.toThrow("network error");

    // Second call should attempt fresh, not return the failed promise
    const created = makeIssue({ id: "retry-ok" });
    vi.mocked(issuesApi.list).mockResolvedValue([]);
    vi.mocked(issuesApi.create).mockResolvedValue(created);

    const result = await ensureConversation("company-1", "agent-1", "Shadow");
    expect(result.id).toBe("retry-ok");
  });
});

// ─── sendMessage ────────────────────────────────────────────────────────────

describe("sendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok: true when both comment and wakeup succeed", async () => {
    vi.mocked(issuesApi.addComment).mockResolvedValue(undefined as never);
    vi.mocked(agentsApi.wakeup).mockResolvedValue(undefined as never);

    const result = await sendMessage("issue-1", "agent-1", "hello");
    expect(result).toEqual({ ok: true });
    expect(issuesApi.addComment).toHaveBeenCalledWith("issue-1", "hello", true);
    expect(agentsApi.wakeup).toHaveBeenCalledWith(
      "agent-1",
      {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "conversation_reply",
        payload: { issueId: "issue-1" },
      },
      undefined,
    );
  });

  it("returns ok: false with wakeupError when wakeup fails", async () => {
    const wakeupErr = new Error("agent busy");
    vi.mocked(issuesApi.addComment).mockResolvedValue(undefined as never);
    vi.mocked(agentsApi.wakeup).mockRejectedValue(wakeupErr);

    const result = await sendMessage("issue-1", "agent-1", "hello");
    expect(result).toEqual({ ok: false, wakeupError: wakeupErr });
    expect(issuesApi.addComment).toHaveBeenCalledOnce();
  });

  it("throws when addComment fails (comment is the primary action)", async () => {
    vi.mocked(issuesApi.addComment).mockRejectedValue(new Error("forbidden"));

    await expect(
      sendMessage("issue-1", "agent-1", "hello"),
    ).rejects.toThrow("forbidden");
    expect(agentsApi.wakeup).not.toHaveBeenCalled();
  });

  it("passes companyId through to wakeup", async () => {
    vi.mocked(issuesApi.addComment).mockResolvedValue(undefined as never);
    vi.mocked(agentsApi.wakeup).mockResolvedValue(undefined as never);

    await sendMessage("issue-1", "agent-1", "hello", "company-1");
    expect(agentsApi.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.any(Object),
      "company-1",
    );
  });
});
