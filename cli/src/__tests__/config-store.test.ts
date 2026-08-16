import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backupInvalidConfig,
  readConfig,
  writeConfig,
} from "../config/store.js";
import { paperclipConfigSchema, type PaperclipConfig } from "../config/schema.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createConfigPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-config-store-"));
  roots.push(root);
  return path.join(root, "config.json");
}

function defaultConfig(): PaperclipConfig {
  return paperclipConfigSchema.parse({
    $meta: {
      version: 1,
      updatedAt: "2026-08-06T00:00:00.000Z",
      source: "configure",
    },
    database: { mode: "embedded-postgres" },
    logging: { mode: "file" },
    server: {},
  });
}

describe("config store", () => {
  it("preserves top-level and nested extension keys during a known-field update", () => {
    const configPath = createConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({
      ...defaultConfig(),
      topLevelExtension: { enabled: true },
      server: {
        ...defaultConfig().server,
        serverExtension: "keep",
      },
      storage: {
        ...defaultConfig().storage,
        localDisk: {
          ...defaultConfig().storage.localDisk,
          driverExtension: "keep",
        },
      },
    }, null, 2));

    const source = readConfig(configPath)!;
    const { topLevelExtension: _topLevelExtension, ...knownConfig } = source;
    const { serverExtension: _serverExtension, ...knownServer } = source.server;
    const { driverExtension: _driverExtension, ...knownLocalDisk } = source.storage.localDisk;
    const update: PaperclipConfig = {
      ...knownConfig,
      server: {
        ...knownServer,
        port: 3200,
      },
      storage: {
        ...source.storage,
        localDisk: knownLocalDisk,
      },
    };

    expect(writeConfig(update, configPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
      topLevelExtension: { enabled: true },
      server: {
        port: 3200,
        serverExtension: "keep",
      },
      storage: {
        localDisk: {
          driverExtension: "keep",
        },
      },
    });
  });

  it("skips semantic no-op writes and keeps the config mtime stable", () => {
    const configPath = createConfigPath();
    const source = defaultConfig();
    fs.writeFileSync(configPath, `${JSON.stringify(source, null, 2)}\n`);
    const stableTime = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(configPath, stableTime, stableTime);

    const update = {
      ...source,
      $meta: {
        ...source.$meta,
        source: "doctor" as const,
        updatedAt: "2026-08-06T01:00:00.000Z",
      },
    };

    expect(writeConfig(update, configPath)).toBe(false);
    expect(fs.statSync(configPath).mtimeMs).toBe(stableTime.getTime());
    expect(fs.existsSync(`${configPath}.backup`)).toBe(false);
  });

  it("backs up invalid bytes collision-safely and only replaces them through an atomic repair", () => {
    const configPath = createConfigPath();
    const invalidBytes = Buffer.from('{"server": invalid}\n', "utf8");
    fs.writeFileSync(configPath, invalidBytes);
    fs.writeFileSync(`${configPath}.invalid-1`, "existing backup");

    const open = vi.spyOn(fs, "openSync");
    const sync = vi.spyOn(fs, "fsyncSync");
    const backupPath = backupInvalidConfig(configPath);
    expect(backupPath).toBe(`${configPath}.invalid-2`);
    expect(fs.readFileSync(backupPath)).toEqual(invalidBytes);
    expect(open).toHaveBeenCalledWith(backupPath, "r");
    expect(open).toHaveBeenCalledWith(path.dirname(configPath), "r");
    expect(sync).toHaveBeenCalled();
    expect(() => writeConfig(defaultConfig(), configPath)).toThrow(/Refusing to overwrite invalid config/);
    expect(fs.readFileSync(configPath)).toEqual(invalidBytes);

    open.mockClear();
    sync.mockClear();
    const rename = vi.spyOn(fs, "renameSync");
    expect(writeConfig(defaultConfig(), configPath, { invalidBackupPath: backupPath })).toBe(true);
    expect(rename).toHaveBeenCalledWith(expect.stringMatching(/config\.json\.tmp-\d+-\d+$/), configPath);
    expect(open).toHaveBeenCalledWith(path.dirname(configPath), "r");
    expect(open.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(rename.mock.invocationCallOrder.at(-1)!);
    expect(sync.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(open.mock.invocationCallOrder.at(-1)!);
    expect(readConfig(configPath)).not.toBeNull();
    expect(fs.readdirSync(path.dirname(configPath)).some((entry) => entry.includes(".tmp-"))).toBe(false);
  });
});
