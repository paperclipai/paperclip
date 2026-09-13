import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseBackupAlertBoard } from "../services/database-backup-alerts.js";
import {
  PGCLIENT_VERSION_ALERT_FINGERPRINT,
  buildPgClientVersionAlertContent,
  comparePgMajor,
  createPgClientVersionPreflightReporter,
  defaultPgClientVersionPreflightIo,
  inspectPgClientVersion,
  parsePgDumpVersionOutput,
  parsePgVersionFileContent,
  type PgClientVersionPreflightIo,
} from "../services/pgclient-version-preflight.js";

const AT = new Date("2026-09-10T12:00:00.000Z");

function enoent(): NodeJS.ErrnoException {
  const err = new Error("spawn pg_dump ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

/** Fake board mirroring the SIN-70819 concrete-adapter semantics (fingerprint
 * dedup, non-terminal-title create guard, resolve-to-done). */
function createFakeBoard() {
  type Rec = { id: string; status: string; fingerprint: string; title: string; comments: string[] };
  const records: Rec[] = [];
  let counter = 0;
  const board: DatabaseBackupAlertBoard = {
    async findOpenAlert(_companyId, fingerprint) {
      const open = records.find(
        (r) => r.fingerprint === fingerprint && r.status !== "done" && r.status !== "cancelled",
      );
      return open ? { id: open.id, identifier: null, status: open.status } : null;
    },
    async createAlert(_companyId, input) {
      const openSameTitle = records.find(
        (r) => r.title === input.title && r.status !== "done" && r.status !== "cancelled",
      );
      if (openSameTitle) return { id: openSameTitle.id, identifier: null, status: openSameTitle.status };
      counter += 1;
      const rec: Rec = {
        id: `issue-${counter}`,
        status: "todo",
        fingerprint: input.fingerprint,
        title: input.title,
        comments: [],
      };
      records.push(rec);
      return { id: rec.id, identifier: null, status: rec.status };
    },
    async commentAlert(issueId, body) {
      records.find((r) => r.id === issueId)?.comments.push(body);
    },
    async resolveAlert(issueId, body) {
      const rec = records.find((r) => r.id === issueId);
      if (rec) {
        rec.comments.push(body);
        rec.status = "done";
      }
    },
  };
  return { board, records };
}

function io(overrides: Partial<PgClientVersionPreflightIo>): PgClientVersionPreflightIo {
  return {
    async readServerVersion() {
      return "18\n";
    },
    async readClientVersion() {
      return "pg_dump (PostgreSQL) 18.1\n";
    },
    ...overrides,
  };
}

describe("defaultPgClientVersionPreflightIo", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });
  function mkTmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "pgclient-preflight-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("readServerVersion returns file contents, or null when absent", async () => {
    const dir = mkTmp();
    expect(await defaultPgClientVersionPreflightIo.readServerVersion(dir)).toBeNull();
    writeFileSync(join(dir, "PG_VERSION"), "18\n", "utf8");
    expect((await defaultPgClientVersionPreflightIo.readServerVersion(dir))?.trim()).toBe("18");
  });

  it("readClientVersion spawns the resolved binary and returns its output", async () => {
    const dir = mkTmp();
    const fake = join(dir, "fake-pg_dump");
    writeFileSync(fake, "#!/bin/sh\necho 'pg_dump (PostgreSQL) 18.1'\n", "utf8");
    chmodSync(fake, 0o755);
    const out = await defaultPgClientVersionPreflightIo.readClientVersion(fake);
    expect(out).toContain("pg_dump (PostgreSQL) 18.1");
  });

  it("readClientVersion rejects with ENOENT when the binary is missing", async () => {
    await expect(
      defaultPgClientVersionPreflightIo.readClientVersion("/no/such/pg_dump-xyz"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("inspectPgClientVersion end-to-end through the default IO (mismatch)", async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, "PG_VERSION"), "18\n", "utf8");
    const fake = join(dir, "fake-pg_dump");
    writeFileSync(fake, "#!/bin/sh\necho 'pg_dump (PostgreSQL) 16.4'\n", "utf8");
    chmodSync(fake, 0o755);
    const r = await inspectPgClientVersion({ dataDir: dir, pgDumpPath: fake });
    expect(r.outcome).toBe("mismatch");
  });
});

describe("parsePgDumpVersionOutput", () => {
  const cases: Array<[string, number | null]> = [
    ["pg_dump (PostgreSQL) 18.1", 18],
    ["pg_dump (PostgreSQL) 18.1\n", 18],
    ["pg_dump (PostgreSQL) 16.4 (Ubuntu 16.4-1.pgdg22.04+1)", 16],
    ["pg_dump (PostgreSQL) 9.6.24", 9],
    ["", null],
    ["not a version string", null],
  ];
  it.each(cases)("parses %j -> %j", (input, expected) => {
    expect(parsePgDumpVersionOutput(input)).toBe(expected);
  });
});

describe("parsePgVersionFileContent", () => {
  const cases: Array<[string, number | null]> = [
    ["18", 18],
    ["18\n", 18],
    ["  16 \n", 16],
    ["9.6", 9],
    ["", null],
    ["\n\n", null],
    ["garbage", null],
  ];
  it.each(cases)("parses %j -> %j", (input, expected) => {
    expect(parsePgVersionFileContent(input)).toBe(expected);
  });
});

describe("comparePgMajor", () => {
  it("18 vs 18 -> ok", () => {
    const d = comparePgMajor("pg_dump (PostgreSQL) 18.1", "18\n");
    expect(d).toEqual({ status: "ok", clientMajor: 18, serverMajor: 18 });
  });

  it("16 client vs 18 server -> mismatch, clientBehind (the silent-kill case)", () => {
    const d = comparePgMajor("pg_dump (PostgreSQL) 16.4", "18");
    expect(d.status).toBe("mismatch");
    if (d.status !== "mismatch") throw new Error("unreachable");
    expect(d.clientMajor).toBe(16);
    expect(d.serverMajor).toBe(18);
    expect(d.clientBehind).toBe(true);
    expect(d.message).toContain("OLDER");
  });

  it("19 client vs 18 server -> mismatch, not clientBehind", () => {
    const d = comparePgMajor("pg_dump (PostgreSQL) 19.0", "18");
    expect(d.status).toBe("mismatch");
    if (d.status !== "mismatch") throw new Error("unreachable");
    expect(d.clientBehind).toBe(false);
  });

  it("unparseable client -> unparseable", () => {
    const d = comparePgMajor("garbage", "18");
    expect(d.status).toBe("unparseable");
    if (d.status !== "unparseable") throw new Error("unreachable");
    expect(d.clientMajor).toBeNull();
    expect(d.serverMajor).toBe(18);
  });
});

describe("inspectPgClientVersion", () => {
  it("matching majors -> ok", async () => {
    const r = await inspectPgClientVersion({ dataDir: "/d", pgDumpPath: "pg_dump", io: io({}) });
    expect(r).toEqual({ outcome: "ok", clientMajor: 18, serverMajor: 18 });
  });

  it("client older than server -> mismatch", async () => {
    const r = await inspectPgClientVersion({
      dataDir: "/d",
      pgDumpPath: "pg_dump",
      io: io({ async readClientVersion() {
        return "pg_dump (PostgreSQL) 16.4";
      } }),
    });
    expect(r.outcome).toBe("mismatch");
    if (r.outcome !== "mismatch") throw new Error("unreachable");
    expect(r.clientMajor).toBe(16);
    expect(r.serverMajor).toBe(18);
  });

  it("pg_dump ENOENT -> client_missing", async () => {
    const r = await inspectPgClientVersion({
      dataDir: "/d",
      pgDumpPath: "/no/such/pg_dump",
      io: io({ async readClientVersion() {
        throw enoent();
      } }),
    });
    expect(r.outcome).toBe("client_missing");
    if (r.outcome !== "client_missing") throw new Error("unreachable");
    expect(r.pgDumpPath).toBe("/no/such/pg_dump");
  });

  it("non-ENOENT read failure -> unparseable", async () => {
    const r = await inspectPgClientVersion({
      dataDir: "/d",
      pgDumpPath: "pg_dump",
      io: io({ async readClientVersion() {
        throw new Error("timed out");
      } }),
    });
    expect(r.outcome).toBe("unparseable");
  });

  it("missing PG_VERSION -> skipped (no board noise)", async () => {
    const r = await inspectPgClientVersion({
      dataDir: "/d",
      pgDumpPath: "pg_dump",
      io: io({ async readServerVersion() {
        return null;
      } }),
    });
    expect(r.outcome).toBe("skipped");
  });
});

describe("buildPgClientVersionAlertContent", () => {
  it("mismatch content names both majors, recovery, and fingerprint", () => {
    const { title, description } = buildPgClientVersionAlertContent(
      { outcome: "mismatch", clientMajor: 16, serverMajor: 18, message: "client older" },
      AT,
      "pg_dump",
    );
    expect(title).toContain("pg_dump client");
    expect(description).toContain("**16**");
    expect(description).toContain("**18**");
    expect(description).toContain("dpkg -x");
    expect(description).toContain(PGCLIENT_VERSION_ALERT_FINGERPRINT);
  });

  it("never leaks a connection string (A09)", () => {
    const { description } = buildPgClientVersionAlertContent(
      { outcome: "client_missing", pgDumpPath: "pg_dump", message: "missing" },
      AT,
      "pg_dump",
    );
    expect(description).not.toMatch(/postgres(?:ql)?:\/\//i);
  });
});

describe("createPgClientVersionPreflightReporter", () => {
  it("raises a single deduped board alert on mismatch and resolves it once fixed", async () => {
    const { board, records } = createFakeBoard();

    // First run: client behind -> alert raised.
    const mismatchReporter = createPgClientVersionPreflightReporter({
      dataDir: "/d",
      pgDumpPath: "pg_dump",
      board,
      companyId: "company-1",
      now: () => AT,
      io: io({ async readClientVersion() {
        return "pg_dump (PostgreSQL) 16.4";
      } }),
    });
    const first = await mismatchReporter.run();
    expect(first.outcome).toBe("mismatch");
    expect(records).toHaveLength(1);
    expect(records[0]!.fingerprint).toBe(PGCLIENT_VERSION_ALERT_FINGERPRINT);
    expect(records[0]!.status).toBe("todo");

    // Second mismatch run: no duplicate issue.
    await mismatchReporter.run();
    expect(records).toHaveLength(1);

    // Client upgraded -> ok run resolves the open alert.
    const okReporter = createPgClientVersionPreflightReporter({
      dataDir: "/d",
      pgDumpPath: "pg_dump",
      board,
      companyId: "company-1",
      now: () => AT,
      io: io({}),
    });
    const fixed = await okReporter.run();
    expect(fixed.outcome).toBe("ok");
    expect(records[0]!.status).toBe("done");
  });

  it("client_missing raises an alert too", async () => {
    const { board, records } = createFakeBoard();
    const reporter = createPgClientVersionPreflightReporter({
      dataDir: "/d",
      pgDumpPath: "/no/such/pg_dump",
      board,
      companyId: "company-1",
      now: () => AT,
      io: io({ async readClientVersion() {
        throw enoent();
      } }),
    });
    const r = await reporter.run();
    expect(r.outcome).toBe("client_missing");
    expect(records).toHaveLength(1);
  });

  it("ok with no open alert is a no-op on the board", async () => {
    const { board, records } = createFakeBoard();
    const reporter = createPgClientVersionPreflightReporter({
      dataDir: "/d",
      pgDumpPath: "pg_dump",
      board,
      companyId: "company-1",
      now: () => AT,
      io: io({}),
    });
    await reporter.run();
    expect(records).toHaveLength(0);
  });

  it("null board (channel off) still returns the decision without throwing", async () => {
    const reporter = createPgClientVersionPreflightReporter({
      dataDir: "/d",
      pgDumpPath: "pg_dump",
      board: null,
      companyId: null,
      now: () => AT,
      io: io({ async readClientVersion() {
        return "pg_dump (PostgreSQL) 16.4";
      } }),
    });
    const r = await reporter.run();
    expect(r.outcome).toBe("mismatch");
  });

  it("a board push failure never throws out of run()", async () => {
    const { board } = createFakeBoard();
    const throwingBoard: DatabaseBackupAlertBoard = {
      ...board,
      async findOpenAlert() {
        throw new Error("board down");
      },
    };
    const reporter = createPgClientVersionPreflightReporter({
      dataDir: "/d",
      pgDumpPath: "pg_dump",
      board: throwingBoard,
      companyId: "company-1",
      now: () => AT,
      io: io({ async readClientVersion() {
        return "pg_dump (PostgreSQL) 16.4";
      } }),
    });
    const r = await reporter.run();
    expect(r.outcome).toBe("mismatch");
  });
});
