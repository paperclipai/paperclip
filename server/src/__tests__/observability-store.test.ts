import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultObservabilityDbPath,
  openObservabilityStore,
} from "../services/observability-store.js";

describe("defaultObservabilityDbPath", () => {
  const originalDataHome = process.env.XDG_DATA_HOME;
  const originalOverride = process.env.PAPERCLIP_TIER_OBSERVABILITY_DB_PATH;

  afterEach(() => {
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalOverride === undefined) delete process.env.PAPERCLIP_TIER_OBSERVABILITY_DB_PATH;
    else process.env.PAPERCLIP_TIER_OBSERVABILITY_DB_PATH = originalOverride;
  });

  it("falls back to ~/.local/share/paperclip/observability.db without XDG", () => {
    delete process.env.XDG_DATA_HOME;
    delete process.env.PAPERCLIP_TIER_OBSERVABILITY_DB_PATH;
    expect(defaultObservabilityDbPath()).toBe(
      path.resolve(os.homedir(), ".local", "share", "paperclip", "observability.db"),
    );
  });

  it("honours XDG_DATA_HOME", () => {
    process.env.XDG_DATA_HOME = "/tmp/xdg-test-home";
    delete process.env.PAPERCLIP_TIER_OBSERVABILITY_DB_PATH;
    expect(defaultObservabilityDbPath()).toBe(
      "/tmp/xdg-test-home/paperclip/observability.db",
    );
  });

  it("honours PAPERCLIP_TIER_OBSERVABILITY_DB_PATH override", () => {
    process.env.PAPERCLIP_TIER_OBSERVABILITY_DB_PATH = "/tmp/x/y.db";
    expect(defaultObservabilityDbPath()).toBe("/tmp/x/y.db");
  });

  it("expands a leading ~ in the override", () => {
    process.env.PAPERCLIP_TIER_OBSERVABILITY_DB_PATH = "~/explicit.db";
    expect(defaultObservabilityDbPath()).toBe(path.resolve(os.homedir(), "explicit.db"));
  });
});

describe("openObservabilityStore (SQLite)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-obs-"));
    dbPath = path.join(tmpDir, "observability.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the database file and runs schema migrations idempotently", () => {
    const store = openObservabilityStore({ dbPath });
    expect(store.enabled).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
    store.close();

    // Reopening must not error and must preserve any rows from the prior run.
    const reopened = openObservabilityStore({ dbPath });
    expect(reopened.enabled).toBe(true);
    reopened.close();
  });

  it("records invocations and queries them back by tier + time window", () => {
    const store = openObservabilityStore({ dbPath });
    const now = new Date("2026-05-22T12:00:00Z");
    const beforeWindow = new Date("2026-05-19T12:00:00Z").toISOString();
    const sinceIso = new Date("2026-05-21T12:00:00Z").toISOString();

    // 3 Tier 0 in window, 1 Tier 1 in window, 1 Tier 0 outside window.
    for (let i = 0; i < 3; i += 1) {
      store.recordInvocation({
        recordedAt: new Date(now.getTime() - i * 1000).toISOString(),
        companyId: "co_a",
        agentId: "agent_a",
        runId: `run_${i}`,
        adapterType: "claude_local",
        tierUsed: 0,
      });
    }
    store.recordInvocation({
      recordedAt: now.toISOString(),
      companyId: "co_a",
      agentId: "agent_a",
      runId: "run_t1",
      adapterType: "claude_local",
      tierUsed: 1,
      costEstimateUsd: 0.37,
    });
    store.recordInvocation({
      recordedAt: beforeWindow,
      companyId: "co_a",
      agentId: "agent_a",
      runId: "run_old",
      adapterType: "claude_local",
      tierUsed: 0,
    });

    const mix = store.queryTierMix(sinceIso);
    expect(mix).toEqual([
      { tier: 0, count: 3 },
      { tier: 1, count: 1 },
    ]);
    expect(store.queryTier1CostSince(sinceIso)).toBeCloseTo(0.37, 4);
    store.close();
  });

  it("returns a no-op store when disabled via options", () => {
    const store = openObservabilityStore({ dbPath, enabled: false });
    expect(store.enabled).toBe(false);
    // Calls must not throw and must return empty results.
    store.recordInvocation({
      recordedAt: new Date().toISOString(),
      companyId: "c",
      agentId: "a",
      runId: "r",
      adapterType: "claude_local",
    });
    expect(store.queryTierMix(new Date().toISOString())).toEqual([]);
    expect(store.queryTier1CostSince(new Date().toISOString())).toBe(0);
  });

  it("returns a no-op store when PAPERCLIP_TIER_OBSERVABILITY_ENABLED=false", () => {
    const originalEnv = process.env.PAPERCLIP_TIER_OBSERVABILITY_ENABLED;
    process.env.PAPERCLIP_TIER_OBSERVABILITY_ENABLED = "false";
    try {
      const store = openObservabilityStore({ dbPath });
      expect(store.enabled).toBe(false);
    } finally {
      if (originalEnv === undefined) delete process.env.PAPERCLIP_TIER_OBSERVABILITY_ENABLED;
      else process.env.PAPERCLIP_TIER_OBSERVABILITY_ENABLED = originalEnv;
    }
  });

  it("survives malformed tierTransitions without corrupting the row", () => {
    const store = openObservabilityStore({ dbPath });
    store.recordInvocation({
      recordedAt: new Date("2026-05-22T12:00:00Z").toISOString(),
      companyId: "co_b",
      agentId: "agent_b",
      runId: "run_mal",
      adapterType: "claude_local",
      tierUsed: 2,
      tierTransitions: [
        { tier: 0, errorReason: "rate-limit" },
        { tier: 1, errorReason: null },
      ],
      costEstimateUsd: 0,
    });
    const mix = store.queryTierMix(new Date("2026-05-21T12:00:00Z").toISOString());
    expect(mix).toEqual([{ tier: 2, count: 1 }]);
    store.close();
  });
});
