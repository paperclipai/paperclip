import { and, eq } from "drizzle-orm";
import { authUsers, authAccounts, instanceUserRoles } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "./middleware/logger.js";

/**
 * Seeds the first instance admin from PAPERCLIP_ADMIN_EMAIL / PAPERCLIP_ADMIN_PASSWORD
 * env vars. No-ops when vars are absent or an admin already exists. Intended for
 * headless/Docker/CI deployments that cannot use browser-based onboarding.
 */
export async function ensureEnvAdminUser(db: Db): Promise<void> {
  const email = process.env.PAPERCLIP_ADMIN_EMAIL?.trim();
  const password = process.env.PAPERCLIP_ADMIN_PASSWORD;
  if (!email || !password) return;

  const existingAdmin = await db
    .select({ userId: instanceUserRoles.userId })
    .from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, "instance_admin"))
    .then((rows) => rows[0] ?? null);

  if (existingAdmin) {
    logger.info("PAPERCLIP_ADMIN_EMAIL set but instance admin already exists — skipping seed");
    return;
  }

  const { hashPassword } = await import("better-auth/crypto");
  const now = new Date();

  const existingUser = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, email))
    .then((rows) => rows[0] ?? null);

  const userId: string = existingUser?.id ?? crypto.randomUUID();

  if (!existingUser) {
    await db.insert(authUsers).values({
      id: userId,
      name: email.split("@")[0],
      email,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const hashedPassword = await hashPassword(password);

  const existingAccount = await db
    .select({ id: authAccounts.id })
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "credential")))
    .then((rows) => rows[0] ?? null);

  if (!existingAccount) {
    await db.insert(authAccounts).values({
      id: crypto.randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: hashedPassword,
      createdAt: now,
      updatedAt: now,
    });
  }

  await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });

  logger.info({ email }, "Seeded instance admin from PAPERCLIP_ADMIN_EMAIL/PAPERCLIP_ADMIN_PASSWORD");
}
