import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { weeklyUsageService } from "../services/weekly-usage.ts";

type SelectRows = unknown[];

function createDbStub(selectRows: SelectRows[]) {
  const pendingSelects = [...selectRows];
  const selectOrderBy = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectWhere = vi.fn(() => ({
    orderBy: selectOrderBy,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(pendingSelects.shift() ?? [])),
  }));
  const selectInnerJoin = vi.fn(() => ({
    where: selectWhere,
  }));
  const selectFrom = vi.fn(() => ({
    innerJoin: selectInnerJoin,
    where: selectWhere,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(pendingSelects.shift() ?? [])),
  }));
  const select = vi.fn(() => ({
    from: selectFrom,
  }));

  return {
    db: { select },
    selectOrderBy,
  };
}

async function tmpUsagePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-weekly-usage-"));
  return {
    dir,
    file: path.join(dir, "usage.json"),
  };
}

describe("weeklyUsageService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a rolling 7-day per-adapter usage snapshot without double-counting repeated updates", async () => {
    const now = new Date("2026-05-03T12:00:00.000Z");
    const { dir, file } = await tmpUsagePath();
    const rows = [
      {
        id: "run-1",
        adapterType: "claude_local",
        finishedAt: new Date("2026-05-03T11:00:00.000Z"),
        createdAt: new Date("2026-05-03T10:59:00.000Z"),
        usageJson: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 50 },
      },
      {
        id: "run-2",
        adapterType: "codex_local",
        finishedAt: new Date("2026-05-02T11:00:00.000Z"),
        createdAt: new Date("2026-05-02T10:59:00.000Z"),
        usageJson: { input_tokens: 200, cache_read_input_tokens: 10, output_tokens: 40 },
      },
      {
        id: "future-run",
        adapterType: "codex_local",
        finishedAt: new Date("2026-05-03T13:00:00.000Z"),
        createdAt: new Date("2026-05-03T12:59:00.000Z"),
        usageJson: { inputTokens: 999, outputTokens: 999 },
      },
    ];
    const dbStub = createDbStub([rows, rows]);
    const fetchMock = vi.fn();
    const service = weeklyUsageService(dbStub.db as any, {
      usageFilePath: file,
      env: {
        PAPERCLIP_WEEKLY_USAGE_CAP_CLAUDE_LOCAL_TOKENS: "1000",
        PAPERCLIP_WEEKLY_USAGE_CAP_CODEX_LOCAL_TOKENS: "1000",
      },
      now: () => now,
      fetch: fetchMock as any,
    });

    await service.updateFromHeartbeatRuns();
    const second = await service.updateFromHeartbeatRuns();

    expect(second.generatedAt).toBe(now.toISOString());
    expect(second.lastUpdatedAt).toBe(now.toISOString());
    expect(second.window).toEqual({
      kind: "rolling_7d",
      start: "2026-04-26T12:00:00.000Z",
      end: "2026-05-03T12:00:00.000Z",
    });
    expect(second.adapters.claude_local.totalTokens).toBe(175);
    expect(second.adapters.claude_local.runIds).toEqual(["run-1"]);
    expect(second.adapters.claude_local.cursor).toEqual({
      includedRunIds: ["run-1"],
      latestRunFinishedAt: "2026-05-03T11:00:00.000Z",
    });
    expect(second.adapters.codex_local.totalTokens).toBe(250);
    expect(second.adapters.codex_local.runIds).toEqual(["run-2"]);
    expect(fetchMock).not.toHaveBeenCalled();

    const persisted = JSON.parse(await fs.readFile(file, "utf8"));
    expect(persisted.adapters.claude_local.totalTokens).toBe(175);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fires each threshold once while usage remains above it", async () => {
    const now = new Date("2026-05-03T12:00:00.000Z");
    const { dir, file } = await tmpUsagePath();
    const rows = [
      {
        id: "run-1",
        adapterType: "codex_local",
        finishedAt: new Date("2026-05-03T11:00:00.000Z"),
        createdAt: new Date("2026-05-03T10:59:00.000Z"),
        usageJson: { inputTokens: 95, outputTokens: 0 },
      },
    ];
    const dbStub = createDbStub([rows, rows]);
    const fetchMock = vi.fn(async () => ({ ok: true }));
    const service = weeklyUsageService(dbStub.db as any, {
      usageFilePath: file,
      env: {
        PAPERCLIP_WEEKLY_USAGE_CAP_CODEX_LOCAL_TOKENS: "100",
        PAPERCLIP_P0_TELEGRAM_BOT_TOKEN: "token",
        PAPERCLIP_P0_TELEGRAM_CHAT_ID: "chat",
      },
      now: () => now,
      fetch: fetchMock as any,
    });

    await service.updateFromHeartbeatRuns();
    const second = await service.updateFromHeartbeatRuns();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(second.adapters.codex_local.thresholds.p1_70.fired).toBe(true);
    expect(second.adapters.codex_local.thresholds.p0_85.fired).toBe(true);
    expect(second.adapters.codex_local.thresholds.p0_hard_stop_95.fired).toBe(true);
    expect(second.adapters.codex_local.hardStopped).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not mark threshold alerts fired when Telegram delivery is not configured", async () => {
    const now = new Date("2026-05-03T12:00:00.000Z");
    const { dir, file } = await tmpUsagePath();
    const rows = [
      {
        id: "run-1",
        adapterType: "codex_local",
        finishedAt: new Date("2026-05-03T11:00:00.000Z"),
        createdAt: new Date("2026-05-03T10:59:00.000Z"),
        usageJson: { inputTokens: 95, outputTokens: 0 },
      },
    ];
    const dbStub = createDbStub([rows]);
    const fetchMock = vi.fn();
    const service = weeklyUsageService(dbStub.db as any, {
      usageFilePath: file,
      env: {
        PAPERCLIP_WEEKLY_USAGE_CAP_CODEX_LOCAL_TOKENS: "100",
      },
      now: () => now,
      fetch: fetchMock as any,
    });

    const snapshot = await service.updateFromHeartbeatRuns();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(snapshot.adapters.codex_local.thresholds.p1_70.fired).toBe(false);
    expect(snapshot.adapters.codex_local.thresholds.p0_85.fired).toBe(false);
    expect(snapshot.adapters.codex_local.thresholds.p0_hard_stop_95.fired).toBe(false);
    expect(snapshot.adapters.codex_local.hardStopped).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("blocks non-critical hard-stopped adapter agents but exempts CEO and CTO roles", async () => {
    const { dir, file } = await tmpUsagePath();
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      generatedAt: "2026-05-03T12:00:00.000Z",
      lastUpdatedAt: "2026-05-03T12:00:00.000Z",
      window: {
        kind: "rolling_7d",
        start: "2026-04-26T12:00:00.000Z",
        end: "2026-05-03T12:00:00.000Z",
      },
      adapters: {
        claude_local: {
          adapterType: "claude_local",
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          runCount: 0,
          runIds: [],
          cursor: { includedRunIds: [], latestRunFinishedAt: null },
          lastRunFinishedAt: null,
          cap: { weeklyTotalTokens: 100, source: "test", note: "test" },
          thresholds: {
            p1_70: { fired: false, firedAt: null, lastPercent: 0 },
            p0_85: { fired: false, firedAt: null, lastPercent: 0 },
            p0_hard_stop_95: { fired: false, firedAt: null, lastPercent: 0 },
          },
          hardStopped: false,
        },
        codex_local: {
          adapterType: "codex_local",
          inputTokens: 95,
          cachedInputTokens: 0,
          outputTokens: 0,
          totalTokens: 95,
          runCount: 1,
          runIds: ["run-1"],
          cursor: { includedRunIds: ["run-1"], latestRunFinishedAt: "2026-05-03T11:00:00.000Z" },
          lastRunFinishedAt: "2026-05-03T11:00:00.000Z",
          cap: { weeklyTotalTokens: 100, source: "test", note: "test" },
          thresholds: {
            p1_70: { fired: true, firedAt: "2026-05-03T12:00:00.000Z", lastPercent: 95 },
            p0_85: { fired: true, firedAt: "2026-05-03T12:00:00.000Z", lastPercent: 95 },
            p0_hard_stop_95: { fired: true, firedAt: "2026-05-03T12:00:00.000Z", lastPercent: 95 },
          },
          hardStopped: true,
        },
      },
    }, null, 2));

    const dbStub = createDbStub([
      [{
        id: "agent-1",
        companyId: "company-1",
        adapterType: "codex_local",
        role: "Scraper Developer",
        name: "Scraper Developer",
        title: null,
      }],
      [{
        id: "agent-cto",
        companyId: "company-1",
        adapterType: "codex_local",
        role: "CTO",
        name: "CTO",
        title: "Chief Technology Officer",
      }],
    ]);
    const service = weeklyUsageService(dbStub.db as any, { usageFilePath: file });

    await expect(service.getInvocationBlock("company-1", "agent-1")).resolves.toEqual({
      scopeType: "adapter_type",
      scopeId: "codex_local",
      scopeName: "Adapter type codex_local",
      reason: "Agent cannot start because codex_local rolling 7-day usage is at 95.0% of the configured weekly token cap.",
    });
    await expect(service.getInvocationBlock("company-1", "agent-cto")).resolves.toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
