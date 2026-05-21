import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GUILD_WORKER_AUTONOMY_FILE,
  GUILD_WORKER_SKILLS_FILE,
} from "../dispatch/guild-worker-env.js";
import {
  cleanupGuildRunSandbox,
  prepareGuildRunSandbox,
} from "../dispatch/guild-run-sandbox.js";

describe("prepareGuildRunSandbox + cleanupGuildRunSandbox (Plan 3 Phase E1a)", () => {
  let testTmpRoot: string;
  let bundleRoot: string;
  const createdSandboxes: string[] = [];

  beforeEach(async () => {
    testTmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "guild-sandbox-test-tmp-"));
    bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "guild-sandbox-test-bundle-"));
  });

  afterEach(async () => {
    for (const dir of createdSandboxes) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    createdSandboxes.length = 0;
    await fs.rm(testTmpRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(bundleRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("creates a sandbox with autonomy.json + available_skills.json on the happy path", async () => {
    const autonomyContents = JSON.stringify({ version: 1, guildName: "eng-guild", autonomous: ["read"] });
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), autonomyContents, "utf-8");

    const result = await prepareGuildRunSandbox({
      runId: "11111111-1111-1111-1111-111111111111",
      guildId: "ff5c34cd-b867-42d5-bc00-4e51b24367fa",
      guildSlug: "eng-guild",
      guildInstructionsRoot: bundleRoot,
      skills: [
        { id: "aaa", name: "redis-connection-pooling", body: "use max=20" },
        { id: "bbb", name: "drizzle-fk-cascade", body: "be careful" },
      ],
      tmpDirOverride: testTmpRoot,
    });
    createdSandboxes.push(result.sandboxDir);

    expect(result.sandboxDir.startsWith(testTmpRoot)).toBe(true);
    expect(path.basename(result.sandboxDir)).toMatch(/^paperclip-guild-run-11111111-1111-1111-1111-111111111111-/);
    expect(result.warnings).toEqual([]);
    expect(result.snapshotedSkillCount).toBe(2);

    // autonomy.json round-trip
    expect(result.autonomyJsonPath).toBe(path.join(result.sandboxDir, GUILD_WORKER_AUTONOMY_FILE));
    const autonomy = await fs.readFile(result.autonomyJsonPath!, "utf-8");
    expect(autonomy).toBe(autonomyContents);

    // available_skills.json shape
    expect(result.availableSkillsPath).toBe(path.join(result.sandboxDir, GUILD_WORKER_SKILLS_FILE));
    const parsed = JSON.parse(await fs.readFile(result.availableSkillsPath, "utf-8"));
    expect(parsed.guildId).toBe("ff5c34cd-b867-42d5-bc00-4e51b24367fa");
    expect(parsed.guildSlug).toBe("eng-guild");
    expect(parsed.totalCanonical).toBe(2);
    expect(parsed.skills).toEqual([
      { id: "aaa", name: "redis-connection-pooling", body: "use max=20" },
      { id: "bbb", name: "drizzle-fk-cascade", body: "be careful" },
    ]);
    // snapshotAt should be a valid ISO timestamp
    expect(() => new Date(parsed.snapshotAt).toISOString()).not.toThrow();
  });

  it("writes available_skills.json with an empty array when the snapshot is empty", async () => {
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");

    const result = await prepareGuildRunSandbox({
      runId: "22222222-2222-2222-2222-222222222222",
      guildId: "g1",
      guildSlug: "eng-guild",
      guildInstructionsRoot: bundleRoot,
      skills: [],
      tmpDirOverride: testTmpRoot,
    });
    createdSandboxes.push(result.sandboxDir);

    const parsed = JSON.parse(await fs.readFile(result.availableSkillsPath, "utf-8"));
    expect(parsed.totalCanonical).toBe(0);
    expect(parsed.skills).toEqual([]);
    expect(result.snapshotedSkillCount).toBe(0);
  });

  it("warns and continues when autonomy.json is missing from the bundle", async () => {
    // bundleRoot exists but has no autonomy.json
    const result = await prepareGuildRunSandbox({
      runId: "33333333-3333-3333-3333-333333333333",
      guildId: "g1",
      guildSlug: "eng-guild",
      guildInstructionsRoot: bundleRoot,
      skills: [],
      tmpDirOverride: testTmpRoot,
    });
    createdSandboxes.push(result.sandboxDir);

    expect(result.autonomyJsonPath).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/autonomy\.json/);
    expect(result.warnings[0]).toMatch(/failed to copy/);
    // available_skills.json still got written
    expect(await fs.readFile(result.availableSkillsPath, "utf-8")).toContain('"skills"');
  });

  it("warns and continues when autonomy.json contains invalid JSON (caught early, sandbox left without it)", async () => {
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{this is not json}", "utf-8");

    const result = await prepareGuildRunSandbox({
      runId: "44444444-4444-4444-4444-444444444444",
      guildId: "g1",
      guildSlug: "eng-guild",
      guildInstructionsRoot: bundleRoot,
      skills: [],
      tmpDirOverride: testTmpRoot,
    });
    createdSandboxes.push(result.sandboxDir);

    expect(result.autonomyJsonPath).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/autonomy\.json/);
    // Sandbox dir exists, available_skills.json got written, no copy of the invalid autonomy.json
    await expect(fs.access(path.join(result.sandboxDir, "autonomy.json"))).rejects.toThrow();
  });

  it("warns when no instructionsRootPath is configured (degraded envelope)", async () => {
    const result = await prepareGuildRunSandbox({
      runId: "55555555-5555-5555-5555-555555555555",
      guildId: "g1",
      guildSlug: "eng-guild",
      guildInstructionsRoot: null,
      skills: [],
      tmpDirOverride: testTmpRoot,
    });
    createdSandboxes.push(result.sandboxDir);

    expect(result.autonomyJsonPath).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/no instructionsRootPath configured/);
  });

  it("concurrent calls produce distinct sandbox dirs (mkdtemp uniqueness)", async () => {
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        prepareGuildRunSandbox({
          runId: `66666666-6666-6666-6666-66666666666${i}`,
          guildId: "g1",
          guildSlug: "eng-guild",
          guildInstructionsRoot: bundleRoot,
          skills: [],
          tmpDirOverride: testTmpRoot,
        }),
      ),
    );
    results.forEach((r) => createdSandboxes.push(r.sandboxDir));

    const dirs = new Set(results.map((r) => r.sandboxDir));
    expect(dirs.size).toBe(5);
  });

  it("cleanupGuildRunSandbox removes the dir end-to-end", async () => {
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");
    const result = await prepareGuildRunSandbox({
      runId: "77777777-7777-7777-7777-777777777777",
      guildId: "g1",
      guildSlug: "eng-guild",
      guildInstructionsRoot: bundleRoot,
      skills: [],
      tmpDirOverride: testTmpRoot,
    });

    const cleanup = await cleanupGuildRunSandbox(result.sandboxDir);
    expect(cleanup).toEqual({ removed: true, warning: null });
    await expect(fs.access(result.sandboxDir)).rejects.toThrow();
  });

  it("cleanupGuildRunSandbox is idempotent: removing a missing dir is not an error", async () => {
    const phantom = path.join(testTmpRoot, "definitely-does-not-exist");
    const cleanup = await cleanupGuildRunSandbox(phantom);
    // fs.rm with { force: true } returns success on ENOENT, so removed=true.
    expect(cleanup.removed).toBe(true);
    expect(cleanup.warning).toBeNull();
  });
});
