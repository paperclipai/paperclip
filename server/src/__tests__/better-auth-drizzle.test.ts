import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyPendingMigrations,
  authAccounts,
  authUsers,
  createDb,
  ensurePostgresDatabase,
} from "@paperclipai/db";
import detectPort from "detect-port";
import { eq } from "drizzle-orm";
import EmbeddedPostgres from "embedded-postgres";
import { describe, expect, it } from "vitest";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const TEMP_PREFIX = path.join(tmpdir(), "paperclip-f004-");

describe("Better Auth Drizzle compatibility", () => {
  it(
    "round-trips an email user and account through the production adapter",
    async () => {
      const dataDir = await mkdtemp(TEMP_PREFIX);
      const port = await detectPort(55432);
      const embedded = new EmbeddedPostgres({
        databaseDir: dataDir,
        user: "paperclip",
        password: "paperclip",
        port,
        persistent: false,
        initdbFlags: ["--encoding=UTF8", "--locale=C"],
        onLog: () => {},
        onError: () => {},
      });
      let db: ReturnType<typeof createDb> | undefined;
      const originalSecret = process.env.BETTER_AUTH_SECRET;

      try {
        await embedded.initialise();
        await embedded.start();

        const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
        await ensurePostgresDatabase(adminUrl, "paperclip");
        const url = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
        await applyPendingMigrations(url);
        db = createDb(url);

        process.env.BETTER_AUTH_SECRET = "paperclip-f004-test-secret-at-least-32-characters";
        const auth = createBetterAuthInstance(
          db,
          {
            authBaseUrlMode: "explicit",
            authPublicBaseUrl: "http://127.0.0.1",
            deploymentMode: "authenticated",
            allowedHostnames: [],
            authDisableSignUp: false,
          } as Config,
          [],
        );
        const email = `f004-${randomUUID()}@example.invalid`;
        const result = await auth.api.signUpEmail({
          body: { name: "F-004 Canary", email, password: "correct-horse-battery-staple" },
        });

        expect(result.user.email).toBe(email);
        const users = await db.select().from(authUsers).where(eq(authUsers.id, result.user.id));
        const accounts = await db
          .select()
          .from(authAccounts)
          .where(eq(authAccounts.userId, result.user.id));
        expect(users).toHaveLength(1);
        expect(accounts).toHaveLength(1);
      } finally {
        if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
        else process.env.BETTER_AUTH_SECRET = originalSecret;
        try {
          if (db) await db.$client.end();
        } finally {
          try {
            await embedded.stop();
          } finally {
            if (!dataDir.startsWith(TEMP_PREFIX)) throw new Error("Refusing unsafe test cleanup");
            await rm(dataDir, { recursive: true, force: true });
          }
        }
      }
    },
    120_000,
  );
});
