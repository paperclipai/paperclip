import { chmod, lstat, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sweepCodexSkillHomes, sweepSharedSkillStorage } from "./codex-skill-home-retention.js";

const HOUR = 60 * 60 * 1000;
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

const digest = (character: string) => character.repeat(64);
const exists = (path: string) => lstat(path).then(() => true, () => false);
const at = async (path: string, time: number) => utimes(path, time / 1000, time / 1000);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-skill-home-retention-"));
  roots.push(root);
  const storeRoot = join(root, "skill-homes");
  const sessionsRoot = join(root, "durable-sessions");
  await mkdir(storeRoot, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  return { root, storeRoot, sessionsRoot };
}

/** A sealed home as the runner publishes it, last used at `lastUsed`. */
async function home(storeRoot: string, id: string, lastUsed: number | null) {
  const path = join(storeRoot, id);
  await mkdir(join(path, ".agents", "skills", "alpha"), { recursive: true });
  await writeFile(join(path, ".agents", "skills", "alpha", "SKILL.md"), "x".repeat(4096));
  await writeFile(join(path, "manifest.json"), "{}");
  await chmod(join(path, ".agents", "skills", "alpha", "SKILL.md"), 0o444);
  for (const directory of [join(path, ".agents", "skills", "alpha"), join(path, ".agents", "skills"), join(path, ".agents")]) {
    await chmod(directory, 0o555);
  }
  await chmod(path, 0o555);
  if (lastUsed === null) await at(path, NOW - 48 * HOUR);
  else {
    await writeFile(join(storeRoot, `${id}.last-used`), "");
    await at(join(storeRoot, `${id}.last-used`), lastUsed);
  }
  return path;
}

async function reference(sessionsRoot: string, scope: string, id: string) {
  const codexHome = join(sessionsRoot, scope, "codex-home");
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "paperclip-skill-home.json"),
    JSON.stringify({ schema: "paperclip.codex-skill-home-ref.v1", digest: id }));
}

describe("Codex skill home retention", () => {
  it("keeps a home that a session still references", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    const path = await home(storeRoot, digest("a"), NOW - 72 * HOUR);
    await reference(sessionsRoot, digest("1"), digest("a"));
    const result = await sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW });
    expect(result).toMatchObject({ removed: 0, kept: 1 });
    expect(await exists(path)).toBe(true);
  });

  it("keeps homes that only an ACPX Claude session or an OpenCode session references", async () => {
    const { root, storeRoot, sessionsRoot } = await fixture();
    const acpxSessionsRoot = join(root, "acpx", "acpx");
    const claudeHome = await home(storeRoot, digest("a"), NOW - 72 * HOUR);
    const openCodeHome = await home(storeRoot, digest("b"), NOW - 72 * HOUR);
    await mkdir(join(acpxSessionsRoot, "session-1", "claude-home"), { recursive: true });
    await writeFile(join(acpxSessionsRoot, "session-1", "claude-home", "paperclip-skill-home.json"),
      JSON.stringify({ schema: "paperclip.codex-skill-home-ref.v1", digest: digest("a") }));
    await mkdir(join(sessionsRoot, digest("1"), "opencode", "session-dir"), { recursive: true });
    await writeFile(join(sessionsRoot, digest("1"), "opencode", "session-dir", "paperclip-skill-home.json"),
      JSON.stringify({ schema: "paperclip.codex-skill-home-ref.v1", digest: digest("b") }));
    const result = await sweepCodexSkillHomes({ storeRoot, sessionsRoot, acpxSessionsRoot, now: NOW });
    expect(result).toMatchObject({ removed: 0, kept: 2 });
    expect(await exists(claudeHome)).toBe(true);
    expect(await exists(openCodeHome)).toBe(true);
  });

  it("keeps an unreferenced home used within the grace period", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    const path = await home(storeRoot, digest("a"), NOW - 2 * HOUR);
    const result = await sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW });
    expect(result).toMatchObject({ removed: 0, kept: 1 });
    expect(await exists(path)).toBe(true);
  });

  it("removes an unreferenced, expired home and its last-used file", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    const path = await home(storeRoot, digest("a"), NOW - 25 * HOUR);
    await writeFile(join(storeRoot, `${digest("a")}.stat.json`), "{}");
    const result = await sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW });
    expect(result.removed).toBe(1);
    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(4096);
    expect(await exists(path)).toBe(false);
    expect(await exists(join(storeRoot, `${digest("a")}.last-used`))).toBe(false);
    expect(await exists(join(storeRoot, `${digest("a")}.stat.json`))).toBe(false);
  });

  it("uses the home's own time when it has no last-used file", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    const path = await home(storeRoot, digest("a"), null);
    await expect(sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW })).resolves.toMatchObject({ removed: 1 });
    expect(await exists(path)).toBe(false);
  });

  it("releases a home when its session's codex-home expires", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    const path = await home(storeRoot, digest("a"), NOW - 72 * HOUR);
    await reference(sessionsRoot, digest("1"), digest("a"));
    await rm(join(sessionsRoot, digest("1"), "codex-home"), { recursive: true });
    await expect(sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW })).resolves.toMatchObject({ removed: 1 });
    expect(await exists(path)).toBe(false);
  });

  it("restores a home that a launch references while it is being retired", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    const path = await home(storeRoot, digest("a"), NOW - 72 * HOUR);
    const result = await sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW }, {
      afterRetire: async () => reference(sessionsRoot, digest("2"), digest("a")),
    });
    expect(result).toMatchObject({ removed: 0, kept: 1 });
    expect(await exists(join(path, ".agents", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect((await readdir(storeRoot)).filter((name) => name.startsWith(".retiring-"))).toEqual([]);
  });

  it("restores a retiring home reserved by a legacy recovery before it has a marker", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    const id = digest("b");
    const path = await home(storeRoot, id, NOW - 72 * HOUR);
    const result = await sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW }, {
      afterRetire: async () => at(join(storeRoot, `${id}.last-used`), NOW),
    });
    expect(result).toMatchObject({ removed: 0, kept: 1, nextDueAt: NOW + 24 * HOUR });
    expect(await exists(join(path, ".agents", "skills", "alpha", "SKILL.md"))).toBe(true);
  });

  it("removes stale staging and retiring leftovers and old quarantine entries", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    for (const name of [".staging-old", ".retiring-old"]) {
      await mkdir(join(storeRoot, name, "inner"), { recursive: true });
      await chmod(join(storeRoot, name, "inner"), 0o555);
      await at(join(storeRoot, name), NOW - 25 * HOUR);
    }
    await mkdir(join(storeRoot, ".staging-fresh"));
    await at(join(storeRoot, ".staging-fresh"), NOW - HOUR);
    await mkdir(join(storeRoot, "quarantine", "recent"), { recursive: true });
    await mkdir(join(storeRoot, "quarantine", "old"), { recursive: true });
    await at(join(storeRoot, "quarantine", "recent"), NOW - 2 * 24 * HOUR);
    await at(join(storeRoot, "quarantine", "old"), NOW - 8 * 24 * HOUR);
    await sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW });
    expect((await readdir(storeRoot)).sort()).toEqual([".staging-fresh", "quarantine"]);
    expect(await readdir(join(storeRoot, "quarantine"))).toEqual(["recent"]);
  });

  it("removes nothing in a dry run", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    const path = await home(storeRoot, digest("a"), NOW - 72 * HOUR);
    const result = await sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW, dryRun: true });
    expect(result).toMatchObject({ removed: 0, candidates: 1 });
    expect(await exists(path)).toBe(true);
  });

  it("stops at the removal limit", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    for (const id of ["a", "b", "c"]) await home(storeRoot, digest(id), NOW - 72 * HOUR);
    await expect(sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW, maxRemovals: 2 }))
      .resolves.toMatchObject({ removed: 2 });
    expect((await readdir(storeRoot)).filter((name) => /^[a-f0-9]{64}$/.test(name))).toHaveLength(1);
  });

  it("does nothing when the store does not exist", async () => {
    const { root, sessionsRoot } = await fixture();
    await expect(sweepCodexSkillHomes({ storeRoot: join(root, "missing"), sessionsRoot, now: NOW }))
      .resolves.toEqual({ removed: 0, reclaimedBytes: 0, kept: 0, candidates: 0, nextDueAt: null, truncated: false });
  });

  it("asks to come back when an unreferenced home's grace period ends", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    await home(storeRoot, digest("a"), NOW - 2 * HOUR);
    await home(storeRoot, digest("b"), NOW - 5 * HOUR);
    await expect(sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW }))
      .resolves.toMatchObject({ nextDueAt: NOW - 5 * HOUR + 24 * HOUR, truncated: false });
  });

  it("schedules nothing for homes that sessions still reference", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    await home(storeRoot, digest("a"), NOW - 72 * HOUR);
    await reference(sessionsRoot, digest("1"), digest("a"));
    await expect(sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW }))
      .resolves.toMatchObject({ nextDueAt: null, truncated: false });
  });

  it("reports unfinished work at the removal limit", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    for (const id of ["a", "b"]) await home(storeRoot, digest(id), NOW - 72 * HOUR);
    await expect(sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW, maxRemovals: 1 }))
      .resolves.toMatchObject({ removed: 1, truncated: true });
  });

  it("removes nothing once it is asked to stop", async () => {
    const { storeRoot, sessionsRoot } = await fixture();
    const path = await home(storeRoot, digest("a"), NOW - 72 * HOUR);
    await expect(sweepCodexSkillHomes({ storeRoot, sessionsRoot, now: NOW, shouldContinue: () => false }))
      .resolves.toMatchObject({ removed: 0, truncated: true });
    expect(await exists(path)).toBe(true);
  });
});

describe("shared skill storage sweep", () => {
  it("finds Claude references in the ACPX sessions root it is given, apart from the state base", async () => {
    const { root, storeRoot, sessionsRoot } = await fixture();
    const acpxSessionsRoot = join(root, "instance", "runtime", "paperclip-runner", "acpx", "acpx");
    const path = await home(storeRoot, digest("a"), NOW - 72 * HOUR);
    await mkdir(join(acpxSessionsRoot, "session-1", "claude-home"), { recursive: true });
    await writeFile(join(acpxSessionsRoot, "session-1", "claude-home", "paperclip-skill-home.json"),
      JSON.stringify({ schema: "paperclip.codex-skill-home-ref.v1", digest: digest("a") }));
    const result = await sweepSharedSkillStorage({
      stateBase: sessionsRoot, stateBaseOverridden: false, acpxSessionsRoot,
      now: NOW, dryRun: false, maxRemovals: 50, shouldContinue: () => true,
    });
    expect(result.skillHomesRemoved).toBe(0);
    expect(await exists(path)).toBe(true);
  });

  it("schedules no pass when there is nothing to clean up", async () => {
    const { root, sessionsRoot } = await fixture();
    const result = await sweepSharedSkillStorage({
      stateBase: sessionsRoot, stateBaseOverridden: false, acpxSessionsRoot: join(root, "acpx", "acpx"),
      now: NOW, dryRun: false, maxRemovals: 50, shouldContinue: () => true,
    });
    expect(result).toMatchObject({ failed: 0, nextDueAt: null });
  });

  it("retries in an hour when a sweep fails", async () => {
    const { root, sessionsRoot } = await fixture();
    const unreadableStore = join(root, "store-is-a-file");
    await writeFile(unreadableStore, "");
    const result = await sweepSharedSkillStorage({
      stateBase: sessionsRoot, stateBaseOverridden: false, acpxSessionsRoot: join(root, "acpx", "acpx"),
      skillHomeStoreRoot: unreadableStore, skillStagingRoots: [],
      now: NOW, dryRun: false, maxRemovals: 50, shouldContinue: () => true,
    });
    expect(result).toMatchObject({ failed: 1, nextDueAt: NOW + HOUR });
  });

  it("comes back at once when its removal budget runs out", async () => {
    const { root, storeRoot, sessionsRoot } = await fixture();
    for (const id of ["a", "b"]) await home(storeRoot, digest(id), NOW - 72 * HOUR);
    const result = await sweepSharedSkillStorage({
      stateBase: sessionsRoot, stateBaseOverridden: false, acpxSessionsRoot: join(root, "acpx", "acpx"),
      now: NOW, dryRun: false, maxRemovals: 1, shouldContinue: () => true,
    });
    expect(result).toMatchObject({ skillHomesRemoved: 1, nextDueAt: NOW });
  });
});
