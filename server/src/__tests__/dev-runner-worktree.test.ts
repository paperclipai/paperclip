import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapDevRunnerWorktreeEnv,
  isWorktreeSeedPending,
  isLinkedGitWorktreeCheckout,
  resolveWorktreeEnvFilePath,
} from "../dev-runner-worktree.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

describe("dev-runner worktree env bootstrap", () => {
  it("guards seed-pending worktrees until a seed-complete marker exists", () => {
    const root = createTempRoot("paperclip-dev-runner-seed-pending-");
    fs.mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    fs.writeFileSync(path.join(root, ".paperclip", "seed-pending"), "{}\n", "utf8");

    expect(isWorktreeSeedPending(root)).toBe(true);

    fs.writeFileSync(path.join(root, ".paperclip", "seed-complete"), "{}\n", "utf8");
    expect(isWorktreeSeedPending(root)).toBe(false);
  });

  it("guards every manifest state except a complete verified manifest", () => {
    const root = createTempRoot("paperclip-dev-runner-seed-manifest-");
    const manifestPath = path.join(root, ".paperclip", "seed-manifest.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, state: "failed" }), "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);

    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, state: "verified" }), "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);

    fs.writeFileSync(manifestPath, JSON.stringify({
      version: 2,
      source: { instanceId: "source", configPath: "/source/config.json" },
      snapshotAt: "2026-08-18T00:00:00.000Z",
      seedMode: "minimal",
      migrationRevision: "0001",
      targetInstanceId: "target",
      phase: "complete",
      state: "verified",
      attemptId: "attempt",
      startedAt: "2026-08-18T00:00:00.000Z",
      finishedAt: "2026-08-18T00:01:00.000Z",
      diagnostics: [{ phase: "complete", status: "succeeded", at: "2026-08-18T00:01:00.000Z" }],
    }), "utf8");
    expect(isWorktreeSeedPending(root)).toBe(false);

    fs.writeFileSync(manifestPath, "not-json", "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);
  });

  it("detects linked git worktrees from .git files", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");

    expect(isLinkedGitWorktreeCheckout(root)).toBe(true);
  });

  it("loads repo-local Paperclip env for initialized worktrees without overriding explicit env", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-env-");
    fs.mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      [
        "PAPERCLIP_HOME=/tmp/paperclip-worktrees",
        "PAPERCLIP_INSTANCE_ID=feature-worktree",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=feature-worktree",
        "PAPERCLIP_OPTIONAL= # comment-only value",
        "",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_INSTANCE_ID: "already-set",
    };
    const result = bootstrapDevRunnerWorktreeEnv(root, env);

    expect(result).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: false,
    });
    expect(env.PAPERCLIP_HOME).toBe("/tmp/paperclip-worktrees");
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("already-set");
    expect(env.PAPERCLIP_IN_WORKTREE).toBe("true");
    expect(env.PAPERCLIP_OPTIONAL).toBe("");
  });

  it("repairs stale migrated config paths before loading worktree env", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-migrated-env-");
    const localConfigPath = path.join(root, ".paperclip", "config.json");
    const worktreesDir = path.join(root, ".paperclip-worktrees");
    fs.mkdirSync(path.dirname(localConfigPath), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");
    fs.writeFileSync(localConfigPath, "{}\n", "utf8");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      [
        "PAPERCLIP_HOME=/old/home/.paperclip-worktrees",
        "PAPERCLIP_INSTANCE_ID=feature-worktree",
        "PAPERCLIP_CONFIG=/old/home/paperclip/.paperclip/worktrees/feature/.paperclip/config.json",
        "PAPERCLIP_CONTEXT=/old/home/.paperclip-worktrees/context.json",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=feature-worktree",
        "",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_WORKTREES_DIR: worktreesDir,
    };
    const result = bootstrapDevRunnerWorktreeEnv(root, env);

    expect(result).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: false,
    });
    expect(env.PAPERCLIP_HOME).toBe(worktreesDir);
    expect(env.PAPERCLIP_CONFIG).toBe(localConfigPath);
    expect(env.PAPERCLIP_CONTEXT).toBe(path.join(worktreesDir, "context.json"));
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("feature-worktree");
  });

  it("reports uninitialized linked worktrees so dev runner can fail fast", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-missing-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");

    expect(bootstrapDevRunnerWorktreeEnv(root, {})).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: true,
    });
  });

  it("applies a primary checkout's pinned env so spawned children inherit it", () => {
    // Without this the child processes fall back to os.homedir() and build a
    // second, empty Paperclip home alongside the real one.
    const root = createTempRoot("paperclip-dev-runner-primary-");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    fs.writeFileSync(path.join(root, ".paperclip", "config.json"), "{}\n", "utf8");
    const pinnedHome = path.join(root, "pinned-home");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      `PAPERCLIP_HOME=${pinnedHome}\n`,
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {};
    const result = bootstrapDevRunnerWorktreeEnv(root, env);

    expect(isLinkedGitWorktreeCheckout(root)).toBe(false);
    expect(result).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: false,
    });
    expect(env.PAPERCLIP_HOME).toBe(pinnedHome);
  });

  it("lets an explicit environment variable win over a primary checkout's pin", () => {
    const root = createTempRoot("paperclip-dev-runner-primary-override-");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    fs.writeFileSync(path.join(root, ".paperclip", "config.json"), "{}\n", "utf8");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      `PAPERCLIP_HOME=${path.join(root, "pinned-home")}\n`,
      "utf8",
    );

    const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: path.join(root, "explicit-home") };
    bootstrapDevRunnerWorktreeEnv(root, env);

    expect(env.PAPERCLIP_HOME).toBe(path.join(root, "explicit-home"));
  });

  it("ignores a primary checkout's orphaned env file", () => {
    // A .env with no config.json beside it is debris: left behind when a
    // worktree's instance was removed, or carried along when a worktree
    // directory was copied into a clone. Applying it would point every spawned
    // child at an instance that no longer exists.
    const root = createTempRoot("paperclip-dev-runner-primary-orphan-");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      `PAPERCLIP_HOME=${path.join(root, "removed-instance")}\n`,
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {};
    expect(bootstrapDevRunnerWorktreeEnv(root, env)).toEqual({
      envPath: null,
      missingEnv: false,
    });
    expect(env.PAPERCLIP_HOME).toBeUndefined();
  });

  it("leaves a primary checkout without a pin untouched", () => {
    const root = createTempRoot("paperclip-dev-runner-primary-unpinned-");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });

    const env: NodeJS.ProcessEnv = {};
    expect(bootstrapDevRunnerWorktreeEnv(root, env)).toEqual({
      envPath: null,
      missingEnv: false,
    });
    expect(env.PAPERCLIP_HOME).toBeUndefined();
  });
});
