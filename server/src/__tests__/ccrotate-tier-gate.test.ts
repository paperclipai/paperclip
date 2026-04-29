import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCcrotateTierGate,
  evaluateTierCacheSnapshot,
  mapAdapterToCcrotateTarget,
  readDefaultCcrotateTierCache,
  type CcrotateTierCacheSnapshot,
} from "../services/ccrotate-tier-gate.js";

function snapshot(
  accounts: Array<{
    email: string;
    serviceTier?: string | null;
    reset5h?: number | null;
    reset7d?: number | null;
  }>,
): CcrotateTierCacheSnapshot {
  return {
    updatedAt: "2026-04-29T00:00:00.000Z",
    accounts: accounts.map((a) => ({
      email: a.email,
      status: "success",
      serviceTier: a.serviceTier ?? null,
      rateLimits:
        a.reset5h === undefined && a.reset7d === undefined
          ? null
          : {
            reset5h: a.reset5h ?? null,
            reset7d: a.reset7d ?? null,
          },
    })),
  };
}

describe("mapAdapterToCcrotateTarget", () => {
  it("maps claude_local to claude", () => {
    expect(mapAdapterToCcrotateTarget("claude_local")).toBe("claude");
  });

  it("maps codex_local to codex", () => {
    expect(mapAdapterToCcrotateTarget("codex_local")).toBe("codex");
  });

  it("returns null for adapters without a ccrotate provider", () => {
    expect(mapAdapterToCcrotateTarget("cursor")).toBeNull();
    expect(mapAdapterToCcrotateTarget("gemini_local")).toBeNull();
    expect(mapAdapterToCcrotateTarget("process")).toBeNull();
    expect(mapAdapterToCcrotateTarget("http")).toBeNull();
  });
});

describe("evaluateTierCacheSnapshot", () => {
  const now = new Date("2026-04-29T00:00:00.000Z");

  it("allows dispatch when at least one Claude account is base", () => {
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "a@x.com", serviceTier: "exhausted", reset7d: 1777651200 },
        { email: "b@x.com", serviceTier: "base" },
      ]),
      now,
    );
    expect(result.allow).toBe(true);
    expect(result.usableAccount).toBe("b@x.com");
  });

  it("allows dispatch when at least one Codex account is available", () => {
    const result = evaluateTierCacheSnapshot(
      "codex",
      snapshot([
        { email: "a@x.com", serviceTier: "exhausted", reset7d: 1777651200 },
        { email: "b@x.com", serviceTier: "available" },
      ]),
      now,
    );
    expect(result.allow).toBe(true);
    expect(result.usableAccount).toBe("b@x.com");
  });

  it("denies and reports earliest reset across 5h and 7d for Claude when no base account", () => {
    // now = 2026-04-29T00:00:00Z, epoch ~ 1777680000
    const earliest5h = 1777680000 + 600; // 10 minutes from now
    const otherReset = 1777680000 + 7200; // 2 hours from now
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "a@x.com", serviceTier: "extra", reset5h: earliest5h, reset7d: otherReset },
        { email: "b@x.com", serviceTier: "exhausted", reset7d: otherReset + 3600 },
      ]),
      now,
    );
    expect(result.allow).toBe(false);
    expect(result.resumeAt).not.toBeNull();
    expect(result.resumeAt!.getTime()).toBe(earliest5h * 1000);
  });

  it("denies with null resumeAt when no resets are present", () => {
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([{ email: "a@x.com", serviceTier: "exhausted" }]),
      now,
    );
    expect(result.allow).toBe(false);
    expect(result.resumeAt).toBeNull();
  });

  it("ignores past reset epochs when picking the earliest future one", () => {
    const nowEpoch = Math.floor(now.getTime() / 1000);
    const past = nowEpoch - 3600;
    const future = nowEpoch + 1800;
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "a@x.com", serviceTier: "extra", reset5h: past, reset7d: future },
      ]),
      now,
    );
    expect(result.allow).toBe(false);
    expect(result.resumeAt!.getTime()).toBe(future * 1000);
  });

  it("denies dispatch when snapshot has no accounts", () => {
    const result = evaluateTierCacheSnapshot("claude", snapshot([]), now);
    expect(result.allow).toBe(false);
    expect(result.resumeAt).toBeNull();
  });

  it("treats accounts with status != success as not usable", () => {
    const result = evaluateTierCacheSnapshot(
      "codex",
      {
        updatedAt: "2026-04-29T00:00:00.000Z",
        accounts: [
          {
            email: "stale@x.com",
            status: "error",
            serviceTier: null,
            rateLimits: null,
          },
        ],
      },
      now,
    );
    expect(result.allow).toBe(false);
  });
});

describe("createCcrotateTierGate", () => {
  it("allows dispatch for adapters that don't map to a ccrotate target", async () => {
    const readCache = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      cacheTtlMs: 30_000,
    });
    const result = await gate.checkAdapter({
      adapterType: "process",
      agentId: "agent-1",
      now: new Date(),
    });
    expect(result.allow).toBe(true);
    expect(readCache).not.toHaveBeenCalled();
  });

  it("dispatches when cache returns null (ccrotate not installed) and warns once", async () => {
    const readCache = vi.fn().mockResolvedValue(null);
    const warn = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn },
      cacheTtlMs: 30_000,
    });
    const r1 = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-1",
      now: new Date(),
    });
    const r2 = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-2",
      now: new Date(),
    });
    expect(r1.allow).toBe(true);
    expect(r2.allow).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("dispatches when readCache throws and warns once", async () => {
    const readCache = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const warn = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn },
      cacheTtlMs: 30_000,
    });
    const r1 = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-1",
      now: new Date(),
    });
    const r2 = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-1",
      now: new Date(),
    });
    expect(r1.allow).toBe(true);
    expect(r2.allow).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("denies dispatch when no Claude account is base and reschedules at earliest reset + 120s", async () => {
    const now = new Date("2026-04-29T00:00:00.000Z");
    const reset = Math.floor(now.getTime() / 1000) + 600;
    const readCache = vi.fn().mockResolvedValue(
      snapshot([
        { email: "a@x.com", serviceTier: "extra", reset5h: reset },
      ]),
    );
    const info = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info, warn: vi.fn() },
      cacheTtlMs: 30_000,
    });
    const r = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-1",
      now,
    });
    expect(r.allow).toBe(false);
    if (!r.allow) {
      expect(r.target).toBe("claude");
      expect(r.resumeAt).not.toBeNull();
      // Should be earliest reset + 120s grace window
      expect(r.resumeAt!.getTime()).toBe(reset * 1000 + 120_000);
      expect(r.reason).toBe("ccrotate.no_usable_account");
    }
    expect(info).toHaveBeenCalled();
  });

  it("memoizes the cache read for the configured TTL", async () => {
    const now0 = new Date("2026-04-29T00:00:00.000Z");
    const reset = Math.floor(now0.getTime() / 1000) + 600;
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "a@x.com", serviceTier: "extra", reset5h: reset }]),
    );
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      cacheTtlMs: 30_000,
    });

    // Two checks within the TTL window for two different agents
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-1",
      now: now0,
    });
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-2",
      now: new Date(now0.getTime() + 5_000),
    });
    expect(readCache).toHaveBeenCalledTimes(1);

    // After the TTL expires it should re-read
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-3",
      now: new Date(now0.getTime() + 31_000),
    });
    expect(readCache).toHaveBeenCalledTimes(2);
  });

  it("evaluates Claude and Codex independently within the same gate", async () => {
    const now = new Date("2026-04-29T00:00:00.000Z");
    const reset = Math.floor(now.getTime() / 1000) + 600;
    const readCache = vi
      .fn()
      .mockImplementation((target: "claude" | "codex") =>
        Promise.resolve(
          target === "claude"
            ? snapshot([{ email: "c@x.com", serviceTier: "extra", reset5h: reset }])
            : snapshot([{ email: "x@x.com", serviceTier: "available" }]),
        ),
      );
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      cacheTtlMs: 30_000,
    });

    const claudeResult = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-c",
      now,
    });
    const codexResult = await gate.checkAdapter({
      adapterType: "codex_local",
      agentId: "agent-x",
      now,
    });
    expect(claudeResult.allow).toBe(false);
    expect(codexResult.allow).toBe(true);
  });

  it("clears the deferral memo once a usable account reappears", async () => {
    const now0 = new Date("2026-04-29T00:00:00.000Z");
    const reset = Math.floor(now0.getTime() / 1000) + 600;
    const denySnapshot = snapshot([{ email: "a@x.com", serviceTier: "extra", reset5h: reset }]);
    const allowSnapshot = snapshot([{ email: "a@x.com", serviceTier: "base" }]);
    const readCache = vi
      .fn()
      .mockResolvedValueOnce(denySnapshot)
      .mockResolvedValueOnce(allowSnapshot);
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      cacheTtlMs: 30_000,
    });

    const denied = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: now0,
    });
    expect(denied.allow).toBe(false);

    // Past the resume window — gate should re-read the cache and now allow.
    const after = new Date(reset * 1000 + 200_000);
    const allowed = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: after,
    });
    expect(allowed.allow).toBe(true);
  });

  it("logs the deferral once per (target, agentId) until the resume time passes", async () => {
    const now0 = new Date("2026-04-29T00:00:00.000Z");
    const reset = Math.floor(now0.getTime() / 1000) + 600;
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "a@x.com", serviceTier: "extra", reset5h: reset }]),
    );
    const info = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info, warn: vi.fn() },
      cacheTtlMs: 30_000,
    });

    await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now: now0 });
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: new Date(now0.getTime() + 10_000),
    });
    expect(info).toHaveBeenCalledTimes(1);

    // Different agent should log its own deferral
    await gate.checkAdapter({ adapterType: "claude_local", agentId: "a2", now: now0 });
    expect(info).toHaveBeenCalledTimes(2);
  });
});

describe("createCcrotateTierGate switcher integration", () => {
  const now = new Date("2026-04-29T00:00:00.000Z");

  it("calls switcher with the first base-tier account on allow", async () => {
    const readCache = vi.fn().mockResolvedValue(
      snapshot([
        { email: "exhausted@x.com", serviceTier: "exhausted", reset7d: 1777651200 },
        { email: "good@x.com", serviceTier: "base" },
        { email: "alsogood@x.com", serviceTier: "base" },
      ]),
    );
    const switchTo = vi.fn().mockResolvedValue({ ok: true });
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
    });

    const r = await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    expect(r.allow).toBe(true);
    if (r.allow) expect(r.switchedTo).toEqual({ target: "claude", email: "good@x.com" });
    expect(switchTo).toHaveBeenCalledExactlyOnceWith("claude", "good@x.com");
  });

  it("does not re-spawn switch when the chosen email hasn't changed", async () => {
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "good@x.com", serviceTier: "base" }]),
    );
    const switchTo = vi.fn().mockResolvedValue({ ok: true });
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
      cacheTtlMs: 0, // force re-read each call to prove the gate, not the cache, dedupes
    });

    await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a2",
      now: new Date(now.getTime() + 60_000),
    });
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: new Date(now.getTime() + 120_000),
    });
    expect(switchTo).toHaveBeenCalledTimes(1);
  });

  it("re-spawns switch when the best base account changes", async () => {
    const readCache = vi
      .fn()
      .mockResolvedValueOnce(snapshot([{ email: "first@x.com", serviceTier: "base" }]))
      .mockResolvedValueOnce(snapshot([{ email: "second@x.com", serviceTier: "base" }]));
    const switchTo = vi.fn().mockResolvedValue({ ok: true });
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
      cacheTtlMs: 0,
    });

    await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: new Date(now.getTime() + 60_000),
    });
    expect(switchTo).toHaveBeenNthCalledWith(1, "claude", "first@x.com");
    expect(switchTo).toHaveBeenNthCalledWith(2, "claude", "second@x.com");
  });

  it("does not call switcher for adapters without a ccrotate target", async () => {
    const readCache = vi.fn();
    const switchTo = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
    });

    const r = await gate.checkAdapter({ adapterType: "process", agentId: "a1", now });
    expect(r.allow).toBe(true);
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("does not call switcher on the deny path", async () => {
    const reset = Math.floor(now.getTime() / 1000) + 600;
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "a@x.com", serviceTier: "extra", reset5h: reset }]),
    );
    const switchTo = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
    });

    const r = await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    expect(r.allow).toBe(false);
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("does not call switcher when readCache returns null (ccrotate not installed)", async () => {
    const readCache = vi.fn().mockResolvedValue(null);
    const switchTo = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
    });

    const r = await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    expect(r.allow).toBe(true);
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("warns and proceeds when switcher fails — does not deny dispatch", async () => {
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "good@x.com", serviceTier: "base" }]),
    );
    const switchTo = vi.fn().mockResolvedValue({ ok: false, error: "ccrotate not found" });
    const warn = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn },
      switcher: { switchTo },
    });

    const r = await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    expect(r.allow).toBe(true);
    expect(switchTo).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ target: "claude", email: "good@x.com" }),
      expect.stringMatching(/switch failed/i),
    );
  });

  it("retries the switch on the next call after a failure (lastSwitched not advanced)", async () => {
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "good@x.com", serviceTier: "base" }]),
    );
    const switchTo = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "transient" })
      .mockResolvedValueOnce({ ok: true });
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
      cacheTtlMs: 0,
    });

    await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: new Date(now.getTime() + 60_000),
    });
    expect(switchTo).toHaveBeenCalledTimes(2);
  });

  it("works without a switcher (preserves original behavior)", async () => {
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "good@x.com", serviceTier: "base" }]),
    );
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    const r = await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    expect(r.allow).toBe(true);
  });
});

describe("readDefaultCcrotateTierCache", () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "ccrotate-tier-gate-test-"));
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("returns null when the cache file does not exist", async () => {
    const result = await readDefaultCcrotateTierCache("claude");
    expect(result).toBeNull();
  });

  it("parses the Claude tier-cache file from disk", async () => {
    const dir = path.join(tempHome, ".ccrotate");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tier-cache.json"),
      JSON.stringify({
        updatedAt: "2026-04-29T00:00:00.000Z",
        accounts: [
          {
            email: "a@x.com",
            status: "success",
            serviceTier: "base",
            rateLimits: { reset5h: null, reset7d: 1777651200 },
          },
        ],
      }),
    );
    const snap = await readDefaultCcrotateTierCache("claude");
    expect(snap).not.toBeNull();
    expect(snap!.accounts).toHaveLength(1);
    expect(snap!.accounts[0]?.email).toBe("a@x.com");
    expect(snap!.accounts[0]?.serviceTier).toBe("base");
  });

  it("uses tier-cache.codex.json for the codex target", async () => {
    const dir = path.join(tempHome, ".ccrotate");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tier-cache.codex.json"),
      JSON.stringify({
        updatedAt: "2026-04-29T00:00:00.000Z",
        accounts: [
          {
            email: "x@x.com",
            status: "success",
            serviceTier: "available",
            rateLimits: { reset5h: 123, reset7d: 456 },
          },
        ],
      }),
    );
    const snap = await readDefaultCcrotateTierCache("codex");
    expect(snap?.accounts[0]?.email).toBe("x@x.com");
    expect(snap?.accounts[0]?.serviceTier).toBe("available");
  });
});
