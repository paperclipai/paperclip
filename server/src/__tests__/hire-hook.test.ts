import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { notifyHireApproved } from "../services/hire-hook.js";

// Mock the registry so we control whether the adapter has onHireApproved and what it does.
vi.mock("../adapters/registry.js", () => ({
  findServerAdapter: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

const { findServerAdapter } = await import("../adapters/registry.js");
const { logActivity } = await import("../services/activity-log.js");

function mockDbWithAgent(agent: { id: string; companyId: string; name: string; adapterType: string; adapterConfig?: Record<string, unknown> }): Db {
  return {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            {
              id: agent.id,
              companyId: agent.companyId,
              name: agent.name,
              adapterType: agent.adapterType,
              adapterConfig: agent.adapterConfig ?? {},
            },
          ]),
      }),
    }),
  } as unknown as Db;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("notifyHireApproved", () => {
  it("writes success activity when adapter hook returns ok", async () => {
    vi.mocked(findServerAdapter).mockReturnValue({
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

    expect(findServerAdapter).not.toHaveBeenCalled();
  });

  it("does nothing when adapter has no onHireApproved", async () => {
    vi.mocked(findServerAdapter).mockReturnValue({ type: "process" } as any);

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

    expect(findServerAdapter).toHaveBeenCalledWith("process");
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("logs failed result when adapter onHireApproved returns ok=false", async () => {
    vi.mocked(findServerAdapter).mockReturnValue({
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
    vi.mocked(findServerAdapter).mockReturnValue({
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
