import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { agentExecutionStopBlocker } from "./agent-execution-stop.js";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";

vi.mock("./hot-restart.js", () => ({ readProcessStartedAt: vi.fn(async () => null) }));
vi.mock("./native-local-process-stop.js", () => ({ hasNativeLocalProcessStop: vi.fn() }));
vi.mock("./cancelled-native-startup.js", () => ({ isCancelledNativeStartup: vi.fn() }));
vi.mock("./conversation-continuation.js", () => ({ runUsedConversationAdapter: vi.fn() }));

const SCAN_FIELDS = ["id", "status", "startedAt", "controllerLeaseExpiresAt", "processPid", "processGroupId",
  "processStartedAt", "runtimeMode", "executionCancellationState"];
const FULL_FIELDS = Object.keys(getTableColumns(heartbeatRuns));
const JSONB_COLUMNS = [`"result_json"`, `"runner_profile_json"`, `"context_snapshot"`];

type Query = { sql: string; params: unknown[] };
const fromRuns = (sql: string) => /^select .*? from "(\w+)"/s.exec(sql)?.[1] === "heartbeat_runs";

function fixture(scan: Record<string, unknown>[], full: Record<string, unknown>[] = []) {
  const queries: Query[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (!fromRuns(sql)) return { rows: [] };
    if (sql.includes(`'executionCancellation'`)) return { rows: scan.map(row => SCAN_FIELDS.map(key => row[key] ?? null)) };
    if (/where "heartbeat_runs"\."id" = \$1$/.test(sql)) {
      return { rows: full.filter(row => row.id === params[0]).map(row => FULL_FIELDS.map(key => row[key] ?? null)) };
    }
    return { rows: [] };
  }) as unknown as Db;
  const runReads = () => queries.filter(query => fromRuns(query.sql));
  const fullReads = () => runReads().filter(query => /where "heartbeat_runs"\."id" = \$1$/.test(query.sql));
  return { db, queries, runReads, fullReads };
}

const cancelled = (extra: Record<string, unknown> = {}) => ({
  id: "run-1", status: "cancelled", startedAt: new Date("2026-11-01T00:00:00Z"), controllerLeaseExpiresAt: null,
  processPid: null, processGroupId: null, processStartedAt: null, runtimeMode: "legacy",
  executionCancellationState: null, ...extra,
});
const fullRow = (extra: Record<string, unknown> = {}) => ({
  ...cancelled(), companyId: "company-1", agentId: "agent-1", executionStage: "settled", resultJson: null, ...extra,
});

beforeEach(() => {
  vi.mocked(hasNativeLocalProcessStop).mockResolvedValue(false);
  vi.mocked(isCancelledNativeStartup).mockResolvedValue(false);
  vi.mocked(runUsedConversationAdapter).mockResolvedValue(true);
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error(), { code: "ESRCH" }); });
});
afterEach(() => vi.restoreAllMocks());

describe("agentExecutionStopBlocker history reads", () => {
  it("scans history without jsonb documents, restricted to rows that can hold a stop", async () => {
    const { db, runReads, fullReads } = fixture([]);
    expect(await agentExecutionStopBlocker(db, ["agent-1"])).toBeNull();
    expect(runReads()).toHaveLength(1);
    const [scan] = runReads();
    const selectList = scan!.sql.slice(0, scan!.sql.indexOf(` from "heartbeat_runs"`));
    for (const column of JSONB_COLUMNS) expect(selectList).not.toContain(`${column},`);
    expect(selectList).toContain(`"result_json"->'executionCancellation'->>'state'`);
    expect(scan!.sql).toContain(`"heartbeat_runs"."status" not in`);
    expect(scan!.sql).toContain(`"heartbeat_runs"."process_pid" is not null`);
    expect(scan!.sql).toContain(`"heartbeat_runs"."process_group_id" is not null`);
    expect(scan!.sql).toContain(`"heartbeat_runs"."controller_lease_expires_at" >`);
    expect(scan!.sql).toContain(`"environment_leases"."provider" not in`);
    expect(scan!.sql).toContain(`"native_run_finalizations"."lease_owner" is not null`);
    expect(fullReads()).toHaveLength(0);
  });

  it("skips the full-row read for an acknowledged legacy cancellation", async () => {
    const { db, fullReads } = fixture([cancelled({ executionCancellationState: "acknowledged" })]);
    expect(await agentExecutionStopBlocker(db, ["agent-1"])).toBeNull();
    expect(fullReads()).toHaveLength(0);
  });

  it("does not read full rows for runs with a recorded process", async () => {
    const { db, fullReads } = fixture([
      cancelled({ processPid: 4242 }),
      cancelled({ id: "run-2", status: "succeeded", processGroupId: 4243 }),
    ]);
    expect(await agentExecutionStopBlocker(db, ["agent-1"])).toBeNull();
    expect(fullReads()).toHaveLength(0);
  });

  it("loads the full row by id and passes it to the legacy receipt checks", async () => {
    const { db, fullReads } = fixture([cancelled()], [fullRow({ resultJson: { other: true } })]);
    expect(await agentExecutionStopBlocker(db, ["agent-1"])).toBe("legacy_stop_unproven");
    expect(fullReads()).toHaveLength(1);
    expect(fullReads()[0]!.params).toEqual(["run-1"]);
    const loaded = vi.mocked(runUsedConversationAdapter).mock.calls[0]![1];
    expect(loaded).toMatchObject({ id: "run-1", companyId: "company-1", resultJson: { other: true } });
    expect(vi.mocked(isCancelledNativeStartup).mock.calls[0]![1]).toBe(loaded);
  });

  it("still applies the acknowledgement check to the loaded row", async () => {
    const { db } = fixture([cancelled()], [fullRow({ executionStage: "running",
      resultJson: { executionCancellation: { state: "acknowledged" } } })]);
    expect(await agentExecutionStopBlocker(db, ["agent-1"])).toBeNull();
  });

  it("loads the full row for native receipt checks", async () => {
    const { db } = fixture([cancelled({ runtimeMode: "native" })], [fullRow({ runtimeMode: "native" })]);
    expect(await agentExecutionStopBlocker(db, ["agent-1"])).toBe("native_stop_unproven");
    expect(vi.mocked(hasNativeLocalProcessStop)).toHaveBeenCalledWith(db, "company-1", "run-1");
    vi.mocked(hasNativeLocalProcessStop).mockResolvedValue(true);
    expect(await agentExecutionStopBlocker(db, ["agent-1"])).toBeNull();
  });

  it("fails instead of passing when the full row cannot be read", async () => {
    const { db } = fixture([cancelled()], []);
    await expect(agentExecutionStopBlocker(db, ["agent-1"])).rejects.toThrow(/run-1/);
  });

  it("keeps non-terminal and leased runs blocking", async () => {
    expect(await agentExecutionStopBlocker(fixture([cancelled({ status: "running" })]).db, ["agent-1"]))
      .toBe("run_not_terminal");
    expect(await agentExecutionStopBlocker(fixture([cancelled({ status: "succeeded",
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })]).db, ["agent-1"])).toBe("run_controller_lease_held");
  });
});
