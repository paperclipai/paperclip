/**
 * Tests for the orphan run-home sweeper (KEWL-3852).
 *
 * Covers:
 *   AC2a — dry-run produces an auditable manifest without deleting
 *   AC2b — real-delete removes eligible homes
 *   AC2c — active/ambiguous run homes are excluded (no retention, no quarantine)
 *   AC2d — homes within the grace window are excluded
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepRunHomes } from "./run-home-sweeper.js";

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sweeper-test-"));
}

const terminalAndClosedDeps = {
  checkOpenHandles: async () => ({ ok: true as const, hasOpenHandles: false }),
  getRunStatus: async () => ({ ok: true as const, status: "succeeded" }),
};

async function sweep(
  opts: { companyDir: string; dryRun: boolean; graceHours: number },
  deps: NonNullable<Parameters<typeof sweepRunHomes>[1]> = terminalAndClosedDeps,
) {
  return sweepRunHomes(
    {
      ...opts,
      paperclipApiBase: "http://paperclip.test",
      paperclipApiKey: "test-key",
    },
    deps,
  );
}

/**
 * Build a minimal company-dir fixture:
 *   <companyDir>/acp-engine/agents/<agentId>/codex-run-homes/<runId>/home/
 *   <companyDir>/acp-engine/agents/<agentId>/codex-session-retention/<runId>/  (optional)
 *
 * The mtime of the run-home dir is backdated by `ageHours` hours.
 */
async function buildRunHome(opts: {
  companyDir: string;
  agentId: string;
  runId: string;
  ageHours: number;
  withRetained?: boolean;
  withQuarantine?: boolean;
}): Promise<{ runHomeDir: string; retentionDir: string }> {
  const agentDir = path.join(opts.companyDir, "acp-engine", "agents", opts.agentId);
  const runHomeParent = path.join(agentDir, "codex-run-homes", opts.runId);
  const runHomeDir = path.join(runHomeParent, "home");

  await fs.mkdir(runHomeDir, { recursive: true });
  await fs.writeFile(path.join(runHomeDir, "sessions"), "dummy", "utf8");

  // Backdate mtime by ageHours
  const now = Date.now();
  const mtime = new Date(now - opts.ageHours * 60 * 60 * 1000);
  await fs.utimes(runHomeDir, mtime, mtime);
  await fs.utimes(runHomeParent, mtime, mtime);

  const retentionDir = path.join(agentDir, "codex-session-retention", opts.runId);

  if (opts.withRetained) {
    await fs.mkdir(retentionDir, { recursive: true });
    await fs.writeFile(path.join(retentionDir, "sessions.jsonl"), "", "utf8");
  }

  if (opts.withQuarantine) {
    await fs.writeFile(path.join(path.dirname(runHomeParent), `${opts.runId}.quarantine`), "", "utf8");
  }

  return { runHomeDir, retentionDir };
}

describe("run-home sweeper", () => {
  let companyDir: string;

  beforeEach(async () => {
    companyDir = await makeTempRoot();
  });

  afterEach(async () => {
    await fs.rm(companyDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("dry-run mode (AC2a)", () => {
    it("produces a JSON manifest listing eligible homes without deleting anything", async () => {
      const { runHomeDir } = await buildRunHome({
        companyDir,
        agentId: "agent-1",
        runId: "run-old-1",
        ageHours: 26,
        withRetained: true,
      });

      const result = await sweep({
        companyDir,
        dryRun: true,
        graceHours: 24,
      });

      expect(result.scanned).toBeGreaterThanOrEqual(1);
      expect(result.eligible).toBeGreaterThanOrEqual(1);
      // Dry run: nothing deleted
      expect(result.deleted).toBe(0);
      expect(result.errors).toBe(0);

      // The run-home directory must still exist (dry-run must not delete)
      const stat = await fs.stat(runHomeDir).catch(() => null);
      expect(stat).not.toBeNull();

      // Manifest has an entry for our run
      const entry = result.entries.find((e) => e.runId === "run-old-1");
      expect(entry).toBeDefined();
      expect(entry!.eligible).toBe(true);
      expect(entry!.deleted).toBeUndefined();
    });

    it("marks ineligible homes in the manifest with a reason", async () => {
      // Home within grace window (only 1 hour old)
      await buildRunHome({
        companyDir,
        agentId: "agent-1",
        runId: "run-fresh",
        ageHours: 1,
        withRetained: true,
      });

      const result = await sweep({
        companyDir,
        dryRun: true,
        graceHours: 24,
      });

      const entry = result.entries.find((e) => e.runId === "run-fresh");
      expect(entry).toBeDefined();
      expect(entry!.eligible).toBe(false);
      expect(entry!.ineligibleReason).toMatch(/grace/i);
    });
  });

  describe("real-delete mode (AC2b)", () => {
    it("deletes eligible run homes and reports bytes reclaimed", async () => {
      const { runHomeDir } = await buildRunHome({
        companyDir,
        agentId: "agent-1",
        runId: "run-old-2",
        ageHours: 30,
        withRetained: true,
      });

      const result = await sweep({
        companyDir,
        dryRun: false,
        graceHours: 24,
      });

      expect(result.eligible).toBeGreaterThanOrEqual(1);
      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(result.errors).toBe(0);

      // The run-home must be gone
      const stat = await fs.stat(runHomeDir).catch(() => null);
      expect(stat).toBeNull();

      const entry = result.entries.find((e) => e.runId === "run-old-2");
      expect(entry!.deleted).toBe(true);
    });

    it("accepts a quarantine marker in lieu of a retained session (QUARANTINE path)", async () => {
      const { runHomeDir } = await buildRunHome({
        companyDir,
        agentId: "agent-1",
        runId: "run-quarantined",
        ageHours: 30,
        withQuarantine: true, // no retained dir, but QUARANTINE marker present
      });

      const result = await sweep({
        companyDir,
        dryRun: false,
        graceHours: 24,
      });

      const entry = result.entries.find((e) => e.runId === "run-quarantined");
      expect(entry).toBeDefined();
      expect(entry!.eligible).toBe(true);
      expect(entry!.deleted).toBe(true);
      const stat = await fs.stat(runHomeDir).catch(() => null);
      expect(stat).toBeNull();
      await expect(
        fs.stat(path.join(path.dirname(path.dirname(runHomeDir)), "run-quarantined.quarantine")),
      ).rejects.toThrow();
    });
  });

  describe("active/ambiguous home exclusion (AC2c)", () => {
    it("excludes a run home that has no retained session and no QUARANTINE marker", async () => {
      const { runHomeDir } = await buildRunHome({
        companyDir,
        agentId: "agent-1",
        runId: "run-no-retention",
        ageHours: 48,
        // no withRetained, no withQuarantine
      });

      const result = await sweep({
        companyDir,
        dryRun: false,
        graceHours: 24,
      });

      const entry = result.entries.find((e) => e.runId === "run-no-retention");
      expect(entry).toBeDefined();
      expect(entry!.eligible).toBe(false);
      expect(entry!.ineligibleReason).toMatch(/retained|QUARANTINE/i);

      // Must not be deleted
      const stat = await fs.stat(runHomeDir).catch(() => null);
      expect(stat).not.toBeNull();
    });
  });

  describe("grace window exclusion (AC2d)", () => {
    it("excludes a home whose mtime is within the grace window", async () => {
      const { runHomeDir } = await buildRunHome({
        companyDir,
        agentId: "agent-1",
        runId: "run-recent",
        ageHours: 2, // well within 24h grace
        withRetained: true,
      });

      const result = await sweep({
        companyDir,
        dryRun: false,
        graceHours: 24,
      });

      const entry = result.entries.find((e) => e.runId === "run-recent");
      expect(entry).toBeDefined();
      expect(entry!.eligible).toBe(false);
      expect(entry!.ineligibleReason).toMatch(/grace/i);

      // Must not be deleted
      const stat = await fs.stat(runHomeDir).catch(() => null);
      expect(stat).not.toBeNull();
    });
  });

  describe("multi-agent scanning", () => {
    it("scans all agent subdirectories and returns combined results", async () => {
      await buildRunHome({ companyDir, agentId: "agent-a", runId: "run-1", ageHours: 30, withRetained: true });
      await buildRunHome({ companyDir, agentId: "agent-b", runId: "run-2", ageHours: 30, withRetained: true });
      // One ineligible (fresh)
      await buildRunHome({ companyDir, agentId: "agent-a", runId: "run-3", ageHours: 1, withRetained: true });

      const result = await sweep({ companyDir, dryRun: true, graceHours: 24 });

      expect(result.scanned).toBe(3);
      expect(result.eligible).toBe(2);
      expect(result.deleted).toBe(0); // dry-run
    });
  });

  describe("fail-closed deletion proof", () => {
    it("rejects deletion when Paperclip API configuration is absent", async () => {
      const { runHomeDir } = await buildRunHome({
        companyDir,
        agentId: "agent-1",
        runId: "run-no-api",
        ageHours: 30,
        withRetained: true,
      });

      const result = await sweepRunHomes({ companyDir, dryRun: false, graceHours: 24 });

      expect(result.eligible).toBe(0);
      expect(result.entries[0]?.ineligibleReason).toMatch(/API URL and key are required/i);
      await expect(fs.stat(runHomeDir)).resolves.toBeDefined();
    });

    it("rejects deletion when terminal status cannot be verified", async () => {
      const { runHomeDir } = await buildRunHome({
        companyDir,
        agentId: "agent-1",
        runId: "run-status-error",
        ageHours: 30,
        withRetained: true,
      });

      const result = await sweep(
        { companyDir, dryRun: false, graceHours: 24 },
        {
          ...terminalAndClosedDeps,
          getRunStatus: async () => ({ ok: false as const, error: "HTTP 503" }),
        },
      );

      expect(result.eligible).toBe(0);
      expect(result.entries[0]?.ineligibleReason).toMatch(/could not be verified.*503/i);
      await expect(fs.stat(runHomeDir)).resolves.toBeDefined();
    });

    it("rejects deletion when the run is not terminal", async () => {
      const { runHomeDir } = await buildRunHome({
        companyDir,
        agentId: "agent-1",
        runId: "run-active",
        ageHours: 30,
        withRetained: true,
      });

      const result = await sweep(
        { companyDir, dryRun: false, graceHours: 24 },
        {
          ...terminalAndClosedDeps,
          getRunStatus: async () => ({ ok: true as const, status: "running" }),
        },
      );

      expect(result.eligible).toBe(0);
      expect(result.entries[0]?.ineligibleReason).toMatch(/non-terminal/i);
      await expect(fs.stat(runHomeDir)).resolves.toBeDefined();
    });

    it("rejects deletion when the open-handle check fails", async () => {
      const { runHomeDir } = await buildRunHome({
        companyDir,
        agentId: "agent-1",
        runId: "run-lsof-error",
        ageHours: 30,
        withRetained: true,
      });

      const result = await sweep(
        { companyDir, dryRun: false, graceHours: 24 },
        {
          ...terminalAndClosedDeps,
          checkOpenHandles: async () => ({ ok: false as const, error: "lsof unavailable" }),
        },
      );

      expect(result.eligible).toBe(0);
      expect(result.entries[0]?.ineligibleReason).toMatch(/open-handle check failed.*lsof unavailable/i);
      await expect(fs.stat(runHomeDir)).resolves.toBeDefined();
    });
  });
});
