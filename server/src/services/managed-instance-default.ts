/**
 * The managed instance default: one locked "fill if unset" write.
 *
 * On a managed instance, boot points the instance default at the managed
 * sandbox when nothing deliberate is set: the default is unset, names the
 * local environment, or names an environment that no longer exists. A set
 * default (any other environment, whoever chose it) is never changed.
 *
 * The write locks the instance default row and rechecks it inside the same
 * transaction, so two overlapping boots, or a boot overlapping an admin's
 * default write, can never overwrite a value that another transaction just
 * committed: whichever commits first wins, and the other sees a set default.
 *
 * Once filled, the default is an ordinary set value. Nothing reverts it
 * automatically; an admin can change it in instance settings.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { environments, instanceSettings } from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";

/** Singleton key of the instance settings row that holds `defaultEnvironmentId`. */
const INSTANCE_DEFAULT_SETTINGS_KEY = "default";

export interface FillInstanceDefaultResult {
  filled: boolean;
  previousDefaultEnvironmentId: string | null;
}

/**
 * Point the instance default at `environmentId` only if the current default
 * is unset, the local environment, or an environment that no longer exists.
 */
export async function fillUnsetInstanceDefault(db: Db, environmentId: string): Promise<FillInstanceDefaultResult> {
  return await db.transaction(async (tx) => {
    const settings = instanceSettingsService(tx as unknown as Db);
    // Creates the singleton row on a fresh instance, so the lock below always
    // has a row to hold.
    await settings.get();
    const [defaultRow] = await tx
      .select({ defaultEnvironmentId: instanceSettings.defaultEnvironmentId })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, INSTANCE_DEFAULT_SETTINGS_KEY))
      .for("update");
    const current = defaultRow?.defaultEnvironmentId ?? null;
    if (current === environmentId) return { filled: false, previousDefaultEnvironmentId: current };
    if (current !== null) {
      const [currentEnvironment] = await tx
        .select({ driver: environments.driver })
        .from(environments)
        .where(eq(environments.id, current));
      if (currentEnvironment && currentEnvironment.driver !== "local") {
        return { filled: false, previousDefaultEnvironmentId: current };
      }
    }
    await settings.update({ defaultEnvironmentId: environmentId }, { db: tx });
    return { filled: true, previousDefaultEnvironmentId: current };
  });
}
