import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeContext } from "../client/context.js";
import { runAgentPrompt, runBoardPrompt } from "../commands/client/prompt.js";

const ORIGINAL_ENV = { ...process.env };

function createTempContextPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-prompt-"));
  return path.join(dir, "context.json");
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    name: "Worker",
    urlKey: "worker",
    role: "Engineer",
    status: "active",
    ...overrides,
  };
}

describe("prompt handoff", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_API_KEY;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("fails when an agent prompt uses a board persona profile", async () => {
    const contextPath = createTempContextPath();
    writeContext(
      {
        version: 2,
        currentProfile: "board",
        profiles: {
          board: {
            apiBase: "http://localhost:3100",
            persona: "board",
          },
        },
      },
      contextPath,
    );

    await expect(runAgentPrompt("worker", "Do the work", { context: contextPath, apiKey: "agent-token" }))
      .rejects
      .toThrow(/persona=board/);
  });

  it("fails when the supplied agent key belongs to a different agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(agent()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(runAgentPrompt("other-agent", "Do the work", {
      apiBase: "http://localhost:3100",
      apiKey: "agent-token",
    })).rejects.toThrow(/Agent key belongs to Worker/);
  });

  it("creates an assigned issue and wakes the authenticated agent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(agent()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "issue-1",
        companyId: "22222222-2222-4222-8222-222222222222",
        title: "Investigate queue lag",
        status: "todo",
        priority: "medium",
        assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-1", status: "queued" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runAgentPrompt("worker", "Investigate queue lag", {
      apiBase: "http://localhost:3100",
      apiKey: "agent-token",
    });

    expect(result.mode).toBe("issue");
    expect(result.agent.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:3100/api/companies/22222222-2222-4222-8222-222222222222/issues");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      title: "Investigate queue lag",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:3100/api/agents/11111111-1111-4111-8111-111111111111/wakeup");
  });

  it("fails when a board prompt uses an agent persona profile", async () => {
    const contextPath = createTempContextPath();
    writeContext(
      {
        version: 2,
        currentProfile: "agent",
        profiles: {
          agent: {
            apiBase: "http://localhost:3100",
            companyId: "22222222-2222-4222-8222-222222222222",
            persona: "agent",
            agentId: "11111111-1111-4111-8111-111111111111",
          },
        },
      },
      contextPath,
    );

    await expect(runBoardPrompt("worker", "Do the work", {
      context: contextPath,
      apiKey: "board-token",
    })).rejects.toThrow(/persona=agent/);
  });

  it("creates an assigned issue and wakes the target agent with board auth", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(agent()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "issue-1",
        companyId: "22222222-2222-4222-8222-222222222222",
        title: "Investigate queue lag",
        status: "todo",
        priority: "medium",
        assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-1", status: "queued" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBoardPrompt("worker", "Investigate queue lag", {
      apiBase: "http://localhost:3100",
      apiKey: "board-token",
      companyId: "22222222-2222-4222-8222-222222222222",
    });

    expect(result.actor).toBe("board");
    expect(result.mode).toBe("issue");
    expect(result.agent.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:3100/api/agents/worker?companyId=22222222-2222-4222-8222-222222222222",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://localhost:3100/api/companies/22222222-2222-4222-8222-222222222222/issues",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      description: "Investigate queue lag",
      title: "Investigate queue lag",
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "http://localhost:3100/api/agents/11111111-1111-4111-8111-111111111111/wakeup",
    );
  });

  it("adds a board-authored prompt comment without waking when disabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(agent()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "comment-1",
        issueId: "issue-1",
        body: "Follow up on queue lag",
      }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBoardPrompt("worker", "Follow up on queue lag", {
      apiBase: "http://localhost:3100",
      apiKey: "board-token",
      companyId: "22222222-2222-4222-8222-222222222222",
      issue: "issue-1",
      wake: false,
    });

    expect(result.actor).toBe("board");
    expect(result.mode).toBe("comment");
    expect(result.wakeup).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:3100/api/issues/issue-1/comments");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      body: "Follow up on queue lag",
      resume: false,
    });
  });
});
