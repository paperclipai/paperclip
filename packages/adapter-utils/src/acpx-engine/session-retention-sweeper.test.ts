import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepCodexSessionRetention } from "./session-retention-sweeper.js";

describe("Codex session-retention lifecycle sweeper", () => {
  let companyDir: string;
  const nowMs = Date.parse("2026-09-17T12:00:00.000Z");

  beforeEach(async () => {
    companyDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-retention-sweeper-"));
  });

  afterEach(async () => {
    await fs.rm(companyDir, { recursive: true, force: true });
  });

  async function addRetention(runId: string, ageDays: number, bytes = 32): Promise<string> {
    const retainedRunDir = path.join(
      companyDir,
      "acp-engine",
      "agents",
      "agent-1",
      "codex-session-retention",
      runId,
    );
    await fs.mkdir(path.join(retainedRunDir, "sessions"), { recursive: true });
    await fs.writeFile(path.join(retainedRunDir, "sessions", "session.jsonl"), Buffer.alloc(bytes, 0x61));
    await fs.writeFile(path.join(retainedRunDir, "retention-complete.json"), "{}\n", "utf8");
    const retainedAt = new Date(nowMs - ageDays * 24 * 60 * 60 * 1000);
    await fs.utimes(retainedRunDir, retainedAt, retainedAt);
    return retainedRunDir;
  }

  it("produces an auditable TTL dry run without deleting retained transcripts", async () => {
    const retainedRunDir = await addRetention("run-expired", 31);
    const result = await sweepCodexSessionRetention({ companyDir, dryRun: true, nowMs });

    expect(result.policy).toEqual({ retentionDays: 30, maxRunsPerAgent: 1_000, maxBytesPerAgent: 1024 ** 3 });
    expect(result).toMatchObject({ scanned: 1, eligible: 1, deleted: 0, errors: 0 });
    expect(result.entries[0]).toMatchObject({
      runId: "run-expired",
      expiredByTtl: true,
      eligible: true,
    });
    expect(result.entries[0]?.deleted).toBeUndefined();
    await expect(fs.stat(retainedRunDir)).resolves.toBeDefined();
  });

  it("keeps retained proof and its marker while the corresponding raw home exists", async () => {
    const retainedRunDir = await addRetention("run-raw-present", 60);
    const runHomesRoot = path.join(companyDir, "acp-engine", "agents", "agent-1", "codex-run-homes");
    await fs.mkdir(path.join(runHomesRoot, "run-raw-present", "home"), { recursive: true });
    await fs.writeFile(path.join(runHomesRoot, "run-raw-present.quarantine"), "{}\n", "utf8");

    const result = await sweepCodexSessionRetention({
      companyDir,
      dryRun: false,
      operatorApproved: true,
      nowMs,
    });

    expect(result.entries[0]).toMatchObject({
      eligible: false,
      rawRunHomePresent: true,
      quarantineMarkerPresent: true,
      wouldDeleteQuarantineMarker: false,
      ineligibleReason: "raw run home still exists; retained proof must be preserved",
    });
    await expect(fs.stat(retainedRunDir)).resolves.toBeDefined();
    await expect(fs.stat(path.join(runHomesRoot, "run-raw-present.quarantine"))).resolves.toBeDefined();
  });

  it("requires an explicit operator gate and removes a stale marker with approved cleanup", async () => {
    const retainedRunDir = await addRetention("run-approved-delete", 60);
    const marker = path.join(
      companyDir,
      "acp-engine",
      "agents",
      "agent-1",
      "codex-run-homes",
      "run-approved-delete.quarantine",
    );
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, "{}\n", "utf8");

    await expect(sweepCodexSessionRetention({ companyDir, dryRun: false, nowMs })).rejects.toThrow(
      "requires explicit operator approval",
    );

    const result = await sweepCodexSessionRetention({
      companyDir,
      dryRun: false,
      operatorApproved: true,
      nowMs,
    });
    expect(result.entries[0]).toMatchObject({
      eligible: true,
      deleted: true,
      quarantineMarkerPresent: true,
      wouldDeleteQuarantineMarker: true,
      quarantineMarkerDeleted: true,
    });
    await expect(fs.stat(retainedRunDir)).rejects.toThrow();
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it("marks oldest retained runs when count and byte caps are exceeded", async () => {
    await addRetention("run-oldest", 3, 80);
    await addRetention("run-middle", 2, 80);
    await addRetention("run-newest", 1, 80);

    const result = await sweepCodexSessionRetention({
      companyDir,
      dryRun: true,
      nowMs,
      retentionDays: 30,
      maxRunsPerAgent: 2,
      maxBytesPerAgent: 180,
    });
    const oldest = result.entries.find((entry) => entry.runId === "run-oldest");
    expect(oldest).toMatchObject({ expiredByCountCap: true, expiredByByteCap: true, eligible: true });
    expect(result.entries.find((entry) => entry.runId === "run-newest")?.eligible).toBe(false);
  });

  it("continues cap eviction past a protected raw-home counterpart", async () => {
    await addRetention("run-oldest-protected", 3, 80);
    await addRetention("run-middle", 2, 80);
    await addRetention("run-newest", 1, 80);
    await fs.mkdir(path.join(
      companyDir,
      "acp-engine",
      "agents",
      "agent-1",
      "codex-run-homes",
      "run-oldest-protected",
      "home",
    ), { recursive: true });

    const result = await sweepCodexSessionRetention({
      companyDir,
      dryRun: true,
      nowMs,
      retentionDays: 30,
      maxRunsPerAgent: 2,
      maxBytesPerAgent: 180,
    });

    expect(result.entries.find((entry) => entry.runId === "run-oldest-protected")).toMatchObject({
      expiredByCountCap: true,
      expiredByByteCap: true,
      eligible: false,
      rawRunHomePresent: true,
    });
    expect(result.entries.find((entry) => entry.runId === "run-middle")).toMatchObject({
      expiredByCountCap: true,
      expiredByByteCap: true,
      eligible: true,
    });
    expect(result.entries.find((entry) => entry.runId === "run-newest")?.eligible).toBe(false);
    expect(result.runsStillOverCap).toBe(0);
    expect(result.bytesStillOverCap).toBe(0);
  });

  it("reports the residual cap excess when protected counterparts alone exceed policy", async () => {
    for (let index = 0; index < 5; index += 1) {
      const runId = `run-${index}`;
      await addRetention(runId, 5 - index, 1_000);
      if (index < 3) {
        await fs.mkdir(path.join(
          companyDir,
          "acp-engine",
          "agents",
          "agent-1",
          "codex-run-homes",
          runId,
          "home",
        ), { recursive: true });
      }
    }

    const result = await sweepCodexSessionRetention({
      companyDir,
      dryRun: true,
      nowMs,
      retentionDays: 30,
      maxRunsPerAgent: 2,
      maxBytesPerAgent: 1_500,
    });

    expect(result.entries.filter((entry) => entry.eligible).map((entry) => entry.runId).sort()).toEqual([
      "run-3",
      "run-4",
    ]);
    expect(result.runsStillOverCap).toBe(1);
    expect(result.bytesStillOverCap).toBeGreaterThanOrEqual(1_500);
    expect(result.entries.every((entry) => entry.expiredByCountCap || entry.expiredByByteCap)).toBe(true);
  });

  it("fails closed on a quarantine-marker path that is not a real file", async () => {
    const retainedRunDir = await addRetention("run-invalid-marker", 60);
    const marker = path.join(
      companyDir,
      "acp-engine",
      "agents",
      "agent-1",
      "codex-run-homes",
      "run-invalid-marker.quarantine",
    );
    await fs.mkdir(marker, { recursive: true });

    const result = await sweepCodexSessionRetention({
      companyDir,
      dryRun: false,
      operatorApproved: true,
      nowMs,
    });

    expect(result.entries[0]).toMatchObject({
      eligible: false,
      quarantineMarkerPresent: false,
      quarantineMarkerInvalid: true,
      wouldDeleteQuarantineMarker: false,
      ineligibleReason: "quarantine marker path is not a real file",
    });
    expect(result.inspectionFailures).toBe(1);
    expect(result.errors).toBe(1);
    await expect(fs.stat(retainedRunDir)).resolves.toBeDefined();
    await expect(fs.stat(marker)).resolves.toBeDefined();
  });
});
