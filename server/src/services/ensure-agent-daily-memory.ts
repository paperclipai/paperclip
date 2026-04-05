import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

function formatLocalYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dailyNoteStub(ymd: string): string {
  return `# ${ymd}

## Today's Plan

_(None yet.)_

## Timeline

_(Add entries as you work.)_
`;
}

/**
 * Ensures `memory/YYYY-MM-DD.md` exists under a concrete agent home directory (local calendar date).
 * Idempotent: does not overwrite an existing file. Aligns managed HEARTBEAT.md "read today's note" with disk.
 */
export async function ensureDailyMemoryNoteUnderAgentHome(
  agentHome: string,
  now: Date = new Date(),
): Promise<void> {
  await fs.mkdir(agentHome, { recursive: true });
  const memoryDir = path.join(agentHome, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const ymd = formatLocalYmd(now);
  const filePath = path.join(memoryDir, `${ymd}.md`);
  const stat = await fs.lstat(filePath).catch(() => null);
  if (stat?.isFile()) return;
  if (stat?.isDirectory()) {
    await fs.rm(filePath, { recursive: true, force: true });
  }
  await fs.writeFile(filePath, dailyNoteStub(ymd), "utf8");
}

export async function ensureAgentHomeDailyMemoryNote(agentId: string, now: Date = new Date()): Promise<void> {
  const home = resolveDefaultAgentWorkspaceDir(agentId);
  await ensureDailyMemoryNoteUnderAgentHome(home, now);
}
