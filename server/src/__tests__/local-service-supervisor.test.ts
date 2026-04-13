import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listLocalServiceRegistryRecords,
  writeLocalServiceRegistryRecord,
} from "../services/local-service-supervisor.js";

describe("local service supervisor", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  let paperclipHome = "";

  beforeEach(async () => {
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-local-service-supervisor-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
  });

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    await fs.rm(paperclipHome, { recursive: true, force: true });
  });

  it("prunes stale registry records whose pid is no longer alive", async () => {
    await writeLocalServiceRegistryRecord({
      version: 1,
      serviceKey: "paperclip-dev-test-dead",
      profileKind: "paperclip-dev",
      serviceName: "paperclip-dev-watch",
      command: "dev-runner.ts",
      cwd: "/tmp/repo",
      envFingerprint: "test",
      port: 3100,
      url: "http://127.0.0.1:3100",
      pid: 999_999,
      processGroupId: null,
      provider: "local_process",
      runtimeServiceId: null,
      reuseKey: null,
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      metadata: { repoRoot: "/tmp/repo" },
    });

    const records = await listLocalServiceRegistryRecords({ profileKind: "paperclip-dev" });

    expect(records).toEqual([]);
    await expect(
      fs.access(path.join(paperclipHome, "instances", "default", "runtime-services", "paperclip-dev-test-dead.json")),
    ).rejects.toThrow();
  });

  it("keeps live registry records", async () => {
    await writeLocalServiceRegistryRecord({
      version: 1,
      serviceKey: "paperclip-dev-test-live",
      profileKind: "paperclip-dev",
      serviceName: "paperclip-dev-watch",
      command: "vitest",
      cwd: process.cwd(),
      envFingerprint: "test",
      port: null,
      url: null,
      pid: process.pid,
      processGroupId: null,
      provider: "local_process",
      runtimeServiceId: null,
      reuseKey: null,
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      metadata: { repoRoot: process.cwd() },
    });

    const records = await listLocalServiceRegistryRecords({ profileKind: "paperclip-dev" });

    expect(records).toHaveLength(1);
    expect(records[0]?.serviceKey).toBe("paperclip-dev-test-live");
  });
});
