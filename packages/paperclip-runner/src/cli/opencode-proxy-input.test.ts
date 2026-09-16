import { describe, expect, it } from "vitest";

import { enqueueOpenCodeProxyInput } from "./opencode-proxy-input.js";

describe("OpenCode proxy input sequencing", () => {
  it("drains requests in order before EOF shutdown", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    let pending = Promise.resolve();
    pending = enqueueOpenCodeProxyInput(
      pending,
      async () => {
        events.push("initialize:start");
        await firstBlocked;
        events.push("initialize:complete");
      },
      () => events.push("initialize:error"),
    );
    pending = enqueueOpenCodeProxyInput(
      pending,
      async () => {
        events.push("thread:start");
      },
      () => events.push("thread:error"),
    );
    const shutdown = pending.then(() => {
      events.push("shutdown");
    });

    await Promise.resolve();
    expect(events).toEqual(["initialize:start"]);
    releaseFirst();
    await shutdown;
    expect(events).toEqual([
      "initialize:start",
      "initialize:complete",
      "thread:start",
      "shutdown",
    ]);
  });

  it("reports a failed queued request without rejecting the drain", async () => {
    const events: string[] = [];
    let pending = Promise.resolve();
    pending = enqueueOpenCodeProxyInput(
      pending,
      async () => {
        throw new Error("initialize failed");
      },
      (error) => events.push((error as Error).message),
    );

    await pending;
    expect(events).toEqual(["initialize failed"]);
  });
});
