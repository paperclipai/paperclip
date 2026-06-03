import { describe, expect, it } from "vitest";
import {
  applyMigrationEnvUpdates,
  resolveMigrationEnvUpdates,
} from "../commands/run-migration-env.js";

describe("resolveMigrationEnvUpdates", () => {
  describe("default (autoMigrate=true)", () => {
    it("sets AUTO_APPLY=true when both env vars are unset", () => {
      const updates = resolveMigrationEnvUpdates({}, { autoMigrate: true });
      expect(updates).toEqual({ PAPERCLIP_MIGRATION_AUTO_APPLY: "true" });
    });

    it("treats empty-string env values as unset", () => {
      const updates = resolveMigrationEnvUpdates(
        { PAPERCLIP_MIGRATION_AUTO_APPLY: "", PAPERCLIP_MIGRATION_PROMPT: "" },
        { autoMigrate: true },
      );
      expect(updates).toEqual({ PAPERCLIP_MIGRATION_AUTO_APPLY: "true" });
    });

    it("does not override an explicit PAPERCLIP_MIGRATION_AUTO_APPLY=true", () => {
      const updates = resolveMigrationEnvUpdates(
        { PAPERCLIP_MIGRATION_AUTO_APPLY: "true" },
        { autoMigrate: true },
      );
      expect(updates).toEqual({});
    });

    it("does not override an explicit PAPERCLIP_MIGRATION_AUTO_APPLY=false", () => {
      // Honor user intent even if their value will be treated as falsy by the server.
      const updates = resolveMigrationEnvUpdates(
        { PAPERCLIP_MIGRATION_AUTO_APPLY: "false" },
        { autoMigrate: true },
      );
      expect(updates).toEqual({});
    });

    it("does not override an explicit PAPERCLIP_MIGRATION_PROMPT=never", () => {
      const updates = resolveMigrationEnvUpdates(
        { PAPERCLIP_MIGRATION_PROMPT: "never" },
        { autoMigrate: true },
      );
      expect(updates).toEqual({});
    });

    it("does not override when both env vars are set", () => {
      const updates = resolveMigrationEnvUpdates(
        {
          PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
          PAPERCLIP_MIGRATION_PROMPT: "never",
        },
        { autoMigrate: true },
      );
      expect(updates).toEqual({});
    });
  });

  describe("opt-out (autoMigrate=false)", () => {
    it("sets PROMPT=never even when env is empty", () => {
      const updates = resolveMigrationEnvUpdates({}, { autoMigrate: false });
      expect(updates).toEqual({ PAPERCLIP_MIGRATION_PROMPT: "never" });
    });

    it("forces PROMPT=never overriding existing AUTO_APPLY=true", () => {
      const updates = resolveMigrationEnvUpdates(
        { PAPERCLIP_MIGRATION_AUTO_APPLY: "true" },
        { autoMigrate: false },
      );
      // --no-auto-migrate is an explicit CLI signal, so it wins.
      expect(updates).toEqual({ PAPERCLIP_MIGRATION_PROMPT: "never" });
    });

    it("forces PROMPT=never overriding existing PROMPT=ask", () => {
      const updates = resolveMigrationEnvUpdates(
        { PAPERCLIP_MIGRATION_PROMPT: "ask" },
        { autoMigrate: false },
      );
      expect(updates).toEqual({ PAPERCLIP_MIGRATION_PROMPT: "never" });
    });
  });
});

describe("applyMigrationEnvUpdates", () => {
  it("mutates env with set keys", () => {
    const env: NodeJS.ProcessEnv = {};
    applyMigrationEnvUpdates(env, { PAPERCLIP_MIGRATION_AUTO_APPLY: "true" });
    expect(env.PAPERCLIP_MIGRATION_AUTO_APPLY).toBe("true");
    expect(env.PAPERCLIP_MIGRATION_PROMPT).toBeUndefined();
  });

  it("leaves env untouched when updates are empty", () => {
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
      PAPERCLIP_MIGRATION_PROMPT: "ask",
    };
    applyMigrationEnvUpdates(env, {});
    expect(env.PAPERCLIP_MIGRATION_AUTO_APPLY).toBe("true");
    expect(env.PAPERCLIP_MIGRATION_PROMPT).toBe("ask");
  });

  it("overwrites both keys when both are present in updates", () => {
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_MIGRATION_AUTO_APPLY: "old",
      PAPERCLIP_MIGRATION_PROMPT: "old",
    };
    applyMigrationEnvUpdates(env, {
      PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
      PAPERCLIP_MIGRATION_PROMPT: "never",
    });
    expect(env.PAPERCLIP_MIGRATION_AUTO_APPLY).toBe("true");
    expect(env.PAPERCLIP_MIGRATION_PROMPT).toBe("never");
  });
});

describe("integration: default `paperclipai run` no longer blocks on prompt", () => {
  // This is the scenario from the bug report: a fresh `npx paperclipai run`
  // with no explicit env vars should silently auto-apply migrations
  // instead of dropping into an interactive prompt that hangs the server boot.
  it("produces an env state where the server's promptApplyMigrations short-circuits to true", () => {
    const env: NodeJS.ProcessEnv = {};
    applyMigrationEnvUpdates(
      env,
      resolveMigrationEnvUpdates(env, { autoMigrate: true }),
    );
    // Mirrors server/src/index.ts:119 guard.
    expect(env.PAPERCLIP_MIGRATION_AUTO_APPLY).toBe("true");
  });

  it("produces an env state where --no-auto-migrate causes the server to refuse-to-start", () => {
    const env: NodeJS.ProcessEnv = {};
    applyMigrationEnvUpdates(
      env,
      resolveMigrationEnvUpdates(env, { autoMigrate: false }),
    );
    // Mirrors server/src/index.ts:120 guard.
    expect(env.PAPERCLIP_MIGRATION_PROMPT).toBe("never");
    expect(env.PAPERCLIP_MIGRATION_AUTO_APPLY).toBeUndefined();
  });
});
