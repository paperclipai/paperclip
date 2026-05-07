import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { notifyHireApproved } from "../services/hire-hook.js";

// Mock the registry so we control whether the adapter has onHireApproved and what it does.
vi.mock("../adapters/registry.js", () => ({
  findActiveServerAdapter: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(),
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: vi.fn(),
}));

const { findActiveServerAdapter } = await import("../adapters/registry.js");
const { logActivity } = await import("../services/activity-log.js");
const { issueService } = await import("../services/issues.js");
const { heartbeatService } = await import("../services/heartbeat.js");

const listIssues = vi.fn();
const createIssue = vi.fn();
const wakeup = vi.fn();

function mockDbWithAgent(agent: {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
}, options: {
  wakeupRequests?: Array<{ id: string }>;
} = {}): Db {
  return {
    select: (selection?: unknown) => ({
      from: () => ({
        where: () => {
          if (selection && typeof selection === "object" && "id" in selection) {
            return {
              limit: () => Promise.resolve(options.wakeupRequests ?? []),
            };
          }
          return Promise.resolve([
            {
              id: agent.id,
              companyId: agent.companyId,
              name: agent.name,
              adapterType: agent.adapterType,
              adapterConfig: agent.adapterConfig ?? {},
            },
          ]);
        },
      }),
    }),
  } as unknown as Db;
}

afterEach(() => {
  vi.clearAllMocks();
  listIssues.mockReset();
  createIssue.mockReset();
  wakeup.mockReset();
});

function mockKickoffServices(options: {
  existingIssue?: { id: string; assigneeAgentId: string | null; status: string } | null;
} = {}) {
  listIssues.mockResolvedValue(options.existingIssue ? [options.existingIssue] : []);
  createIssue.mockResolvedValue({ id: "kickoff-1", assigneeAgentId: "a1", status: "todo" });
  wakeup.mockResolvedValue({ id: "wake-1" });
  vi.mocked(issueService).mockReturnValue({
    list: listIssues,
    create: createIssue,
  } as any);
  vi.mocked(heartbeatService).mockReturnValue({ wakeup } as any);
}

describe("notifyHireApproved", () => {
  beforeEach(() => {
    mockKickoffServices();
  });
  it("writes success activity when adapter hook returns ok", async () => {
    vi.mocked(findActiveServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved: vi.fn().mockResolvedValue({ ok: true }),
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "approval",
        sourceId: "ap1",
      }),
    ).resolves.toBeUndefined();

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.succeeded",
        entityId: "a1",
        details: expect.objectContaining({ source: "approval", sourceId: "ap1", adapterType: "openclaw_gateway" }),
      }),
    );
  });

  it("does nothing when agent is not found", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    } as unknown as Db;

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "join_request",
        sourceId: "jr1",
      }),
    ).resolves.toBeUndefined();

    expect(findActiveServerAdapter).not.toHaveBeenCalled();
  });

  it("does not throw when loading the agent fails", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.reject(new Error("database unavailable")),
        }),
      }),
    } as unknown as Db;

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "approval",
        sourceId: "ap1",
      }),
    ).resolves.toBeUndefined();

    expect(findActiveServerAdapter).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.error",
        entityId: "a1",
        details: expect.objectContaining({ error: "database unavailable" }),
      }),
    );
  });

  it("creates kickoff issue even when adapter has no onHireApproved", async () => {
    vi.mocked(findActiveServerAdapter).mockReturnValue({ type: "process" } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "Agent",
      adapterType: "process",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "approval",
        sourceId: "ap1",
      }),
    ).resolves.toBeUndefined();

    expect(listIssues).toHaveBeenCalledWith("c1", {
      originKind: "hire_kickoff",
      originId: "a1",
      limit: 1,
    });
    expect(createIssue).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        assigneeAgentId: "a1",
        status: "todo",
        priority: "high",
        originKind: "hire_kickoff",
        originId: "a1",
      }),
    );
    expect(wakeup).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({
        reason: "hire_kickoff",
        payload: { issueId: "kickoff-1", mutation: "hire_approved" },
      }),
    );
    expect(findActiveServerAdapter).toHaveBeenCalledWith("process");
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_kickoff.created",
        entityId: "kickoff-1",
      }),
    );
  });

  it("does not create a duplicate kickoff issue when one already exists and was already woken", async () => {
    mockKickoffServices({ existingIssue: { id: "existing-kickoff", assigneeAgentId: "a1", status: "todo" } });
    vi.mocked(findActiveServerAdapter).mockReturnValue({ type: "process" } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "Agent",
      adapterType: "process",
    }, {
      wakeupRequests: [{ id: "wake-existing" }],
    });

    await notifyHireApproved(db, {
      companyId: "c1",
      agentId: "a1",
      source: "approval",
      sourceId: "ap1",
    });

    expect(createIssue).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("retries kickoff wakeup for an existing issue without a prior wakeup request", async () => {
    mockKickoffServices({ existingIssue: { id: "existing-kickoff", assigneeAgentId: "a1", status: "todo" } });
    vi.mocked(findActiveServerAdapter).mockReturnValue({ type: "process" } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "Agent",
      adapterType: "process",
    });

    await notifyHireApproved(db, {
      companyId: "c1",
      agentId: "a1",
      source: "approval",
      sourceId: "ap1",
    });

    expect(createIssue).not.toHaveBeenCalled();
    expect(wakeup).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({
        reason: "hire_kickoff",
        payload: { issueId: "existing-kickoff", mutation: "hire_approved" },
      }),
    );
  });

  it("logs kickoff creation even when queuing the kickoff wakeup fails", async () => {
    vi.mocked(findActiveServerAdapter).mockReturnValue({ type: "process" } as any);
    wakeup.mockRejectedValue(new Error("queue down"));

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "Agent",
      adapterType: "process",
    });

    await notifyHireApproved(db, {
      companyId: "c1",
      agentId: "a1",
      source: "approval",
      sourceId: "ap1",
    });

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_kickoff.created",
        entityId: "kickoff-1",
      }),
    );
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_kickoff.wakeup_failed",
        entityId: "kickoff-1",
        details: expect.objectContaining({ error: "queue down" }),
      }),
    );
    expect(logActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_kickoff.failed",
      }),
    );
  });

  it("logs failed result when adapter onHireApproved returns ok=false", async () => {
    vi.mocked(findActiveServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved: vi.fn().mockResolvedValue({ ok: false, error: "HTTP 500", detail: { status: 500 } }),
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "join_request",
        sourceId: "jr1",
      }),
    ).resolves.toBeUndefined();

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.failed",
        entityId: "a1",
        details: expect.objectContaining({ source: "join_request", sourceId: "jr1", error: "HTTP 500" }),
      }),
    );
  });

  it("does not throw when adapter onHireApproved throws (non-fatal)", async () => {
    vi.mocked(findActiveServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved: vi.fn().mockRejectedValue(new Error("Network error")),
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "join_request",
        sourceId: "jr1",
      }),
    ).resolves.toBeUndefined();

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.error",
        entityId: "a1",
        details: expect.objectContaining({ source: "join_request", sourceId: "jr1", error: "Network error" }),
      }),
    );
  });
});
