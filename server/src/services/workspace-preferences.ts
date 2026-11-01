import { eq } from "drizzle-orm";
import { userWorkspacePreferences, type Db } from "@paperclipai/db";
import type { WorkspacePreference } from "@paperclipai/shared";
import { persistActivity, publishActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

export function workspacePreferenceService(db: Db) {
  async function get(userId: string): Promise<WorkspacePreference> {
    const row = await db.query.userWorkspacePreferences.findFirst({
      where: eq(userWorkspacePreferences.userId, userId),
    });
    return {
      userId,
      coordinatorWorkspaceEnabled: row?.coordinatorWorkspaceEnabled ?? false,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }
  return {
    get,
    async set(companyId: string, userId: string, enabled: boolean): Promise<WorkspacePreference> {
      const result = await db.transaction(async tx => {
        const txDb = tx as unknown as Db;
        await tx.insert(userWorkspacePreferences).values({ userId, coordinatorWorkspaceEnabled: enabled })
          .onConflictDoUpdate({
            target: userWorkspacePreferences.userId,
            set: { coordinatorWorkspaceEnabled: enabled, updatedAt: new Date() },
          });
        const { publication } = await persistActivity(txDb, {
          companyId, actorType: "user", actorId: userId,
          action: "workspace_preferences.updated", entityType: "user_preference", entityId: userId,
        });
        return { preference: await workspacePreferenceService(txDb).get(userId), publication };
      });
      // Persistence and its audit are already committed. A live-event failure
      // must not report that the saved personal preference was rolled back.
      try { publishActivity(result.publication); }
      catch (error) { logger.warn({ err: error }, "Could not publish workspace preference update"); }
      return result.preference;
    },
  };
}
