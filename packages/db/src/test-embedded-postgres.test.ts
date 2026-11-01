import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { inspectMigrations } from "./client.js";
import {
  __embeddedPostgresStartMaxAttemptsForTests as MAX_ATTEMPTS,
  __embeddedPostgresTemplateRootDirForTests as templateRootDir,
  __isUsableEmbeddedPostgresTemplateForTests as isUsableTemplate,
  __lastEmbeddedPostgresStartModeForTests as lastStartMode,
  __resetEmbeddedPostgresTemplateStateForTests as resetTemplateState,
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

const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

describe("isUsableTemplate", () => {
  let root: string;

  function writeCluster(dir: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "PG_VERSION"), "18\n");
  }

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("accepts a private directory that holds a cleanly stopped cluster", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-template-usable-"));
    const template = path.join(root, "template");
    writeCluster(template);
    expect(isUsableTemplate(template)).toBe(true);

    // A running or crashed cluster leaves `postmaster.pid` behind.
    fs.writeFileSync(path.join(template, "postmaster.pid"), "1\n");
    expect(isUsableTemplate(template)).toBe(false);
    fs.rmSync(path.join(template, "postmaster.pid"));
    expect(isUsableTemplate(template)).toBe(true);

    // A directory without a cluster, or no directory at all.
    fs.rmSync(path.join(template, "PG_VERSION"));
    expect(isUsableTemplate(template)).toBe(false);
    expect(isUsableTemplate(path.join(root, "missing"))).toBe(false);
  });

  it("rejects a symbolic link even when it points at a usable cluster", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-template-usable-"));
    const template = path.join(root, "template");
    writeCluster(template);
    const link = path.join(root, "link");
    fs.symlinkSync(template, link, "dir");
    expect(isUsableTemplate(template)).toBe(true);
    expect(isUsableTemplate(link)).toBe(false);
  });

  describeOnPosix("on POSIX", () => {
    it("rejects a cluster directory that group or others can write", () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-template-usable-"));
      const template = path.join(root, "template");
      writeCluster(template);
      for (const mode of [0o720, 0o702, 0o777]) {
        fs.chmodSync(template, mode);
        expect(isUsableTemplate(template), `mode ${mode.toString(8)}`).toBe(false);
      }
      // Read bits for others are not a write path; Postgres narrows the copy
      // to 0700 before it starts anyway.
      fs.chmodSync(template, 0o755);
      expect(isUsableTemplate(template)).toBe(true);
      fs.chmodSync(template, 0o700);
      expect(isUsableTemplate(template)).toBe(true);
    });
  });
});

// Real-cluster coverage of the template path. Skipped on hosts that cannot run
// embedded Postgres, like every other suite that uses the fixture.
const support = await getEmbeddedPostgresTestSupport();
const describeWithPostgres = support.supported ? describe : describe.skip;

// Points `os.tmpdir()` at a private scratch directory so a test can drive the
// cache root from an empty state. `os.tmpdir()` reads the environment on every
// call: TMPDIR on POSIX, TEMP and then TMP on Windows, so all three are set.
// Returns the scratch directory; `restore` puts the environment and the
// fixture's cached state back.
const TMPDIR_VARIABLES = ["TMPDIR", "TEMP", "TMP"] as const;

function useScratchTmpdir(prefix: string): { scratch: string; restore(): void } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const previous = new Map(TMPDIR_VARIABLES.map((name) => [name, process.env[name]] as const));
  for (const name of TMPDIR_VARIABLES) process.env[name] = scratch;
  return {
    scratch,
    restore() {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      resetTemplateState();
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}

describeWithPostgres("startEmbeddedPostgresTestDatabase template path", () => {
  const originalTemplateSetting = process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;

  afterEach(() => {
    if (originalTemplateSetting === undefined) delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
    else process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = originalTemplateSetting;
  });

  it("publishes a complete template and starts suites from a copy of it", { timeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS }, async () => {
    // This test covers the template path, so it enables the cache even when
    // the suite runs under PAPERCLIP_TEST_POSTGRES_TEMPLATE=0. The first
    // start then builds the template if the support probe did not.
    delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;

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

    const rootDir = templateRootDir();
    const templateDir = path.join(rootDir, computeEmbeddedPostgresTemplateKey());
    expect(fs.existsSync(path.join(templateDir, "PG_VERSION"))).toBe(true);
    expect(fs.existsSync(path.join(templateDir, "postmaster.pid"))).toBe(false);
    expect(isUsableTemplate(templateDir)).toBe(true);
    if (process.platform !== "win32") {
      // The root is private to this user, and the template is a data
      // directory Postgres accepts: both are 0700.
      expect(path.basename(rootDir)).toBe(`paperclip-embedded-postgres-templates-${process.getuid?.()}`);
      expect(fs.statSync(rootDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(templateDir).mode & 0o777).toBe(0o700);
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

  it("refreshes the template's timestamp on every reuse so idle time drives pruning", { timeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS }, async () => {
    delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
    // Make sure a template exists before ageing it: the support probe does
    // not publish one under PAPERCLIP_TEST_POSTGRES_TEMPLATE=0, and a name
    // filter can run this test on its own.
    resetTemplateState();
    const first = await startEmbeddedPostgresTestDatabase("paperclip-template-touch-");
    await first.cleanup();
    expect(lastStartMode()).toBe("template");
    const templateDir = path.join(templateRootDir(), computeEmbeddedPostgresTemplateKey());
    expect(isUsableTemplate(templateDir)).toBe(true);
    // Age the template as if it had not been used for ten days.
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(templateDir, old, old);
    expect(fs.statSync(templateDir).mtimeMs).toBeLessThan(Date.now() - 9 * 24 * 60 * 60 * 1000);

    resetTemplateState();
    const database = await startEmbeddedPostgresTestDatabase("paperclip-template-touch-");
    try {
      expect(lastStartMode()).toBe("template");
    } finally {
      await database.cleanup();
    }
    expect(fs.statSync(templateDir).mtimeMs).toBeGreaterThan(Date.now() - 60 * 1000);
  });

  it("rebuilds the template when it was pruned after this process resolved it", { timeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS }, async () => {
    delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
    const scratch = useScratchTmpdir("paperclip-template-pruned-");
    try {
      resetTemplateState();
      const first = await startEmbeddedPostgresTestDatabase("paperclip-template-pruned-copy-");
      await first.cleanup();
      expect(lastStartMode()).toBe("template");
      const templateDir = path.join(templateRootDir(), computeEmbeddedPostgresTemplateKey());
      expect(isUsableTemplate(templateDir)).toBe(true);

      // Another process prunes the template while this one still holds its path.
      fs.rmSync(templateDir, { recursive: true, force: true });
      const second = await startEmbeddedPostgresTestDatabase("paperclip-template-pruned-copy-");
      await second.cleanup();
      // This start fell back without retrying the missing path; the fallback
      // forgot the stale path, so the next start rebuilt the template.
      expect(lastStartMode()).toBe("fresh");
      const third = await startEmbeddedPostgresTestDatabase("paperclip-template-pruned-copy-");
      await third.cleanup();
      expect(lastStartMode()).toBe("template");
      expect(isUsableTemplate(templateDir)).toBe(true);
    } finally {
      scratch.restore();
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

  describeOnPosix("cache root safety", () => {
    it("uses fresh clusters when the cache root is not a private directory of this user", { timeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS }, async () => {
      delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
      const scratch = useScratchTmpdir("paperclip-template-root-");
      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      try {
        // Someone pre-created the predictable root path, world-writable, the
        // way a foreign user on a shared host would.
        const rootDir = templateRootDir();
        expect(rootDir.startsWith(scratch.scratch)).toBe(true);
        fs.mkdirSync(rootDir);
        fs.chmodSync(rootDir, 0o777);

        resetTemplateState();
        const database = await startEmbeddedPostgresTestDatabase("paperclip-template-root-copy-");
        try {
          expect(lastStartMode()).toBe("fresh");
        } finally {
          await database.cleanup();
        }
        // Nothing was published into the rejected root, and the reason was logged once.
        expect(fs.readdirSync(rootDir)).toEqual([]);
        expect(warnings.filter((line) => line.includes("template cache root"))).toHaveLength(1);
        expect(warnings[0]).toContain("writable by group or others");

        // The probe still reports support, from the throwaway cluster.
        resetTemplateState();
        expect(await getEmbeddedPostgresTestSupport()).toEqual({ supported: true });
      } finally {
        console.warn = warn;
        scratch.restore();
      }
    });

    it("uses fresh clusters when the cache root path is a symbolic link", { timeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS }, async () => {
      delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
      const scratch = useScratchTmpdir("paperclip-template-root-");
      const warn = console.warn;
      console.warn = () => {};
      try {
        const target = path.join(scratch.scratch, "elsewhere");
        fs.mkdirSync(target, { mode: 0o700 });
        fs.symlinkSync(target, templateRootDir(), "dir");

        resetTemplateState();
        const database = await startEmbeddedPostgresTestDatabase("paperclip-template-root-copy-");
        try {
          expect(lastStartMode()).toBe("fresh");
        } finally {
          await database.cleanup();
        }
        expect(fs.readdirSync(target)).toEqual([]);
      } finally {
        console.warn = warn;
        scratch.restore();
      }
    });
  });
});

describe("support probe when the template cannot be built", () => {
  afterEach(() => {
    __setEmbeddedPostgresCtorProviderForTests(null);
    resetTemplateState();
  });

  it("falls through to the fresh probe instead of reporting the host as unsupported", { timeout: EMBEDDED_POSTGRES_TEST_TIMEOUT_MS }, async () => {
    const originalTemplateSetting = process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
    delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
    const scratch = useScratchTmpdir("paperclip-template-build-fail-");
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      // This test runs on every platform, so check the redirect took effect
      // before asserting on paths under it.
      expect(os.tmpdir()).toBe(scratch.scratch);
      // The fake cluster "starts" without listening, so the template build
      // fails after the start, at the migration step, the way a broken
      // migration would. A real broken migration then fails the suite on
      // the fresh path instead of being hidden by `describe.skip`.
      const { ctor, constructed } = makeFakeCtor(0);
      __setEmbeddedPostgresCtorProviderForTests(async () => ctor);
      resetTemplateState();

      expect(await getEmbeddedPostgresTestSupport()).toEqual({ supported: true });
      // One build attempt, then the throwaway probe, both under the scratch root.
      expect(constructed).toHaveLength(2);
      for (const options of constructed) expect(options.databaseDir.startsWith(scratch.scratch)).toBe(true);
      expect(constructed[0]?.databaseDir).toContain("paperclip-embedded-postgres-template-build-");
      expect(constructed[1]?.databaseDir).toContain("paperclip-embedded-postgres-probe-");
      expect(warnings.filter((line) => line.includes("template build failed"))).toHaveLength(1);
      // Nothing was published.
      const rootDir = templateRootDir();
      expect(fs.existsSync(rootDir) ? fs.readdirSync(rootDir) : []).toEqual([]);
    } finally {
      console.warn = warn;
      scratch.restore();
      if (originalTemplateSetting === undefined) delete process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
      else process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE = originalTemplateSetting;
    }
  });
});
