import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { prepareEmbeddedPostgresDataDir } from "../embedded-postgres-dir.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-embedded-pg-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("prepareEmbeddedPostgresDataDir", () => {
  it("removes an empty leftover directory so initdb can succeed", () => {
    const parent = makeTempDir();
    const dataDir = join(parent, "db");
    mkdirSync(dataDir);

    const result = prepareEmbeddedPostgresDataDir(dataDir);

    expect(result.clusterAlreadyInitialized).toBe(false);
    expect(result.removedEmptyDataDir).toBe(true);
  });

  it("treats directories with PG_VERSION as initialized clusters", () => {
    const parent = makeTempDir();
    const dataDir = join(parent, "db");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "PG_VERSION"), "17\n");

    const result = prepareEmbeddedPostgresDataDir(dataDir);

    expect(result.clusterAlreadyInitialized).toBe(true);
    expect(result.removedEmptyDataDir).toBe(false);
  });

  it("throws a clear error for non-empty directories without cluster metadata", () => {
    const parent = makeTempDir();
    const dataDir = join(parent, "db");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "some-file"), "oops\n");

    expect(() => prepareEmbeddedPostgresDataDir(dataDir)).toThrow(
      /exists but is not an initialized cluster/,
    );
  });
});
