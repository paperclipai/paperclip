import { describe, expect, it } from "vitest";
import {
  closeReadinessDemandOptionsFromEnv,
  createCloseReadinessDemandLimiter,
} from "./execution-workspace-close-readiness-demand.js";

describe("CloseReadinessDemandLimiter", () => {
  it("loads bounded defaults and environment overrides", () => {
    expect(closeReadinessDemandOptionsFromEnv({})).toEqual({
      maxWaiters: 64,
      maxWaitersPerWorkspace: 8,
      maxWaitersPerTenant: 32,
    });
    expect(closeReadinessDemandOptionsFromEnv({
      PAPERCLIP_CLOSE_READINESS_GLOBAL_WAITER_CAP: "20",
      PAPERCLIP_CLOSE_READINESS_PER_WORKSPACE_WAITER_CAP: "4",
      PAPERCLIP_CLOSE_READINESS_PER_TENANT_WAITER_CAP: "6",
    })).toEqual({
      maxWaiters: 20,
      maxWaitersPerWorkspace: 4,
      maxWaitersPerTenant: 6,
    });
  });

  it("enforces global, workspace, and tenant caps without leaking counter keys", () => {
    const limiter = createCloseReadinessDemandLimiter({
      maxWaiters: 4,
      maxWaitersPerWorkspace: 2,
      maxWaitersPerTenant: 3,
    });
    const releaseA1 = limiter.acquire({ workspaceKey: "a", tenantKey: "tenant-1" });
    const releaseA2 = limiter.acquire({ workspaceKey: "a", tenantKey: "tenant-1" });
    expect(() => limiter.acquire({ workspaceKey: "a", tenantKey: "tenant-2" })).toThrow(
      expect.objectContaining({ status: 503 }),
    );
    const releaseB = limiter.acquire({ workspaceKey: "b", tenantKey: "tenant-1" });
    expect(() => limiter.acquire({ workspaceKey: "c", tenantKey: "tenant-1" })).toThrow(
      expect.objectContaining({ status: 503 }),
    );
    const releaseC = limiter.acquire({ workspaceKey: "c", tenantKey: "tenant-2" });
    expect(() => limiter.acquire({ workspaceKey: "d", tenantKey: "tenant-3" })).toThrow(
      expect.objectContaining({ status: 503 }),
    );

    releaseA1();
    releaseA1();
    releaseA2();
    releaseB();
    releaseC();
    expect(limiter.snapshot()).toMatchObject({
      waiterCount: 0,
      workspaceKeyCount: 0,
      tenantKeyCount: 0,
      peakWaiters: 4,
      totals: { admitted: 4, rejected: 3 },
    });
  });

  it("records aborted, timed-out, and degraded outcomes", () => {
    const limiter = createCloseReadinessDemandLimiter();
    limiter.recordAborted();
    limiter.recordTimedOut();
    limiter.recordDegraded();
    expect(limiter.snapshot().totals).toMatchObject({
      aborted: 1,
      timedOut: 1,
      degraded: 1,
    });
  });
});
