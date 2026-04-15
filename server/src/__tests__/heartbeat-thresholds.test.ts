/**
 * Pins the graduated orphan-detection threshold values in heartbeat.ts.
 *
 * The constants are not exported, so we verify them by reading the source and
 * parsing the simple "multiplier * base" arithmetic expressions. This acts as a
 * regression guard: if someone changes the values they must also update these
 * assertions.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HEARTBEAT_SOURCE = path.resolve(
  import.meta.dirname,
  "../services/heartbeat.ts",
);

/** Parse "A * B" numeric literals (with optional numeric separators) into a number. */
function parseMultiplication(expr: string): number {
  const cleaned = expr.trim().replaceAll("_", "");
  const parts = cleaned.split("*").map((p) => Number(p.trim()));
  if (parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Cannot parse numeric expression: ${expr}`);
  }
  return parts.reduce((acc, n) => acc * n, 1);
}

function extractThreshold(src: string, name: string): number {
  const match = src.match(
    new RegExp(`const\\s+${name}\\s*=\\s*([\\d_*\\s]+);`),
  );
  if (!match) throw new Error(`${name} declaration not found in heartbeat.ts`);
  return parseMultiplication(match[1]);
}

describe("heartbeat graduated thresholds (source pins)", () => {
  it("HEARTBEAT_WARN_THRESHOLD_MS is 60 000 ms (2x 30s interval)", async () => {
    const src = await fs.readFile(HEARTBEAT_SOURCE, "utf8");
    const value = extractThreshold(src, "HEARTBEAT_WARN_THRESHOLD_MS");
    expect(value).toBe(60_000);
  });

  it("HEARTBEAT_STUCK_THRESHOLD_MS is 150 000 ms (5x 30s interval)", async () => {
    const src = await fs.readFile(HEARTBEAT_SOURCE, "utf8");
    const value = extractThreshold(src, "HEARTBEAT_STUCK_THRESHOLD_MS");
    expect(value).toBe(150_000);
  });

  it("HEARTBEAT_ORPHANED_THRESHOLD_MS is 300 000 ms (10x 30s interval)", async () => {
    const src = await fs.readFile(HEARTBEAT_SOURCE, "utf8");
    const value = extractThreshold(src, "HEARTBEAT_ORPHANED_THRESHOLD_MS");
    expect(value).toBe(300_000);
  });

  it("WARN < STUCK < ORPHANED (graduated ordering)", async () => {
    const src = await fs.readFile(HEARTBEAT_SOURCE, "utf8");
    const warn = extractThreshold(src, "HEARTBEAT_WARN_THRESHOLD_MS");
    const stuck = extractThreshold(src, "HEARTBEAT_STUCK_THRESHOLD_MS");
    const orphaned = extractThreshold(src, "HEARTBEAT_ORPHANED_THRESHOLD_MS");
    expect(warn).toBeLessThan(stuck);
    expect(stuck).toBeLessThan(orphaned);
  });

  it("all three thresholds are referenced in the reaper logic", async () => {
    const src = await fs.readFile(HEARTBEAT_SOURCE, "utf8");
    expect(src).toContain("staleMs > HEARTBEAT_ORPHANED_THRESHOLD_MS");
    expect(src).toContain("staleMs > HEARTBEAT_STUCK_THRESHOLD_MS");
    expect(src).toContain("staleMs > HEARTBEAT_WARN_THRESHOLD_MS");
  });
});
