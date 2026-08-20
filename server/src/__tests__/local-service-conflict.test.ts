import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findConflictingLocalService,
  readLocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
  type LocalServiceRegistryRecord,
} from "../services/local-service-supervisor.ts";

const REPO_ROOT = "/tmp/paperclip-conflict-repo";
const PROFILE_KIND = "paperclip-dev";

let homeDir: string;
let previousHome: string | undefined;

function record(overrides: Partial<LocalServiceRegistryRecord>): LocalServiceRegistryRecord {
  return {
    version: 1,
    serviceKey: "paperclip-dev-paperclip-dev-watch-aaaa",
    profileKind: PROFILE_KIND,
    serviceName: "paperclip-dev-watch",
    command: "node",
    cwd: REPO_ROOT,
    envFingerprint: "watch-fingerprint",
    port: 3100,
    url: "http://127.0.0.1:3100",
    pid: process.pid,
    processGroupId: null,
    provider: "local_process",
    runtimeServiceId: null,
    reuseKey: null,
    startedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    metadata: null,
    ...overrides,
  };
}

const ownIdentity = {
  serviceKey: "paperclip-dev-paperclip-dev-once-bbbb",
  profileKind: PROFILE_KIND,
};

beforeEach(() => {
  previousHome = process.env.PAPERCLIP_HOME;
  homeDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-conflict-"));
  process.env.PAPERCLIP_HOME = homeDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe("findConflictingLocalService", () => {
  it("reports a live runner of a different mode that targets the same repo and port", async () => {
    await writeLocalServiceRegistryRecord(record({}));

    const conflict = await findConflictingLocalService(ownIdentity);

    expect(conflict?.serviceName).toBe("paperclip-dev-watch");
    expect(conflict?.pid).toBe(process.pid);
  });

  it("ignores the caller's own registry record", async () => {
    await writeLocalServiceRegistryRecord(
      record({ serviceKey: ownIdentity.serviceKey, serviceName: "paperclip-dev-once" }),
    );

    expect(await findConflictingLocalService(ownIdentity)).toBeNull();
  });

  it("reports a runner on a different port, which still shares the instance database", async () => {
    await writeLocalServiceRegistryRecord(
      record({ serviceKey: "paperclip-dev-other-port", port: 3199, url: "http://127.0.0.1:3199" }),
    );

    expect((await findConflictingLocalService(ownIdentity))?.port).toBe(3199);
  });

  it("reports a runner launched from a different checkout of the same instance", async () => {
    await writeLocalServiceRegistryRecord(
      record({ serviceKey: "paperclip-dev-other-repo", cwd: "/tmp/paperclip-other-repo" }),
    );

    expect((await findConflictingLocalService(ownIdentity))?.cwd).toBe("/tmp/paperclip-other-repo");
  });

  it("prunes the registry record of a runner whose process is gone", async () => {
    const stale = record({ serviceKey: "paperclip-dev-stale", pid: 2_147_483_600 });
    await writeLocalServiceRegistryRecord(stale);

    expect(await findConflictingLocalService(ownIdentity)).toBeNull();
    expect(await readLocalServiceRegistryRecord(stale.serviceKey)).toBeNull();
  });
});
