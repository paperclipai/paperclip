/**
 * Plan 3 Phase E1a — per-run sandbox for a guild worker.
 *
 * The dispatch layer creates a unique directory per run whose
 * `agent.kind === 'guild'`, copies in the guild's `autonomy.json`,
 * writes the canonical-skills snapshot (`available_skills.json`), and
 * hands the path back to the dispatcher so it can:
 *
 *   1. expose the paths to the worker via the env produced by
 *      `buildGuildWorkerEnv` (sibling module);
 *   2. ingest the worker's `learnings.json` from the same directory in
 *      the Phase E2 worker-exit hook;
 *   3. clean up via `cleanupGuildRunSandbox` after ingest succeeds.
 *
 * The directory is `mkdtemp`'d under `os.tmpdir()` with the prefix
 * `paperclip-guild-run-<runId>-` so concurrent guild dispatches never
 * collide and orphans are easy to spot manually.
 *
 * Failure model:
 *
 *   - sandbox creation is fatal to the run (the dispatcher should
 *     fail-fast with `errorCode='guild_sandbox_init_failed'` so the
 *     operator sees a clean failure, not a silent fall-through).
 *   - a missing guild `autonomy.json` (e.g. operator forgot to deploy
 *     the bundle) is non-fatal: the sandbox is still created without
 *     `autonomy.json` and a warning is returned in the result so the
 *     dispatcher can log it. The worker is then on a degraded path
 *     (no envelope) but the run isn't blocked.
 *   - cleanup is best-effort and idempotent. Failing to remove an
 *     orphan dir is logged by the caller and never throws.
 *
 * See docs/superpowers/specs/2026-05-21-plan3-phase-e-worker-lifecycle.md
 * decisions D4, D6, D9.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GUILD_WORKER_AUTONOMY_FILE,
  GUILD_WORKER_SKILLS_FILE,
} from "./guild-worker-env.js";

/** Shape of a single canonical skill exposed to the worker at start of run.
 * Mirrors the subset of `skills` table columns the worker actually needs. */
export interface GuildSkillSnapshotEntry {
  id: string;
  name: string;
  body: string;
}

export interface PrepareGuildRunSandboxInput {
  runId: string;
  guildId: string;
  guildSlug: string;
  /** Path on the host where the guild's instruction bundle lives;
   * we read `<root>/autonomy.json` from here. Set per-guild in
   * `agent.adapterConfig.instructionsRootPath`. */
  guildInstructionsRoot: string | null;
  /** Snapshot of canonical, non-retired skills the dispatcher queried
   * pre-spawn (top 20 by recency per the spec). */
  skills: GuildSkillSnapshotEntry[];
  /** Optional override for the tmp-dir parent. Defaults to `os.tmpdir()`.
   * Tests pass an explicit dir; production omits. */
  tmpDirOverride?: string;
}

export interface PrepareGuildRunSandboxResult {
  /** Absolute path to the newly created sandbox directory. */
  sandboxDir: string;
  /** Absolute path to `<sandboxDir>/autonomy.json`. Null when the source
   * bundle's `autonomy.json` was not found (degraded path). */
  autonomyJsonPath: string | null;
  /** Absolute path to `<sandboxDir>/available_skills.json`. Always
   * present; empty `skills: []` if the snapshot was empty. */
  availableSkillsPath: string;
  /** Number of canonical skills written to `available_skills.json`. */
  snapshotedSkillCount: number;
  /** Warnings the dispatcher should log. Non-fatal but operator-visible. */
  warnings: string[];
}

export async function prepareGuildRunSandbox(
  input: PrepareGuildRunSandboxInput,
): Promise<PrepareGuildRunSandboxResult> {
  const warnings: string[] = [];
  const prefix = path.join(
    input.tmpDirOverride ?? os.tmpdir(),
    `paperclip-guild-run-${input.runId}-`,
  );
  const sandboxDir = await fs.mkdtemp(prefix);

  // available_skills.json — always written, even if empty.
  const skillsSnapshot = {
    guildId: input.guildId,
    guildSlug: input.guildSlug,
    snapshotAt: new Date().toISOString(),
    totalCanonical: input.skills.length,
    skills: input.skills.map((s) => ({ id: s.id, name: s.name, body: s.body })),
  };
  const availableSkillsPath = path.join(sandboxDir, GUILD_WORKER_SKILLS_FILE);
  await fs.writeFile(
    availableSkillsPath,
    JSON.stringify(skillsSnapshot, null, 2),
    "utf-8",
  );

  // autonomy.json — copied from the deployed bundle if present.
  let autonomyJsonPath: string | null = null;
  if (input.guildInstructionsRoot) {
    const source = path.join(input.guildInstructionsRoot, GUILD_WORKER_AUTONOMY_FILE);
    const target = path.join(sandboxDir, GUILD_WORKER_AUTONOMY_FILE);
    try {
      const contents = await fs.readFile(source, "utf-8");
      // Validate it parses as JSON so a corrupt bundle is caught early
      // (worker would otherwise read it and crash). The parsed value is
      // discarded; we only re-emit the original text so a worker that
      // does its own JSON-Schema validation sees the bytes the operator
      // committed.
      JSON.parse(contents);
      await fs.writeFile(target, contents, "utf-8");
      autonomyJsonPath = target;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(
        `guild_sandbox: failed to copy autonomy.json from ${source}: ${msg}`,
      );
    }
  } else {
    warnings.push(
      "guild_sandbox: no instructionsRootPath configured on the guild row; " +
        "worker will run without autonomy.json (degraded envelope).",
    );
  }

  return {
    sandboxDir,
    autonomyJsonPath,
    availableSkillsPath,
    snapshotedSkillCount: input.skills.length,
    warnings,
  };
}

/**
 * Best-effort cleanup. Idempotent: removing a non-existent dir is a
 * no-op. Any failure is swallowed and returned as a warning string so
 * the caller can decide whether to log. The hook still does its work
 * even if the dir refuses to disappear.
 */
export async function cleanupGuildRunSandbox(
  sandboxDir: string,
): Promise<{ removed: boolean; warning: string | null }> {
  try {
    await fs.rm(sandboxDir, { recursive: true, force: true });
    return { removed: true, warning: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      removed: false,
      warning: `guild_sandbox: cleanup of ${sandboxDir} failed: ${msg}`,
    };
  }
}
