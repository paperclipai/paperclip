import { describe, expect, it, vi } from "vitest";
import {
  buildCostEventMirrorLine,
  listCostEventDateKeys,
  mirrorCostEventToWorkspace,
  parseCostSince,
  readCostEventsMirror,
  __testUtils,
} from "../services/cost-event-mirror.ts";

const { utcDateKey } = __testUtils;

const sampleEvent = {
  id: "evt-1",
  companyId: "co-1",
  agentId: "agent-1",
  issueId: "issue-1",
  projectId: "proj-1",
  provider: "anthropic",
  biller: "anthropic",
  model: "claude-opus-4",
  inputTokens: 100,
  cachedInputTokens: 50,
  outputTokens: 25,
  costCents: 7,
  occurredAt: new Date("2026-10-02T12:00:00.000Z"),
};

function makeDb(rows: Array<{ cwd: string | null }>) {
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  });
  return { select } as unknown as Parameters<typeof mirrorCostEventToWorkspace>[0];
}

describe("cost-event-mirror", () => {
  describe("buildCostEventMirrorLine", () => {
    it("writes one JSON line with the scope's required fields", () => {
      const line = buildCostEventMirrorLine(sampleEvent);
      const trimmed = line.trim();
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      expect(line.endsWith("\n")).toBe(true);
      expect(parsed.provider).toBe("anthropic");
      expect(parsed.model).toBe("claude-opus-4");
      expect(parsed.agent).toBe("agent-1");
      expect(parsed.issue_id).toBe("issue-1");
      expect(parsed.cost_cents).toBe(7);
      expect(parsed.ts).toBe("2026-10-02T12:00:00.000Z");
      expect((parsed.tokens as Record<string, number>).input).toBe(100);
      expect((parsed.tokens as Record<string, number>).cached).toBe(50);
      expect((parsed.tokens as Record<string, number>).output).toBe(25);
    });
  });

  describe("utcDateKey", () => {
    it("formats the date in UTC", () => {
      expect(utcDateKey(new Date("2026-10-02T23:59:00.000Z"))).toBe("2026-10-02");
      expect(utcDateKey(new Date("2026-10-03T00:00:00.000Z"))).toBe("2026-10-03");
    });

    it("accepts ISO strings", () => {
      expect(utcDateKey("2026-10-02T12:00:00.000Z")).toBe("2026-10-02");
    });
  });

  describe("parseCostSince", () => {
    it("returns the fallback for empty input", () => {
      expect(parseCostSince(undefined, 42)).toBe(42);
      expect(parseCostSince("", 7)).toBe(7);
    });

    it("parses relative durations", () => {
      const now = Date.now();
      const before = Date.now();
      const value = parseCostSince("1h");
      expect(value).toBeGreaterThanOrEqual(now - 60 * 60 * 1000 - 5);
      expect(value).toBeLessThanOrEqual(before - 60 * 60 * 1000 + 5);
    });

    it("parses dates and timestamps", () => {
      const v = parseCostSince("2026-10-01");
      expect(v).toBe(Date.parse("2026-10-01"));
    });

    it("rejects garbage", () => {
      expect(() => parseCostSince("garbage")).toThrow(/invalid --since/);
    });
  });

  describe("listCostEventDateKeys", () => {
    it("lists one key for a same-day window", () => {
      const keys = listCostEventDateKeys(Date.parse("2026-10-02T01:00:00Z"), Date.parse("2026-10-02T23:00:00Z"));
      expect(keys).toEqual(["2026-10-02"]);
    });

    it("lists three keys across three days", () => {
      const keys = listCostEventDateKeys(Date.parse("2026-10-01T23:00:00Z"), Date.parse("2026-10-03T01:00:00Z"));
      expect(keys).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    });

    it("returns empty when from > to", () => {
      expect(listCostEventDateKeys(2, 1)).toEqual([]);
    });
  });

  describe("mirrorCostEventToWorkspace", () => {
    it("skips when the event has no projectId", async () => {
      const mkdir = vi.fn();
      const appendFile = vi.fn();
      const out = await mirrorCostEventToWorkspace(makeDb([{ cwd: "/x" }]), { ...sampleEvent, projectId: null }, {
        fsOverride: { mkdir, appendFile } as never,
      });
      expect(out.written).toBe(false);
      expect(mkdir).not.toHaveBeenCalled();
      expect(appendFile).not.toHaveBeenCalled();
    });

    it("writes a line to the workspace's daily ndjson file", async () => {
      const mkdir = vi.fn().mockResolvedValue(undefined);
      const appendFile = vi.fn().mockResolvedValue(undefined);
      const db = makeDb([{ cwd: "/workspaces/labeeb" }]);
      const warn = vi.fn();
      const out = await mirrorCostEventToWorkspace(db, sampleEvent, {
        fsOverride: { mkdir, appendFile } as never,
        loggerOverride: { warn } as never,
      });
      expect(out.written).toBe(true);
      expect(out.path).toContain("/workspaces/labeeb/.changes/2026-10-02/cost-events.ndjson");
      expect(mkdir).toHaveBeenCalledWith(expect.stringContaining("/.changes/2026-10-02"), { recursive: true });
      const appendedArg = (appendFile.mock.calls[0] ?? [])[1] as string;
      const parsed = JSON.parse(appendedArg.trim()) as Record<string, unknown>;
      expect(parsed.provider).toBe("anthropic");
      expect(parsed.cost_cents).toBe(7);
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not throw when the workspace has no cwd", async () => {
      const mkdir = vi.fn();
      const appendFile = vi.fn();
      const warn = vi.fn();
      const db = makeDb([{ cwd: null }]);
      const out = await mirrorCostEventToWorkspace(db, sampleEvent, {
        fsOverride: { mkdir, appendFile } as never,
        loggerOverride: { warn } as never,
      });
      expect(out.written).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/no primary workspace/));
    });

    it("warns and returns when fs.appendFile fails", async () => {
      const mkdir = vi.fn().mockResolvedValue(undefined);
      const appendFile = vi.fn().mockRejectedValue(new Error("disk full"));
      const warn = vi.fn();
      const db = makeDb([{ cwd: "/workspaces/labeeb" }]);
      const out = await mirrorCostEventToWorkspace(db, sampleEvent, {
        fsOverride: { mkdir, appendFile } as never,
        loggerOverride: { warn } as never,
      });
      expect(out.written).toBe(false);
      expect(warn).toHaveBeenCalled();
    });

    it("warns and returns when the DB lookup itself fails", async () => {
      const select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockRejectedValue(new Error("db down")),
      });
      const warn = vi.fn();
      const out = await mirrorCostEventToWorkspace({ select } as unknown as Parameters<typeof mirrorCostEventToWorkspace>[0], sampleEvent, {
        loggerOverride: { warn } as never,
      });
      expect(out.written).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/failed to look up/));
    });
  });

  describe("readCostEventsMirror", () => {
    it("returns parsed ndjson records inside the time window", async () => {
      const contents = [
        JSON.stringify({ provider: "anthropic", model: "x", agent: "a", issue_id: "i", tokens: { input: 1, cached: 0, output: 1 }, cost_cents: 1, ts: "2026-10-02T11:00:00.000Z" }),
        JSON.stringify({ provider: "openai", model: "y", agent: "b", issue_id: null, tokens: { input: 2, cached: 0, output: 3 }, cost_cents: 2, ts: "2026-10-02T13:00:00.000Z" }),
        "",
      ].join("\n");
      const readFile = vi.fn().mockImplementation(async (p: string) => {
        if (p.endsWith("/2026-10-02/cost-events.ndjson")) return contents;
        const err: NodeJS.ErrnoException = new Error("missing");
        err.code = "ENOENT";
        throw err;
      });
      const readdir = vi.fn();
      const stat = vi.fn();
      const records = await readCostEventsMirror("/workspaces/labeeb", {
        since: "2026-10-02T10:00:00Z",
        until: "2026-10-02T14:00:00Z",
        fsOverride: { readFile, readdir, stat } as never,
      });
      expect(records.map((r) => r.parsed?.provider)).toEqual(["anthropic", "openai"]);
      expect(records.map((r) => r.occurredAtMs)).toEqual([
        Date.parse("2026-10-02T11:00:00.000Z"),
        Date.parse("2026-10-02T13:00:00.000Z"),
      ]);
    });

    it("skips records outside the window", async () => {
      const contents = [
        JSON.stringify({ provider: "anthropic", ts: "2026-10-01T00:00:00.000Z" }),
        JSON.stringify({ provider: "openai", ts: "2026-10-02T12:00:00.000Z" }),
      ].join("\n");
      const readFile = vi.fn().mockResolvedValue(contents);
      const records = await readCostEventsMirror("/w", {
        since: "2026-10-02T00:00:00Z",
        until: "2026-10-02T23:59:59Z",
        fsOverride: { readFile, readdir: vi.fn(), stat: vi.fn() } as never,
      });
      expect(records.length).toBe(1);
      expect(records[0]?.parsed?.provider).toBe("openai");
    });

    it("skips malformed lines but keeps the rest", async () => {
      const contents = [
        "not-json",
        JSON.stringify({ provider: "anthropic", ts: "2026-10-02T12:00:00.000Z" }),
      ].join("\n");
      const readFile = vi.fn().mockResolvedValue(contents);
      const records = await readCostEventsMirror("/w", {
        since: "2026-10-02T00:00:00Z",
        until: "2026-10-02T23:59:59Z",
        fsOverride: { readFile, readdir: vi.fn(), stat: vi.fn() } as never,
      });
      expect(records.length).toBe(1);
      expect(records[0]?.parsed?.provider).toBe("anthropic");
    });

    it("returns empty when the directory does not exist", async () => {
      const readFile = vi.fn().mockImplementation(async () => {
        const err: NodeJS.ErrnoException = new Error("missing");
        err.code = "ENOENT";
        throw err;
      });
      const records = await readCostEventsMirror("/w", {
        since: "1h",
        fsOverride: { readFile, readdir: vi.fn(), stat: vi.fn() } as never,
      });
      expect(records).toEqual([]);
    });
  });
});