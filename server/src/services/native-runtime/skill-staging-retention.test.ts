import { chmod, lstat, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sweepAbandonedSkillStaging } from "./skill-staging-retention.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 18, 12);
const roots: string[] = [];

async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await makeWritable(join(path, name));
  } else await chmod(path, 0o600);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

const exists = (path: string) => lstat(path).then(() => true, () => false);

/** A partly copied, partly sealed staging tree, as an interrupted launch leaves it. */
async function staging(home: string, name: string, age: number) {
  const path = join(home, `.paperclip-skills-staging-${name}`);
  await mkdir(join(path, "skill"), { recursive: true });
  await writeFile(join(path, "skill", "SKILL.md"), "x".repeat(1000));
  await chmod(join(path, "skill", "SKILL.md"), 0o444);
  await chmod(join(path, "skill"), 0o555);
  const at = new Date(NOW - age);
  await utimes(path, at, at);
  return path;
}

describe("abandoned skill staging retention", () => {
  it("removes old staging in Codex and ACPX session homes and keeps recent staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-skill-staging-"));
    roots.push(root);
    const durable = join(root, "durable-sessions");
    const acpx = join(root, "acpx", "acpx");
    const codexOld = await staging(join(durable, "a".repeat(64), "codex-home"), "old", 2 * DAY);
    const claudeOld = await staging(join(acpx, "session-1", "claude-home"), "old", 3 * DAY);
    const claudeRecent = await staging(join(acpx, "session-1", "claude-home"), "recent", 2 * 60 * 60 * 1000);
    await mkdir(join(acpx, "session-1", "claude-home", "skills"));
    await writeFile(join(acpx, "paperclip-turn-dispatch.jsonl"), "");

    const result = await sweepAbandonedSkillStaging({ sessionRoots: [durable, acpx], now: NOW });

    expect(result).toEqual({ removed: 2, candidates: 2, bytes: 2000, nextDueAt: NOW - 2 * 60 * 60 * 1000 + DAY, truncated: false, skipped: 0 });
    expect(await exists(codexOld)).toBe(false);
    expect(await exists(claudeOld)).toBe(false);
    expect(await exists(claudeRecent)).toBe(true);
    expect(await exists(join(acpx, "session-1", "claude-home", "skills"))).toBe(true);
  });

  it("only reports in a dry run and tolerates missing roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-skill-staging-"));
    roots.push(root);
    const durable = join(root, "durable-sessions");
    const old = await staging(join(durable, "b".repeat(64), "codex-home"), "old", 2 * DAY);
    const result = await sweepAbandonedSkillStaging({
      sessionRoots: [durable, join(root, "missing")], now: NOW, dryRun: true,
    });
    expect(result).toEqual({ removed: 0, candidates: 1, bytes: 1000, nextDueAt: null, truncated: false, skipped: 0 });
    expect(await exists(old)).toBe(true);
  });

  it("stops at its removal budget and when asked to stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-skill-staging-"));
    roots.push(root);
    const durable = join(root, "durable-sessions");
    const first = await staging(join(durable, "c".repeat(64), "codex-home"), "one", 2 * DAY);
    const second = await staging(join(durable, "d".repeat(64), "codex-home"), "two", 2 * DAY);
    await expect(sweepAbandonedSkillStaging({ sessionRoots: [durable], now: NOW, maxRemovals: 1 }))
      .resolves.toMatchObject({ removed: 1, truncated: true });
    expect([await exists(first), await exists(second)].filter(Boolean)).toHaveLength(1);
    await expect(sweepAbandonedSkillStaging({ sessionRoots: [durable], now: NOW, shouldContinue: () => false }))
      .resolves.toMatchObject({ removed: 0, truncated: true });
  });

  it("looks only in the provider homes the runner owns", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-skill-staging-"));
    roots.push(root);
    const acpx = join(root, "acpx", "acpx");
    const workspace = await staging(join(acpx, "session-1", "workspace"), "old", 2 * DAY);
    const claude = await staging(join(acpx, "session-1", "claude-home"), "old", 2 * DAY);
    const result = await sweepAbandonedSkillStaging({ sessionRoots: [acpx], now: NOW });
    expect(result).toMatchObject({ removed: 1 });
    expect(await exists(workspace)).toBe(true);
    expect(await exists(claude)).toBe(false);
  });
});
