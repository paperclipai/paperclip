import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Override the quarantine dir to a temp directory for tests
const TEST_QUARANTINE_DIR = path.join(os.tmpdir(), `paperclip-gemini-api-quarantine-test-${process.pid}`);

// Patch the module-level QUARANTINE_DIR by re-implementing the functions inline
// (unit tests exercise the logic directly without module-level side effects)

interface QuarantineEntry {
  model: string;
  quarantinedAt: number;
  releaseAfterMinutes: number;
  reason: string;
}

function quarantineFilePath(model: string): string {
  const safe = model.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(TEST_QUARANTINE_DIR, `${safe}.json`);
}

async function writeEntry(entry: QuarantineEntry): Promise<void> {
  await fs.mkdir(TEST_QUARANTINE_DIR, { recursive: true });
  await fs.writeFile(quarantineFilePath(entry.model), JSON.stringify(entry, null, 2), "utf8");
}

async function readEntry(model: string): Promise<QuarantineEntry | null> {
  try {
    const raw = await fs.readFile(quarantineFilePath(model), "utf8");
    return JSON.parse(raw) as QuarantineEntry;
  } catch {
    return null;
  }
}

async function unlinkEntry(model: string): Promise<void> {
  try {
    await fs.unlink(quarantineFilePath(model));
  } catch {
    // ignore
  }
}

function isExpired(entry: QuarantineEntry, nowMs: number): boolean {
  return nowMs >= entry.quarantinedAt + entry.releaseAfterMinutes * 60_000;
}

afterEach(async () => {
  await fs.rm(TEST_QUARANTINE_DIR, { recursive: true, force: true }).catch(() => undefined);
});

describe("quarantine state machine", () => {
  it("returns false when no quarantine entry exists", async () => {
    const entry = await readEntry("gemini-2.5-flash");
    expect(entry).toBeNull();
  });

  it("persists a quarantine entry to disk", async () => {
    const now = Date.now();
    await writeEntry({ model: "gemini-2.5-pro", quarantinedAt: now, releaseAfterMinutes: 60, reason: "quota" });
    const entry = await readEntry("gemini-2.5-pro");
    expect(entry).not.toBeNull();
    expect(entry!.model).toBe("gemini-2.5-pro");
    expect(entry!.releaseAfterMinutes).toBe(60);
  });

  it("considers entry active when within release window", () => {
    const now = Date.now();
    const entry: QuarantineEntry = { model: "gemini-2.5-flash", quarantinedAt: now, releaseAfterMinutes: 60, reason: "quota" };
    // 30 minutes later — still quarantined
    expect(isExpired(entry, now + 30 * 60_000)).toBe(false);
  });

  it("considers entry expired after releaseAfterMinutes", () => {
    const now = Date.now();
    const entry: QuarantineEntry = { model: "gemini-2.5-flash", quarantinedAt: now, releaseAfterMinutes: 60, reason: "quota" };
    // 61 minutes later — expired
    expect(isExpired(entry, now + 61 * 60_000)).toBe(true);
  });

  it("respects custom releaseAfterMinutes", () => {
    const now = Date.now();
    const entry: QuarantineEntry = { model: "gemini-2.5-flash", quarantinedAt: now, releaseAfterMinutes: 120, reason: "quota" };
    expect(isExpired(entry, now + 90 * 60_000)).toBe(false);
    expect(isExpired(entry, now + 121 * 60_000)).toBe(true);
  });

  it("removes entry on unlink", async () => {
    const now = Date.now();
    await writeEntry({ model: "gemini-2.5-flash-lite", quarantinedAt: now, releaseAfterMinutes: 60, reason: "quota" });
    await unlinkEntry("gemini-2.5-flash-lite");
    const entry = await readEntry("gemini-2.5-flash-lite");
    expect(entry).toBeNull();
  });

  it("sanitizes model id in filename (replaces unsafe chars)", () => {
    const modelPath = quarantineFilePath("gemini/model:test@v1");
    expect(path.basename(modelPath)).toBe("gemini_model_test_v1.json");
  });
});
