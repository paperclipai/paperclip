import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeHotRestartIntent,
  getHotRestartIntentPath,
  writeHotRestartIntent,
} from "./hot-restart-intent.js";

const originalHome = process.env.PAPERCLIP_HOME;

afterEach(async () => {
  const current = process.env.PAPERCLIP_HOME;
  if (current) await fs.rm(current, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalHome;
});

describe("hot restart intent", () => {
  it("is consumed once and bound to the current server pid", async () => {
    process.env.PAPERCLIP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hot-restart-"));
    const now = new Date("2026-07-15T18:00:00.000Z");
    writeHotRestartIntent(now, 1234, { requestedByRunId: "run-1", drainRequired: true });

    expect(consumeHotRestartIntent(new Date(now.getTime() + 1_000), 1234)).toMatchObject({
      version: 1,
      serverPid: 1234,
      requestedByRunId: "run-1",
      drainRequired: true,
    });
    expect(consumeHotRestartIntent(new Date(now.getTime() + 2_000), 1234)).toBeNull();
    await expect(fs.stat(getHotRestartIntentPath())).rejects.toThrow();
  });

  it("rejects and consumes a marker for a different server process", async () => {
    process.env.PAPERCLIP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hot-restart-"));
    const now = new Date("2026-07-15T18:00:00.000Z");
    writeHotRestartIntent(now, 1234);

    expect(consumeHotRestartIntent(new Date(now.getTime() + 1_000), 5678)).toBeNull();
    expect(consumeHotRestartIntent(new Date(now.getTime() + 2_000), 1234)).toBeNull();
  });
});
