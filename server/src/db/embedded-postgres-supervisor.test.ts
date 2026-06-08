import { describe, expect, it, vi } from "vitest";
import {
  createEmbeddedPostgresSupervisor,
  SUPERVISOR_THROTTLE_MS,
  SUPERVISOR_AUTO_RESET_MS,
  type EmbeddedPostgresSupervisorDeps,
  type SupervisorTimer,
} from "./embedded-postgres-supervisor.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

type ScheduledTask = { delayMs: number; fn: () => void; cleared: boolean };

function makeManualTimer(): SupervisorTimer & { advance(ms: number): void; tasks: ScheduledTask[]; nowOffset: number } {
  const tasks: ScheduledTask[] = [];
  return {
    nowOffset: 0,
    tasks,
    schedule(delayMs, fn) {
      const task: ScheduledTask = { delayMs, fn, cleared: false };
      tasks.push(task);
      const handle = { cleared: false, _task: task } as unknown as ScheduledTask & { cleared: boolean };
      Object.defineProperty(handle, "cleared", {
        get() {
          return task.cleared;
        },
        set(v: boolean) {
          task.cleared = v;
        },
      });
      return handle;
    },
    clear(handle) {
      const t = (handle as unknown as { _task?: ScheduledTask })._task;
      if (t) t.cleared = true;
    },
    advance(ms) {
      this.nowOffset += ms;
      const due = tasks.filter((t) => !t.cleared && t.delayMs <= ms);
      for (const t of due) {
        t.cleared = true;
        t.fn();
      }
      for (const t of tasks) {
        if (!t.cleared) t.delayMs -= ms;
      }
    },
  };
}

function makeClock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

function baseDeps(
  overrides: Partial<EmbeddedPostgresSupervisorDeps> = {},
): EmbeddedPostgresSupervisorDeps & { logger: ReturnType<typeof makeLogger> } {
  const logger = makeLogger();
  const defaults: EmbeddedPostgresSupervisorDeps = {
    embeddedPostgres: { start: async () => undefined, stop: async () => undefined },
    dataDir: "/tmp/datadir",
    port: 5432,
    logger,
    isProcessAlive: () => false,
    readPidFile: () => null,
    removePidFile: () => undefined,
  };
  return { ...defaults, ...overrides, logger };
}

describe("embedded postgres supervisor", () => {
  it("restarts on first health trigger and logs attempt + success", async () => {
    const start = vi.fn(async () => undefined);
    const clock = makeClock();
    const sv = createEmbeddedPostgresSupervisor(baseDeps({
      embeddedPostgres: { start },
      now: clock.now,
      timer: makeManualTimer(),
    }));

    await sv.recoverIfUnhealthy("health");

    expect(start).toHaveBeenCalledTimes(1);
    expect(sv.state()).toBe("idle");
  });

  it("respects the 30 s throttle between attempts", async () => {
    const start = vi.fn(async () => undefined);
    const clock = makeClock();
    const deps = baseDeps({ embeddedPostgres: { start }, now: clock.now, timer: makeManualTimer() });
    const sv = createEmbeddedPostgresSupervisor(deps);

    await sv.recoverIfUnhealthy("health");
    clock.advance(SUPERVISOR_THROTTLE_MS - 1);
    await sv.recoverIfUnhealthy("health");

    expect(start).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn.mock.calls.some((c) => String(c[1]).includes("postgres_restart_throttled"))).toBe(true);

    clock.advance(2);
    await sv.recoverIfUnhealthy("health");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("enters gave_up after three failed attempts in the 5-min window", async () => {
    const start = vi.fn(async () => {
      throw new Error("start failed");
    });
    const clock = makeClock();
    const timer = makeManualTimer();
    const deps = baseDeps({ embeddedPostgres: { start }, now: clock.now, timer });
    const sv = createEmbeddedPostgresSupervisor(deps);

    await sv.recoverIfUnhealthy("health");
    clock.advance(SUPERVISOR_THROTTLE_MS + 1);
    await sv.recoverIfUnhealthy("health");
    clock.advance(45_000 + 1);
    await sv.recoverIfUnhealthy("health");

    expect(sv.state()).toBe("gave_up");
    expect(deps.logger.error.mock.calls.some((c) => String(c[1]).includes("postgres_restart_giveup"))).toBe(true);

    clock.advance(SUPERVISOR_THROTTLE_MS + 1);
    await sv.recoverIfUnhealthy("health");
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("removes a stale postmaster.pid before starting when the recorded process is dead", async () => {
    const removePidFile = vi.fn();
    const start = vi.fn(async () => undefined);
    const sv = createEmbeddedPostgresSupervisor(
      baseDeps({
        embeddedPostgres: { start },
        readPidFile: () => "12345\n",
        isProcessAlive: () => false,
        removePidFile,
        timer: makeManualTimer(),
      }),
    );

    await sv.recoverIfUnhealthy("health");

    expect(removePidFile).toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    const callOrder = (removePidFile.mock.invocationCallOrder[0] ?? 0) < (start.mock.invocationCallOrder[0] ?? 0);
    expect(callOrder).toBe(true);
  });

  it("calls stop before start when the recorded process is still alive", async () => {
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);
    const sv = createEmbeddedPostgresSupervisor(
      baseDeps({
        embeddedPostgres: { start, stop },
        readPidFile: () => "9999\n",
        isProcessAlive: () => true,
        timer: makeManualTimer(),
      }),
    );

    await sv.recoverIfUnhealthy("health");

    expect(stop).toHaveBeenCalledBefore(start);
  });

  it("auto-resets gave_up after the configured idle window", async () => {
    const start = vi.fn(async () => {
      throw new Error("nope");
    });
    const clock = makeClock();
    const timer = makeManualTimer();
    const deps = baseDeps({ embeddedPostgres: { start }, now: clock.now, timer });
    const sv = createEmbeddedPostgresSupervisor(deps);

    await sv.recoverIfUnhealthy("health");
    clock.advance(SUPERVISOR_THROTTLE_MS + 1);
    await sv.recoverIfUnhealthy("health");
    clock.advance(45_000 + 1);
    await sv.recoverIfUnhealthy("health");

    expect(sv.state()).toBe("gave_up");
    timer.advance(SUPERVISOR_AUTO_RESET_MS);
    expect(sv.state()).toBe("idle");
    expect(deps.logger.warn.mock.calls.some((c) => String(c[1]).includes("postgres_supervisor_giveup_reset"))).toBe(true);
  });

  it("manual resetGaveUp clears state and counters", async () => {
    const start = vi.fn(async () => {
      throw new Error("nope");
    });
    const clock = makeClock();
    const timer = makeManualTimer();
    const sv = createEmbeddedPostgresSupervisor(
      baseDeps({ embeddedPostgres: { start }, now: clock.now, timer }),
    );

    await sv.recoverIfUnhealthy("health");
    clock.advance(SUPERVISOR_THROTTLE_MS + 1);
    await sv.recoverIfUnhealthy("health");
    clock.advance(45_000 + 1);
    await sv.recoverIfUnhealthy("health");
    expect(sv.state()).toBe("gave_up");

    sv.resetGaveUp("test");
    expect(sv.state()).toBe("idle");

    clock.advance(SUPERVISOR_THROTTLE_MS + 1);
    start.mockImplementation((async () => undefined) as () => Promise<never>);
    await sv.recoverIfUnhealthy("health");
    expect(sv.state()).toBe("idle");
  });

  it("treats probe trigger like health for throttle accounting", async () => {
    const start = vi.fn(async () => undefined);
    const clock = makeClock();
    const sv = createEmbeddedPostgresSupervisor(
      baseDeps({ embeddedPostgres: { start }, now: clock.now, timer: makeManualTimer() }),
    );

    await sv.recoverIfUnhealthy("health");
    clock.advance(SUPERVISOR_THROTTLE_MS - 1);
    await sv.recoverIfUnhealthy("probe");

    expect(start).toHaveBeenCalledTimes(1);
  });
});
