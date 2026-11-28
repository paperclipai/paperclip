import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diskSpaceCheck,
  type DiskSpaceCheckDeps,
  type DiskSpaceStat,
  type DiskSpaceStatFs,
} from "../checks/disk-space-check.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_ENV = { ...process.env };
const BSIZE = 4096n;
const MIB = 1024n ** 2n;
const GIB = 1024n ** 3n;

type VolumeEntry = {
  dev: number;
  bavail?: bigint;
  blocks?: bigint;
  bsize?: bigint;
};

function volume(dev: number, total: bigint, free: bigint): VolumeEntry {
  return {
    dev,
    bsize: BSIZE,
    blocks: total / BSIZE,
    bavail: free / BSIZE,
  };
}

function withAncestors(entries: Record<string, VolumeEntry>): Record<string, VolumeEntry> {
  const table: Record<string, VolumeEntry> = {};
  for (const [target, entry] of Object.entries(entries)) {
    table[path.resolve(target)] = entry;
  }
  const explicit = new Set(Object.keys(table));
  for (const [target, entry] of Object.entries(entries)) {
    let current = path.resolve(target);
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) break;
      if (parent === "/" && !explicit.has("/")) break;
      if (!table[parent]) table[parent] = { dev: entry.dev };
      current = parent;
    }
  }
  return table;
}

function fakeFs(entries: Record<string, VolumeEntry>): DiskSpaceCheckDeps {
  const table = new Map(Object.entries(withAncestors(entries)));
  return {
    async stat(target: string): Promise<DiskSpaceStat> {
      const entry = table.get(path.resolve(target));
      if (!entry) {
        const err = new Error(`ENOENT: no such file or directory, stat '${target}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return { dev: entry.dev };
    },
    async statfs(target: string, _opts: { bigint: true }): Promise<DiskSpaceStatFs> {
      const entry = table.get(path.resolve(target));
      if (!entry || entry.bavail === undefined || entry.blocks === undefined || entry.bsize === undefined) {
        throw new Error(`statfs failed: ${target}`);
      }
      return {
        bavail: entry.bavail,
        blocks: entry.blocks,
        bsize: entry.bsize,
      };
    },
  };
}

function makeConfig(root: string, overrides: {
  mode?: "embedded-postgres" | "postgres";
  dataDir?: string;
  storageDir?: string;
  storageProvider?: "local_disk" | "s3";
  logDir?: string;
  backupDir?: string;
} = {}): PaperclipConfig {
  return {
    database: {
      mode: overrides.mode ?? "embedded-postgres",
      embeddedPostgresDataDir: overrides.dataDir ?? path.join(root, "db"),
      embeddedPostgresPort: 54321,
      connectionString: overrides.mode === "postgres" ? "postgres://paperclip@127.0.0.1/paperclip" : undefined,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: overrides.backupDir ?? path.join(root, "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: overrides.logDir ?? path.join(root, "logs"),
    },
    storage: {
      provider: overrides.storageProvider ?? "local_disk",
      localDisk: {
        baseDir: overrides.storageDir ?? path.join(root, "storage"),
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
  } as unknown as PaperclipConfig;
}

function layout(root: string) {
  const home = path.join(root, "home");
  const instance = path.join(home, "instances", "default");
  const runtime = path.join(root, "runtime");
  return {
    home,
    instance,
    data: path.join(runtime, "db"),
    storage: path.join(runtime, "storage"),
    logs: path.join(runtime, "logs"),
    backups: path.join(runtime, "backups"),
    configPath: path.join(root, "config.json"),
  };
}

function useHome(home: string): void {
  process.env.PAPERCLIP_HOME = home;
  delete process.env.PAPERCLIP_INSTANCE_ID;
}

beforeEach(() => {
  delete process.env.PAPERCLIP_STORAGE_PROVIDER;
  delete process.env.PAPERCLIP_STORAGE_LOCAL_DIR;
  delete process.env.PAPERCLIP_DB_BACKUP_DIR;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("diskSpaceCheck", () => {
  it("passes on a healthy volume", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const healthy = volume(1, 100n * GIB, 61n * GIB);
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime")),
      paths.configPath,
      fakeFs({
        "/": healthy,
        [paths.data]: healthy,
        [paths.storage]: healthy,
        [paths.logs]: healthy,
        [paths.backups]: healthy,
        [paths.instance]: healthy,
      }),
    );
    expect(result.status).toBe("pass");
    expect(result.name).toBe("Disk space");
    expect(result.message).toBe(
      "61.0 GiB free (61%) on / for data, storage, logs, backups, instance",
    );
  });

  it("warns at the 10% free edge on a small volume", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const low = volume(1, 20n * GIB, 2n * GIB - BSIZE);
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime")),
      paths.configPath,
      fakeFs({
        [paths.data]: low,
        [paths.storage]: low,
        [paths.logs]: low,
        [paths.backups]: low,
        [paths.instance]: low,
      }),
    );
    expect(result.status).toBe("warn");
    expect(result.message).toMatch(/10% of volume size/);
    expect(result.message).not.toMatch(/embedded Postgres may stop accepting writes/);
    expect(result.repairHint).toContain("paperclipai configure --section database");
  });

  it("warns at the 5 GiB free edge on a large volume", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const low = volume(1, 100n * GIB, 5n * GIB - BSIZE);
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime")),
      paths.configPath,
      fakeFs({
        [paths.data]: low,
        [paths.storage]: low,
        [paths.logs]: low,
        [paths.backups]: low,
        [paths.instance]: low,
      }),
    );
    expect(result.status).toBe("warn");
    expect(result.message).toMatch(/5 GiB/);
    expect(result.message).not.toMatch(/embedded Postgres may stop accepting writes/);
  });

  it("uses stronger wording below 512 MiB free", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const low = volume(1, 100n * GIB, 256n * MIB);
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime")),
      paths.configPath,
      fakeFs({
        [paths.data]: low,
        [paths.storage]: low,
        [paths.logs]: low,
        [paths.backups]: low,
        [paths.instance]: low,
      }),
    );
    expect(result.status).toBe("warn");
    expect(result.message).toMatch(/embedded Postgres may stop accepting writes/);
    expect(result.message).toMatch(/5 GiB/);
  });

  it("reports several paths on one volume once", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const healthy = volume(7, 80n * GIB, 40n * GIB);
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime")),
      paths.configPath,
      fakeFs({
        [paths.data]: healthy,
        [paths.storage]: healthy,
        [paths.logs]: healthy,
        [paths.backups]: healthy,
        [paths.instance]: healthy,
      }),
    );
    expect(result.status).toBe("pass");
    expect(result.message.split("; ")).toHaveLength(1);
    expect(result.message).toMatch(/data, storage, logs, backups, instance/);
  });

  it("reports paths on two volumes separately", async () => {
    const rootA = "/vol-a";
    const rootB = "/vol-b";
    const home = path.join(rootA, "home");
    useHome(home);
    const instance = path.join(home, "instances", "default");
    const data = path.join(rootA, "db");
    const storage = path.join(rootA, "storage");
    const logs = path.join(rootA, "logs");
    const backups = path.join(rootB, "backups");
    const volA = volume(10, 80n * GIB, 40n * GIB);
    const volB = volume(20, 40n * GIB, 20n * GIB);
    const result = await diskSpaceCheck(
      makeConfig(rootA, { dataDir: data, storageDir: storage, logDir: logs, backupDir: backups }),
      path.join(rootA, "config.json"),
      fakeFs({
        [rootA]: volA,
        [data]: volA,
        [storage]: volA,
        [logs]: volA,
        [instance]: volA,
        [rootB]: volB,
        [backups]: volB,
      }),
    );
    expect(result.status).toBe("pass");
    const clauses = result.message.split("; ");
    expect(clauses).toHaveLength(2);
    expect(result.message).toMatch(/on \/vol-a for data, storage, logs, instance/);
    expect(result.message).toMatch(/on \/vol-b for backups/);
  });

  it("measures a missing path through its nearest existing ancestor", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const missing = path.join(paths.data, "nested", "missing");
    const healthy = volume(1, 50n * GIB, 25n * GIB);
    const deps = fakeFs({
      [paths.data]: healthy,
      [paths.storage]: healthy,
      [paths.logs]: healthy,
      [paths.backups]: healthy,
      [paths.instance]: healthy,
    });
    const statfsCalls: string[] = [];
    const wrapped: DiskSpaceCheckDeps = {
      stat: deps.stat,
      statfs: async (target, opts) => {
        statfsCalls.push(path.resolve(target));
        return deps.statfs!(target, opts);
      },
    };
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime"), { dataDir: missing }),
      paths.configPath,
      wrapped,
    );
    expect(result.status).toBe("pass");
    expect(statfsCalls).toContain(path.resolve(paths.data));
    expect(statfsCalls).not.toContain(path.resolve(missing));
  });

  it("resolves a relative embedded Postgres data dir from the working directory like the server", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const configPath = path.join("/config", "config.json");
    const serverDataDir = path.resolve("db");
    const healthy = volume(1, 50n * GIB, 25n * GIB);
    const deps = fakeFs({
      [serverDataDir]: volume(2, 50n * GIB, 25n * GIB),
      [path.join("/config", "db")]: healthy,
      [paths.storage]: healthy,
      [paths.logs]: healthy,
      [paths.backups]: healthy,
      [paths.instance]: healthy,
    });
    const statfsCalls: string[] = [];
    const wrapped: DiskSpaceCheckDeps = {
      stat: deps.stat,
      statfs: async (target, opts) => {
        statfsCalls.push(path.resolve(target));
        return deps.statfs!(target, opts);
      },
    };
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime"), { dataDir: "db" }),
      configPath,
      wrapped,
    );
    expect(result.status).toBe("pass");
    expect(statfsCalls).toContain(serverDataDir);
    expect(statfsCalls).not.toContain(path.join("/config", "db"));
  });

  it("skips the embedded Postgres data dir for external Postgres", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const skipped = path.join("/vol", "should-skip-data");
    const healthy = volume(1, 50n * GIB, 25n * GIB);
    const deps = fakeFs({
      [skipped]: healthy,
      [paths.storage]: healthy,
      [paths.logs]: healthy,
      [paths.backups]: healthy,
      [paths.instance]: healthy,
    });
    const statCalls: string[] = [];
    const wrapped: DiskSpaceCheckDeps = {
      stat: async (target) => {
        statCalls.push(path.resolve(target));
        return deps.stat!(target);
      },
      statfs: deps.statfs,
    };
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime"), { mode: "postgres", dataDir: skipped }),
      paths.configPath,
      wrapped,
    );
    expect(result.status).toBe("pass");
    expect(statCalls).not.toContain(path.resolve(skipped));
    expect(result.message).not.toMatch(/for data/);
    expect(result.message).not.toMatch(/\(data/);
    expect(result.message).toMatch(/storage, logs, backups, instance/);
  });

  it("warns when statfs fails instead of throwing", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime")),
      paths.configPath,
      {
        stat: async () => ({ dev: 1 }),
        statfs: async () => {
          throw new Error("EACCES: permission denied, statfs '/vol'");
        },
      },
    );
    expect(result.status).toBe("warn");
    expect(result.message).toMatch(/EACCES: permission denied/);
    expect(result.message).not.toMatch(/^$/);
  });

  it("measures PAPERCLIP_DB_BACKUP_DIR instead of the config backup dir", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const envBackups = "/env-backups";
    process.env.PAPERCLIP_DB_BACKUP_DIR = envBackups;
    const healthy = volume(1, 50n * GIB, 25n * GIB);
    const envVol = volume(3, 40n * GIB, 20n * GIB);
    const skipped = path.join("/vol", "runtime", "backups");
    const deps = fakeFs({
      [paths.data]: healthy,
      [paths.storage]: healthy,
      [paths.logs]: healthy,
      [paths.instance]: healthy,
      [envBackups]: envVol,
    });
    const statCalls: string[] = [];
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime"), { backupDir: skipped }),
      paths.configPath,
      {
        stat: async (target) => {
          statCalls.push(path.resolve(target));
          return deps.stat!(target);
        },
        statfs: deps.statfs,
      },
    );
    expect(result.status).toBe("pass");
    expect(result.message).toMatch(/on \/env-backups for backups/);
    expect(statCalls).toContain(path.resolve(envBackups));
    expect(statCalls).not.toContain(path.resolve(skipped));
    expect(result.message).not.toMatch(/Could not measure backups/);
  });

  it("measures PAPERCLIP_STORAGE_LOCAL_DIR instead of the config storage dir", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const envStorage = "/env-storage";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = envStorage;
    const healthy = volume(1, 50n * GIB, 25n * GIB);
    const envVol = volume(4, 30n * GIB, 15n * GIB);
    const skipped = path.join("/vol", "runtime", "storage");
    const deps = fakeFs({
      [paths.data]: healthy,
      [paths.logs]: healthy,
      [paths.backups]: healthy,
      [paths.instance]: healthy,
      [envStorage]: envVol,
    });
    const statCalls: string[] = [];
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime"), { storageDir: skipped }),
      paths.configPath,
      {
        stat: async (target) => {
          statCalls.push(path.resolve(target));
          return deps.stat!(target);
        },
        statfs: deps.statfs,
      },
    );
    expect(result.status).toBe("pass");
    expect(result.message).toMatch(/on \/env-storage for storage/);
    expect(statCalls).toContain(path.resolve(envStorage));
    expect(statCalls).not.toContain(path.resolve(skipped));
    expect(result.message).not.toMatch(/Could not measure storage/);
  });

  it("skips local storage when PAPERCLIP_STORAGE_PROVIDER is s3", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    process.env.PAPERCLIP_STORAGE_PROVIDER = "s3";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = "/should-skip-storage";
    const skipped = "/should-skip-storage";
    const healthy = volume(1, 50n * GIB, 25n * GIB);
    const deps = fakeFs({
      [paths.data]: healthy,
      [paths.logs]: healthy,
      [paths.backups]: healthy,
      [paths.instance]: healthy,
    });
    const statCalls: string[] = [];
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime"), { storageDir: skipped }),
      paths.configPath,
      {
        stat: async (target) => {
          statCalls.push(path.resolve(target));
          return deps.stat!(target);
        },
        statfs: deps.statfs,
      },
    );
    expect(result.status).toBe("pass");
    expect(statCalls).not.toContain(path.resolve(skipped));
    expect(result.message).not.toMatch(/for storage/);
    expect(result.message).not.toMatch(/\(storage/);
    expect(result.message).toMatch(/data, logs, backups, instance/);
  });

  it("measures local storage when PAPERCLIP_STORAGE_PROVIDER overrides s3 config", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const envStorage = "/env-local-storage";
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = envStorage;
    const healthy = volume(1, 50n * GIB, 25n * GIB);
    const envVol = volume(5, 24n * GIB, 12n * GIB);
    const deps = fakeFs({
      [paths.data]: healthy,
      [paths.logs]: healthy,
      [paths.backups]: healthy,
      [paths.instance]: healthy,
      [envStorage]: envVol,
    });
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime"), { storageProvider: "s3", storageDir: "/config-storage" }),
      paths.configPath,
      deps,
    );
    expect(result.status).toBe("pass");
    expect(result.message).toMatch(/on \/env-local-storage for storage/);
    expect(result.message).not.toMatch(/Could not measure storage/);
  });

  it("ignores an invalid PAPERCLIP_STORAGE_PROVIDER and keeps the config provider", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    process.env.PAPERCLIP_STORAGE_PROVIDER = "typo";
    const healthy = volume(1, 50n * GIB, 25n * GIB);
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime")),
      paths.configPath,
      fakeFs({
        [paths.data]: healthy,
        [paths.storage]: healthy,
        [paths.logs]: healthy,
        [paths.backups]: healthy,
        [paths.instance]: healthy,
      }),
    );
    expect(result.status).toBe("pass");
    expect(result.message).toMatch(/storage/);
  });

  it("warns when statfs is not a function", async () => {
    const paths = layout("/vol");
    useHome(paths.home);
    const result = await diskSpaceCheck(
      makeConfig(path.join("/vol", "runtime")),
      paths.configPath,
      {
        statfs: 1 as unknown as DiskSpaceCheckDeps["statfs"],
        stat: async () => ({ dev: 1 }),
      },
    );
    expect(result.status).toBe("warn");
    expect(result.message).toMatch(/statfs is not available/);
  });
});
