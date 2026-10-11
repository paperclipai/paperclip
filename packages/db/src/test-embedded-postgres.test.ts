import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { inspectMigrations } from "./client.js";
import {
  __embeddedPostgresStartMaxAttemptsForTests as MAX_ATTEMPTS,
  __embeddedPostgresTemplateRootDirForTests as templateRootDir,
  __lastEmbeddedPostgresStartModeForTests as lastStartMode,
  __setEmbeddedPostgresCtorProviderForTests,
  __startEmbeddedPostgresWithRetryForTests as startWithRetry,
  computeEmbeddedPostgresTemplateKey,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// A fake embedded-postgres constructor. It records every constructed instance so
// the test can assert the retry uses a fresh port and a fresh data directory each
// attempt. `start()` emits the same output the real cluster writes for a port
// conflict, then rejects with an empty message (the real rejection shape). The
// option type matches the real constructor so no type cast is needed.
type FakeOptions = {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
};

const BIND_CONFLICT_LOG = 'could not bind IPv4 address "127.0.0.1": Address already in use';

function makeFakeCtor(failFirst: number) {
  const constructed: FakeOptions[] = [];
  let started = 0;

  class FakeEmbeddedPostgres {
    private readonly options: FakeOptions;
    constructor(options: FakeOptions) {
      this.options = options;
      constructed.push(options);
    }
    async initialise(): Promise<void> {}
    async start(): Promise<void> {
      started += 1;
      if (started <= failFirst) {
        // Mirror the real failure: Postgres logs the reason, then `start()`
        // rejects with an Error whose message is empty.
        this.options.onLog?.(BIND_CONFLICT_LOG);
        throw new Error();
      }
    }
    async stop(): Promise<void> {}
  }

  return { ctor: FakeEmbeddedPostgres, constructed };
}

describe("startEmbeddedPostgresWithRetry", () => {
  afterEach(() => {
    __setEmbeddedPostgresCtorProviderForTests(null);
  });

  it("recovers from a transient port conflict and returns on a later attempt", async () => {
    const { ctor, constructed } = makeFakeCtor(2);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);

    const started = await startWithRetry("paperclip-retry-recover-");

    // The first two attempts fail, the third succeeds.
    expect(constructed).toHaveLength(3);

    // Each attempt uses a fresh data directory. The two failed directories are
    // removed. The returned directory still exists.
    const dataDirs = constructed.map((options) => options.databaseDir);
    expect(new Set(dataDirs).size).toBe(3);
    expect(fs.existsSync(dataDirs[0])).toBe(false);
    expect(fs.existsSync(dataDirs[1])).toBe(false);
    expect(started.dataDir).toBe(dataDirs[2]);
    expect(fs.existsSync(started.dataDir)).toBe(true);

    // Each attempt allocates a port.
    for (const options of constructed) {
      expect(Number.isInteger(options.port)).toBe(true);
      expect(options.port).toBeGreaterThan(0);
    }

    // Clean up the returned attempt.
    await started.instance.stop();
    fs.rmSync(started.dataDir, { recursive: true, force: true });
  });

  it("throws with the real Postgres output after the attempt bound", async () => {
    const { ctor, constructed } = makeFakeCtor(Number.POSITIVE_INFINITY);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);

    await expect(startWithRetry("paperclip-retry-fail-")).rejects.toThrow(/after \d+ attempts/);

    // The retry stops at the bound and does not loop forever.
    expect(constructed).toHaveLength(MAX_ATTEMPTS);

    // Every failed attempt removes its data directory.
    for (const options of constructed) {
      expect(fs.existsSync(options.databaseDir)).toBe(false);
    }
  });

  it("keeps the real failure reason instead of a generic fallback", async () => {
    const { ctor } = makeFakeCtor(Number.POSITIVE_INFINITY);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);

    const error = await startWithRetry("paperclip-retry-reason-").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    // The thrown message carries the captured Postgres output, not only the
    // generic "embedded Postgres startup failed" text.
    expect((error as Error).message).toContain("Address already in use");
  });
});

describe("computeEmbeddedPostgresTemplateKey", () => {
  function writeMigrations(dir: string, files: Record<string, string>) {
    fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
    fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ entries: Object.keys(files) }));
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
  }

  it("is stable for identical inputs and changes with any migration, flag, or version", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-template-key-"));
    try {
      const a = path.join(root, "a");
      const b = path.join(root, "b");
      writeMigrations(a, { "0000_one.sql": "create table one();", "0001_two.sql": "create table two();" });
      writeMigrations(b, { "0000_one.sql": "create table one();", "0001_two.sql": "create table two();" });
      const fixed = { packageVersion: "18.1.0", initdbFlags: ["--locale=C"], user: "paperclip" };

      const keyA = computeEmbeddedPostgresTemplateKey(a, fixed);
      expect(keyA).toMatch(/^[0-9a-f]{24}$/);
      expect(computeEmbeddedPostgresTemplateKey(a, fixed)).toBe(keyA);
      expect(computeEmbeddedPostgresTemplateKey(b, fixed)).toBe(keyA);

      // Content change, new file, flags, version, and user each change the key.
      fs.writeFileSync(path.join(b, "0001_two.sql"), "create table two(id int);");
      const contentChanged = computeEmbeddedPostgresTemplateKey(b, fixed);
      expect(contentChanged).not.toBe(keyA);
      fs.writeFileSync(path.join(b, "0002_three.sql"), "create table three();");
      expect(computeEmbeddedPostgresTemplateKey(b, fixed)).not.toBe(contentChanged);
      expect(computeEmbeddedPostgresTemplateKey(a, { ...fixed, initdbFlags: ["--locale=C", "--encoding=UTF8"] })).not.toBe(keyA);
      expect(computeEmbeddedPostgresTemplateKey(a, { ...fixed, packageVersion: "18.2.0" })).not.toBe(keyA);
      expect(computeEmbeddedPostgresTemplateKey(a, { ...fixed, user: "other" })).not.toBe(keyA);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("hashes the real migrations directory of this package", () => {
    const key = computeEmbeddedPostgresTemplateKey();
    expect(key).toMatch(/^[0-9a-f]{24}$/);
    expect(computeEmbeddedPostgresTemplateKey()).toBe(key);
  });
});

// Real-cluster coverage of the template path. Skipped on hosts that cannot run
// embedded Postgres, like every other suite that uses the fixture.
const support = await getEmbeddedPostgresTestSupport();
const describeWithPostgres = support.supported ? describe : describe.skip;

describeWithPostgres("startEmbeddedPostgresTestDatabase template path", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
  });

  it("publishes a complete template and starts suites from a copy of it", { timeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS }, async () => {
    // The support probe above already built or found the template.
    const templateDir = path.join(templateRootDir(), computeEmbeddedPostgresTemplateKey());
    expect(fs.existsSync(path.join(templateDir, "PG_VERSION"))).toBe(true);
    expect(fs.existsSync(path.join(templateDir, "postmaster.pid"))).toBe(false);
    // Postgres requires the data directory to be private to its owner.
    expect(fs.statSync(templateDir).mode & 0o777).toBe(0o700);

    const database = await startEmbeddedPostgresTestDatabase("paperclip-template-copy-");
    try {
      expect(lastStartMode()).toBe("template");
      // The copy is fully migrated and independent of the template.
      const state = await inspectMigrations(database.connectionString);
      expect(state.status).toBe("upToDate");
      const sql = postgres(database.connectionString, { max: 1 });
      try {
        await sql`create table paperclip_template_copy_probe (id int)`;
      } finally {
        await sql.end();
      }
    } finally {
      await database.cleanup();
    }
    // Writing to the copy never touches the template, so a second copy does
    // not see the table.
    const second = await startEmbeddedPostgresTestDatabase("paperclip-template-copy-");
    try {
      expect(lastStartMode()).toBe("template");
      const sql = postgres(second.connectionString, { max: 1 });
      try {
        const rows = await sql`select to_regclass('paperclip_template_copy_probe') as name`;
        expect(rows[0]?.name).toBeNull();
      } finally {
        await sql.end();
      }
    } finally {
      await second.cleanup();
    }
  });

  it("runs the fresh initdb path when PAPERCLIP_TEST_POSTGRES_TEMPLATE=0", { timeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS }, async () => {
    process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = "0";
    const database = await startEmbeddedPostgresTestDatabase("paperclip-template-bypass-");
    try {
      expect(lastStartMode()).toBe("fresh");
      const state = await inspectMigrations(database.connectionString);
      expect(state.status).toBe("upToDate");
    } finally {
      await database.cleanup();
    }
  });
});
