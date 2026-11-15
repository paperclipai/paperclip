import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as p from "@clack/prompts";
import { doctor } from "../commands/doctor.js";
import { writeConfig } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";
import type { DiskSpaceCheckDeps } from "../checks/disk-space-check.js";

const ORIGINAL_ENV = { ...process.env };

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function createTempConfig(serverPort: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-doctor-"));
  const configPath = path.join(root, ".paperclip", "config.json");
  const runtimeRoot = path.join(root, "runtime");

  const config: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: "2026-03-10T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(runtimeRoot, "db"),
      embeddedPostgresPort: 55432,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(runtimeRoot, "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(runtimeRoot, "logs"),
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: serverPort,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(runtimeRoot, "storage"),
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(runtimeRoot, "secrets", "master.key"),
      },
    },
  };

  writeConfig(config, configPath);
  return configPath;
}

function diskSpaceProbe(free: bigint, total: bigint = 100n * 1024n ** 3n): DiskSpaceCheckDeps {
  const bsize = 4096n;
  return {
    stat: async () => ({ dev: 1 }),
    statfs: async () => ({
      bavail: free / bsize,
      blocks: total / bsize,
      bsize,
    }),
  };
}

const HEALTHY_DISK = diskSpaceProbe(61n * 1024n ** 3n);
const LOW_DISK = diskSpaceProbe(256n * 1024n ** 2n);

describe("doctor", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("re-runs repairable checks so repaired failures do not remain blocking", async () => {
    const configPath = createTempConfig(await availablePort());

    const summary = await doctor({
      config: configPath,
      repair: true,
      yes: true,
      diskSpace: HEALTHY_DISK,
    });

    expect(summary.failed).toBe(0);
    expect(summary.warned).toBe(0);
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBeTruthy();
  });

  it("runs the disk space check after the log directory check and counts it in the summary", async () => {
    const messages: string[] = [];
    vi.spyOn(p.log, "message").mockImplementation((line) => {
      messages.push(String(line));
    });
    const configPath = createTempConfig(await availablePort());
    const summary = await doctor({
      config: configPath,
      repair: true,
      yes: true,
      diskSpace: HEALTHY_DISK,
    });
    const logIndex = messages.findIndex((line) => line.includes("Log directory"));
    const diskIndex = messages.findIndex((line) => line.includes("Disk space"));
    const portIndex = messages.findIndex((line) => line.includes("Server port"));
    expect(logIndex).toBeGreaterThanOrEqual(0);
    expect(diskIndex).toBeGreaterThan(logIndex);
    expect(portIndex).toBeGreaterThan(diskIndex);
    expect(messages.filter((line) => line.includes("Disk space"))).toHaveLength(1);
    expect(summary.failed).toBe(0);
    expect(summary.warned).toBe(0);
    expect(summary.passed).toBeGreaterThan(0);
  });

  it("counts a disk space warning in the summary", async () => {
    const messages: string[] = [];
    vi.spyOn(p.log, "message").mockImplementation((line) => {
      messages.push(String(line));
    });
    const configPath = createTempConfig(await availablePort());
    const summary = await doctor({
      config: configPath,
      repair: true,
      yes: true,
      diskSpace: LOW_DISK,
    });
    expect(summary.failed).toBe(0);
    expect(summary.warned).toBeGreaterThan(0);
    expect(messages.some((line) => line.includes("Disk space") && line.includes("embedded Postgres"))).toBe(true);
  });
});

