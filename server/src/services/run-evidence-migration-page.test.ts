import type { Db } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { migrateRunEvidencePage } from "./run-evidence-migration-page.js";
import { idleWorkSnapshot } from "./task-admission.js";

const migrate = vi.hoisted(() => vi.fn());
vi.mock("./run-evidence-migration.js", () => ({ migrateRunEvidence: migrate }));
afterEach(() => vi.resetAllMocks());

it("leaves active and unproven sources blocked and only retries settled native coverage through the archive owner", async () => {
  migrate.mockResolvedValueOnce({ items: [
    { kind: "log", id: "active", state: "blocked", reason: "legacy_writer_not_settled" },
    { kind: "log", id: "settled", state: "blocked", reason: "native_log_source_coverage_unproven" },
    { kind: "log", id: "unproven", state: "blocked", reason: "legacy_length_or_digest_mismatch" },
  ], nextRunId: "last" }).mockResolvedValueOnce({ items: [{ kind: "log", id: "settled", state: "migrated", historicalArchive: true }] });
  const db = {} as Db;
  const result = await migrateRunEvidencePage(db, { kinds: ["log"], limit: 3 });
  expect(migrate).toHaveBeenCalledTimes(2);
  expect(migrate).toHaveBeenLastCalledWith(db, expect.objectContaining({ apply: true, runId: "settled", preserveSettledNativeFiles: true }));
  expect(result).toMatchObject({ nextRunId: "last", items: [
    { id: "active", state: "blocked" }, { id: "settled", state: "migrated" }, { id: "unproven", state: "blocked" },
  ] });
});

it("keeps ownership and idle work until an aborted upload actually settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  migrate.mockImplementationOnce(async () => { await gate; return { items: [] }; }).mockResolvedValue({ items: [] });
  const db = {} as Db, signal = new AbortController();
  const before = idleWorkSnapshot();
  const first = migrateRunEvidencePage(db, { kinds: ["log"], signal: signal.signal });
  signal.abort(new Error("deadline"));
  expect(await migrateRunEvidencePage(db, { kinds: ["log"] })).toEqual({ items: [], busy: true });
  expect(idleWorkSnapshot().active).toBeGreaterThan(before.active);
  expect(migrate).toHaveBeenCalledOnce();
  release();
  await expect(first).rejects.toThrow("deadline");
  expect(idleWorkSnapshot().active).toBe(before.active);
  expect(await migrateRunEvidencePage(db, { kinds: ["log"] })).toEqual({ items: [] });
});

it("does not serialize different database owners and releases a failed owner", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  migrate.mockImplementationOnce(async () => { await gate; throw new Error("storage unavailable"); }).mockResolvedValue({ items: [] });
  const firstDb = {} as Db;
  const first = migrateRunEvidencePage(firstDb, { kinds: ["log"] });
  const settled = expect(first).rejects.toThrow("storage unavailable");
  expect(await migrateRunEvidencePage({} as Db, { kinds: ["trace"] })).toEqual({ items: [] });
  release(); await settled;
  expect(await migrateRunEvidencePage(firstDb, { kinds: ["log"] })).toEqual({ items: [] });
});
