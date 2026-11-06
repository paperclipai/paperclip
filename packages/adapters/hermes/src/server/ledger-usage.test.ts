import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findLedgerForSession, hermesStateDbPath, readRunUsageDelta, readSessionUsage } from "./ledger-usage.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

/**
 * Build a minimal Hermes ledger. The columns match the real schema's counter
 * names; the table carries one row per (session, model).
 */
function createLedger(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_model_usage (
    session_id TEXT, model TEXT,
    api_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER
  )`);
  db.close();
}

function insertUsage(
  dbPath: string,
  sessionId: string,
  usage: { apiCalls?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO session_model_usage
       (session_id, model, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES (?, 'k3-256k', ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    usage.apiCalls ?? 1,
    usage.input ?? 0,
    usage.output ?? 0,
    usage.cacheRead ?? 0,
    usage.cacheWrite ?? 0,
  );
  db.close();
}

let root: string;
let savedHermesHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-ledger-"));
  savedHermesHome = process.env.HERMES_HOME;
});

afterEach(() => {
  if (savedHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHermesHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("readSessionUsage", () => {
  it("returns null without a session id or ledger file", () => {
    expect(readSessionUsage(null, path.join(root, "missing.db"))).toBeNull();
    expect(readSessionUsage("local-x", null)).toBeNull();
    expect(readSessionUsage("local-x", path.join(root, "missing.db"))).toBeNull();
  });

  it("returns null for a database that is not a Hermes ledger", () => {
    // Unknown, not zero: a caller must not mistake this for an idle run.
    const other = path.join(root, "other.db");
    const db = new DatabaseSync(other);
    db.exec("CREATE TABLE something_else (id INTEGER)");
    db.close();
    expect(readSessionUsage("local-x", other)).toBeNull();
  });

  it("maps cache reads and cache writes to separate buckets", () => {
    // Paperclip's UsageSummary contract: cachedInputTokens is cache reads
    // only; cache writes belong to inputTokens (as a marked subset).
    const dbPath = path.join(root, "state.db");
    createLedger(dbPath);
    insertUsage(dbPath, "local-a", { input: 100, output: 10, cacheRead: 900, cacheWrite: 50 });
    expect(readSessionUsage("local-a", dbPath)).toEqual({
      inputTokens: 100,
      cachedInputTokens: 900,
      cacheWriteTokens: 50,
      outputTokens: 10,
    });
  });
});

describe("readRunUsageDelta", () => {
  it("subtracts a prior snapshot, because resumed sessions accumulate", () => {
    const dbPath = path.join(root, "state.db");
    createLedger(dbPath);
    insertUsage(dbPath, "local-a", { input: 40102, output: 3061, cacheRead: 579840 });
    const before = { inputTokens: 39000, cachedInputTokens: 570000, cacheWriteTokens: 0, outputTokens: 2900 };
    expect(readRunUsageDelta("local-a", dbPath, before)).toEqual({
      inputTokens: 1102,
      cachedInputTokens: 9840,
      cacheWriteTokens: 0,
      outputTokens: 161,
    });
  });

  it("never reports a negative delta when the ledger shrank", () => {
    // A reset profile or a rotated ledger can leave fewer rows than before.
    const dbPath = path.join(root, "state.db");
    createLedger(dbPath);
    insertUsage(dbPath, "local-a", { input: 100, output: 10, cacheRead: 200 });
    const before = { inputTokens: 250, cachedInputTokens: 500, cacheWriteTokens: 0, outputTokens: 40 };
    expect(readRunUsageDelta("local-a", dbPath, before)).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
  });

  it("reports the whole session for a run that started fresh", () => {
    const dbPath = path.join(root, "state.db");
    createLedger(dbPath);
    insertUsage(dbPath, "local-a", { input: 40102, output: 3061, cacheRead: 579840 });
    expect(readRunUsageDelta("local-a", dbPath, null)).toEqual({
      inputTokens: 40102,
      cachedInputTokens: 579840,
      cacheWriteTokens: 0,
      outputTokens: 3061,
    });
  });
});

describe("findLedgerForSession", () => {
  it("returns null for an unknown session", () => {
    process.env.HERMES_HOME = root;
    expect(findLedgerForSession(null)).toBeNull();
    expect(findLedgerForSession("local-does-not-exist-anywhere")).toBeNull();
  });

  it("finds the profile ledger that holds the session", () => {
    // The control plane and the run do not share a HERMES_HOME, so the session
    // id is the only reliable key. This search is what makes that work.
    process.env.HERMES_HOME = root;
    createLedger(path.join(root, "state.db")); // exists, but does not hold the session
    const profileDb = path.join(root, "profiles", "worker", "state.db");
    createLedger(profileDb);
    insertUsage(profileDb, "local-a", { input: 100, output: 10, cacheRead: 50 });
    expect(findLedgerForSession("local-a")).toBe(profileDb);
  });

  it("prefers the run's configured home over the parent environment", () => {
    // An adapter config can point the child at a HERMES_HOME the parent
    // process never sets; discovery must still find that ledger.
    process.env.HERMES_HOME = path.join(root, "parent-home");
    const childDb = path.join(root, "child-home", "state.db");
    createLedger(childDb);
    insertUsage(childDb, "local-a", { input: 100, output: 10 });
    expect(findLedgerForSession("local-a", path.join(root, "child-home"))).toBe(childDb);
  });

  it("ignores ledgers that hold only an empty row for the session", () => {
    process.env.HERMES_HOME = root;
    const emptyDb = path.join(root, "state.db");
    createLedger(emptyDb);
    insertUsage(emptyDb, "local-a", { input: 0, output: 0, cacheRead: 0 });
    const fullDb = path.join(root, "profiles", "worker", "state.db");
    createLedger(fullDb);
    insertUsage(fullDb, "local-a", { input: 100, output: 10, cacheRead: 50 });
    expect(findLedgerForSession("local-a")).toBe(fullDb);
  });
});

describe("hermesStateDbPath", () => {
  it("uses HERMES_HOME when the profile sets it", () => {
    expect(hermesStateDbPath("/Users/example/.hermes/profiles/worker")).toBe(
      "/Users/example/.hermes/profiles/worker/state.db",
    );
  });

  it("falls back to ~/.hermes when HERMES_HOME is empty", () => {
    const resolved = hermesStateDbPath("");
    expect(resolved?.endsWith("/.hermes/state.db")).toBe(true);
  });
});
