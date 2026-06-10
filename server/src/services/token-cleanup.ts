import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export async function cleanupExpiredTokens(db: Db): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM refresh_tokens WHERE expires_at < now()`);
    logger.info("Cleaned up expired refresh tokens");
  } catch (err) {
    logger.warn({ err }, "Failed to cleanup expired refresh tokens");
  }

  try {
    await db.execute(sql`DELETE FROM password_reset_tokens WHERE expires_at < now()`);
    logger.info("Cleaned up expired password reset tokens");
  } catch (err) {
    logger.warn({ err }, "Failed to cleanup expired password reset tokens");
  }
}

export function scheduleTokenCleanup(
  db: Db,
  intervalMs = DEFAULT_CLEANUP_INTERVAL_MS
): ReturnType<typeof setInterval> {
  // Run immediately on startup, then on interval
  void cleanupExpiredTokens(db).catch((err) => {
    logger.error({ err }, "Initial token cleanup failed");
  });

  const interval = setInterval(() => {
    void cleanupExpiredTokens(db).catch((err) => {
      logger.error({ err }, "Periodic token cleanup failed");
    });
  }, intervalMs);

  return interval;
}
