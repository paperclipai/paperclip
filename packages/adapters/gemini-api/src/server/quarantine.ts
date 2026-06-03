/**
 * Disk-based per-model quarantine state.
 *
 * When a model returns a 429 / quota error it is quarantined for
 * `releaseAfterMinutes` (default 60). Subsequent requests skip it.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_RELEASE_AFTER_MINUTES = 60;
const QUARANTINE_DIR = path.join(os.homedir(), ".paperclip", "gemini-api-quarantine");

function quarantineFilePath(model: string): string {
  const safe = model.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(QUARANTINE_DIR, `${safe}.json`);
}

interface QuarantineEntry {
  model: string;
  quarantinedAt: number;
  releaseAfterMinutes: number;
  reason: string;
}

async function readEntry(model: string): Promise<QuarantineEntry | null> {
  try {
    const raw = await fs.readFile(quarantineFilePath(model), "utf8");
    const parsed = JSON.parse(raw) as QuarantineEntry;
    if (typeof parsed.quarantinedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function isModelQuarantined(
  model: string,
  nowMs?: number,
): Promise<boolean> {
  const entry = await readEntry(model);
  if (!entry) return false;
  const releaseMs =
    entry.quarantinedAt + (entry.releaseAfterMinutes ?? DEFAULT_RELEASE_AFTER_MINUTES) * 60_000;
  const now = nowMs ?? Date.now();
  if (now >= releaseMs) {
    await releaseModelQuarantine(model);
    return false;
  }
  return true;
}

export async function quarantineModel(
  model: string,
  reason: string,
  releaseAfterMinutes = DEFAULT_RELEASE_AFTER_MINUTES,
): Promise<void> {
  const entry: QuarantineEntry = {
    model,
    quarantinedAt: Date.now(),
    releaseAfterMinutes,
    reason,
  };
  await fs.mkdir(QUARANTINE_DIR, { recursive: true });
  await fs.writeFile(quarantineFilePath(model), JSON.stringify(entry, null, 2), "utf8");
}

export async function releaseModelQuarantine(model: string): Promise<void> {
  try {
    await fs.unlink(quarantineFilePath(model));
  } catch {
    // file may not exist — that's fine
  }
}

export async function getQuarantineEntry(model: string): Promise<QuarantineEntry | null> {
  return readEntry(model);
}
