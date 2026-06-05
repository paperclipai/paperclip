import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { EmbeddedPostgresSupervisor } from "./embedded-postgres-supervisor.js";
import { createEmbeddedPostgresSelfProbe } from "./embedded-postgres-self-probe.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function makeSupervisor(): EmbeddedPostgresSupervisor {
  return {
    recoverIfUnhealthy: vi.fn().mockResolvedValue(undefined),
    resetGaveUp: vi.fn(),
    state: vi.fn().mockReturnValue("idle"),
    shutdown: vi.fn(),
  };
}

describe("embedded postgres self-probe", () => {
  it("does not trigger the supervisor when the health query succeeds", async () => {
    const supervisor = makeSupervisor();
    const probe = createEmbeddedPostgresSelfProbe({
      db: {} as Db,
      supervisor,
      logger: makeLogger(),
      runHealthQuery: async () => undefined,
    });

    await probe.runOnce();

    expect(supervisor.recoverIfUnhealthy).not.toHaveBeenCalled();
  });

  it("triggers supervisor.recoverIfUnhealthy('probe') exactly once when the query throws", async () => {
    const supervisor = makeSupervisor();
    const logger = makeLogger();
    const probe = createEmbeddedPostgresSelfProbe({
      db: {} as Db,
      supervisor,
      logger,
      runHealthQuery: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });

    await probe.runOnce();

    expect(supervisor.recoverIfUnhealthy).toHaveBeenCalledTimes(1);
    expect(supervisor.recoverIfUnhealthy).toHaveBeenCalledWith("probe");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "embedded_postgres_self_probe_failed",
    );
  });

  it("swallows supervisor errors so the timer does not crash the process", async () => {
    const supervisor: EmbeddedPostgresSupervisor = {
      recoverIfUnhealthy: vi.fn().mockRejectedValue(new Error("supervisor blew up")),
      resetGaveUp: vi.fn(),
      state: vi.fn().mockReturnValue("idle"),
      shutdown: vi.fn(),
    };
    const logger = makeLogger();
    const probe = createEmbeddedPostgresSelfProbe({
      db: {} as Db,
      supervisor,
      logger,
      runHealthQuery: async () => {
        throw new Error("nope");
      },
    });

    await expect(probe.runOnce()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "embedded postgres supervisor probe rejected",
    );
  });

  it("start schedules the probe and stop clears it without leaking the handle", async () => {
    vi.useFakeTimers();
    try {
      const supervisor = makeSupervisor();
      const runHealthQuery = vi.fn(async () => undefined);
      const probe = createEmbeddedPostgresSelfProbe({
        db: {} as Db,
        supervisor,
        logger: makeLogger(),
        intervalMs: 30_000,
        runHealthQuery,
      });

      probe.start();
      probe.start(); // double-start is a no-op
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runHealthQuery).toHaveBeenCalledTimes(2);

      probe.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runHealthQuery).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
