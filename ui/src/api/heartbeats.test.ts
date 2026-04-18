import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { heartbeatsApi } from "./heartbeats";

describe("heartbeatsApi live run sanitization", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
  });

  it("filters malformed live run records for issue and company requests", async () => {
    mockApi.get.mockResolvedValueOnce([
      null,
      {
        id: "run-1",
        status: "running",
        invocationSource: "automation",
        triggerDetail: "system",
        startedAt: "2026-04-18T10:47:42.553Z",
        finishedAt: null,
        createdAt: "2026-04-18T10:47:42.545Z",
        agentId: "agent-1",
        agentName: "Founding Engineer",
        adapterType: "claude_local",
        issueId: "issue-1",
      },
      {
        id: "",
        status: "running",
        invocationSource: "automation",
        createdAt: "2026-04-18T10:47:42.545Z",
        agentId: "agent-2",
        agentName: "Broken",
        adapterType: "claude_local",
      },
    ]);
    mockApi.get.mockResolvedValueOnce([
      {
        id: "run-2",
        status: "queued",
        invocationSource: "manual",
        triggerDetail: null,
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-04-18T10:50:00.000Z",
        agentId: "agent-2",
        agentName: "Reviewer",
        adapterType: "codex_local",
        issueId: null,
      },
      { foo: "bar" },
    ]);

    await expect(heartbeatsApi.liveRunsForIssue("issue-1")).resolves.toEqual([
      expect.objectContaining({ id: "run-1", agentId: "agent-1" }),
    ]);
    await expect(heartbeatsApi.liveRunsForCompany("company-1")).resolves.toEqual([
      expect.objectContaining({ id: "run-2", agentId: "agent-2" }),
    ]);
  });

  it("returns null for malformed active run payloads", async () => {
    mockApi.get.mockResolvedValueOnce({ id: null, status: "running" });
    mockApi.get.mockResolvedValueOnce({
      id: "run-3",
      status: "running",
      invocationSource: "automation",
      triggerDetail: "system",
      startedAt: "2026-04-18T10:47:42.553Z",
      finishedAt: null,
      createdAt: "2026-04-18T10:47:42.545Z",
      agentId: "agent-3",
      agentName: "Founder",
      adapterType: "claude_local",
      issueId: "issue-3",
    });

    await expect(heartbeatsApi.activeRunForIssue("issue-1")).resolves.toBeNull();
    await expect(heartbeatsApi.activeRunForIssue("issue-3")).resolves.toEqual(
      expect.objectContaining({ id: "run-3", agentId: "agent-3" }),
    );
  });
});
