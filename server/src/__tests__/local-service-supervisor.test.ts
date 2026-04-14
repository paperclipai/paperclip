import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findAdoptableLocalService,
  readLocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
} from "../services/local-service-supervisor.ts";

const originalPaperclipHome = process.env.PAPERCLIP_HOME;
const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

async function withTempPaperclipHome<T>(fn: (tempHome: string) => Promise<T>) {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-local-service-"));
  process.env.PAPERCLIP_HOME = tempHome;
  process.env.PAPERCLIP_INSTANCE_ID = "test";
  try {
    return await fn(tempHome);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

afterEach(() => {
  if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalPaperclipHome;
  if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
});

describe("findAdoptableLocalService", () => {
  it("drops stale registry records when the tracked child pid is gone", async () => {
    await withTempPaperclipHome(async () => {
      await writeLocalServiceRegistryRecord({
        version: 1,
        serviceKey: "paperclip-dev-test",
        profileKind: "paperclip-dev",
        serviceName: "paperclip-dev-watch",
        command: "dev-runner.ts",
        cwd: "C:\\Users\\User\\paperclip",
        envFingerprint: "env-fingerprint",
        port: 3100,
        url: "http://127.0.0.1:3100",
        pid: process.pid,
        processGroupId: null,
        provider: "local_process",
        runtimeServiceId: null,
        reuseKey: null,
        startedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        metadata: {
          childPid: 999_999_999,
          url: "http://127.0.0.1:3100",
        },
      });

      const adopted = await findAdoptableLocalService({
        serviceKey: "paperclip-dev-test",
        cwd: "C:\\Users\\User\\paperclip",
        envFingerprint: "env-fingerprint",
        port: 3100,
      });

      expect(adopted).toBeNull();
      await expect(readLocalServiceRegistryRecord("paperclip-dev-test")).resolves.toBeNull();
    });
  });
});
