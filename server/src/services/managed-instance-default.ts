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
 * The fill obeys the same readiness rule as an admin's default write
 * (`assertAgentsReadyForEnvironmentChange`): it declines a target that would
 * give active agents following the default a plugin that has not prepared
 * them. A managed sandbox target never needs agent setup, so this only ever
 * declines a plugin environment.
 *
 * Once filled, the default is an ordinary set value. Nothing reverts it
 * automatically; an admin can change it in instance settings.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { environments, instanceSettings } from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";
import { agentsNeedSetupForEnvironmentChange } from "./plugin-environment-driver.js";

/** Singleton key of the instance settings row that holds `defaultEnvironmentId`. */
const INSTANCE_DEFAULT_SETTINGS_KEY = "default";

export interface FillInstanceDefaultResult {
  filled: boolean;
  previousDefaultEnvironmentId: string | null;
  /** Set when the default was fillable but active agents following it need setup for the target first. */
  declined?: "agents_need_setup";
}

/**
 * Point the instance default at `environmentId` only if the current default
 * is unset, the local environment, or an environment that no longer exists,
 * and no active agent following the default would need setup for it first.
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
    const environmentRef = async (id: string) => (await tx
      .select({ driver: environments.driver, config: environments.config })
      .from(environments)
      .where(eq(environments.id, id)))[0] ?? null;
    const currentEnvironment = current === null ? null : await environmentRef(current);
    if (currentEnvironment && currentEnvironment.driver !== "local") {
      return { filled: false, previousDefaultEnvironmentId: current };
    }
    if (await agentsNeedSetupForEnvironmentChange(tx as unknown as Db, currentEnvironment, await environmentRef(environmentId),
      { inheritsDefault: true })) {
      return { filled: false, previousDefaultEnvironmentId: current, declined: "agents_need_setup" };
    }
    await settings.update({ defaultEnvironmentId: environmentId }, { db: tx });
    return { filled: true, previousDefaultEnvironmentId: current };
  });
}
