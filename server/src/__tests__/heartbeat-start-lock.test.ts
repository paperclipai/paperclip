import { afterEach, describe, expect, it } from "vitest";
import { createAgentStartLockController } from "../services/agent-start-lock.js";

const controller = createAgentStartLockController();

describe("heartbeat queued-run start lock", () => {
  afterEach(() => {
    controller.clear();
  });

  it("waits for an existing aged lock instead of clearing it", async () => {
    const started: string[] = [];
    let releaseExistingLock: (() => void) | null = null;
    const existingLock = new Promise<void>((resolve) => {
      releaseExistingLock = resolve;
    });
    controller.seed("agent-1", Date.now() - 31_000, existingLock);

    const queuedStart = controller.withAgentStartLock("agent-1", async () => {
      started.push("started");
    });

    await Promise.resolve();
    expect(started).toEqual([]);

    releaseExistingLock?.();
    await queuedStart;

    expect(started).toEqual(["started"]);
  });
});
