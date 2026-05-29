import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authUsers,
  boardApiKeys,
  instanceUserRoles,
} from "@paperclipai/db";
import { hashBearerToken } from "./services/board-auth.js";

export const BOOTSTRAP_ADMIN_EMAIL_ENV = "PAPERCLIP_BOOTSTRAP_ADMIN_EMAIL";
export const BOOTSTRAP_BOARD_API_KEY_ENV = "PAPERCLIP_BOOTSTRAP_BOARD_API_KEY";
export const BOOTSTRAP_BOARD_API_KEY_NAME = "agentswarm-platform";

type BootstrapLogger = {
  info(payload: Record<string, unknown>, message: string): void;
};

const consoleBootstrapLogger: BootstrapLogger = {
  info(payload, message) {
    console.info(message, payload);
  },
};

export type FirstBootAdminBootstrapResult =
  | {
      status: "skipped";
      reason: "env_missing" | "admin_exists";
    }
  | {
      status: "seeded";
      adminEmail: string;
      userId: string;
      boardApiKeyId: string;
      keyName: typeof BOOTSTRAP_BOARD_API_KEY_NAME;
    };

function envValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function bootstrapUserId(email: string): string {
  const digest = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 32);
  return `bootstrap-admin-${digest}`;
}

function bootstrapAccountId(userId: string): string {
  return `bootstrap-admin:${userId}`;
}

export async function seedFirstBootAdminAndBoardKeyFromEnv(
  db: Db,
  opts?: {
    env?: NodeJS.ProcessEnv;
    logger?: BootstrapLogger;
  },
): Promise<FirstBootAdminBootstrapResult> {
  const env = opts?.env ?? process.env;
  const log = opts?.logger ?? consoleBootstrapLogger;
  const adminEmail = envValue(env, BOOTSTRAP_ADMIN_EMAIL_ENV);
  const boardApiKey = envValue(env, BOOTSTRAP_BOARD_API_KEY_ENV);
  const missing = [
    adminEmail ? null : BOOTSTRAP_ADMIN_EMAIL_ENV,
    boardApiKey ? null : BOOTSTRAP_BOARD_API_KEY_ENV,
  ].filter((value): value is string => Boolean(value));

  if (!adminEmail || !boardApiKey) {
    log.info({ reason: "env_missing", missing }, "paperclip.bootstrap.skip");
    return { status: "skipped", reason: "env_missing" };
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${instanceUserRoles} in share row exclusive mode`);

    const existingAdmin = await tx
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"))
      .then((rows) => rows[0] ?? null);

    if (existingAdmin) {
      return { status: "skipped" as const, reason: "admin_exists" as const };
    }

    const now = new Date();
    const userId = bootstrapUserId(adminEmail);
    const randomPassword = `pcp_bootstrap_password_${randomBytes(32).toString("hex")}`;

    await tx
      .insert(authUsers)
      .values({
        id: userId,
        name: adminEmail,
        email: adminEmail,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: authUsers.id,
      });

    await tx
      .insert(authAccounts)
      .values({
        id: bootstrapAccountId(userId),
        accountId: userId,
        providerId: "credential",
        userId,
        password: `unused:${hashBearerToken(randomPassword)}`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: authAccounts.id,
      });

    await tx.insert(instanceUserRoles).values({
      userId,
      role: "instance_admin",
      createdAt: now,
      updatedAt: now,
    });

    const createdKey = await tx
      .insert(boardApiKeys)
      .values({
        userId,
        name: BOOTSTRAP_BOARD_API_KEY_NAME,
        keyHash: hashBearerToken(boardApiKey),
        expiresAt: null,
        createdAt: now,
      })
      .returning()
      .then((rows) => rows[0]);

    if (!createdKey) {
      throw new Error("Failed to create bootstrap board API key");
    }

    return {
      status: "seeded" as const,
      adminEmail,
      userId,
      boardApiKeyId: createdKey.id,
      keyName: BOOTSTRAP_BOARD_API_KEY_NAME as typeof BOOTSTRAP_BOARD_API_KEY_NAME,
    };
  });

  if (result.status === "skipped") {
    log.info({ reason: result.reason }, "paperclip.bootstrap.skip");
    return result;
  }

  log.info(
    {
      adminEmail: result.adminEmail,
      keyName: result.keyName,
    },
    "paperclip.bootstrap.seeded",
  );
  return result;
}
