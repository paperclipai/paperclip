import { companies, type Db } from "@paperclipai/db";
import { isCloudManagedInstance } from "./cloud-instance.js";
import { getCloudRuntimeIdentity } from "./cloud-runtime-identity.js";

/** In-memory predicate. Calling it never opens a database connection. */
export type CloudWarmStandby = () => boolean;

/**
 * Call after initializeCloudRuntimeIdentity and before starting any pollers.
 * Only explicitly marked, empty, unclaimed Cloud instances may stand by.
 * A signed claim is committed before the identity getter changes, and restores
 * on boot even if the provider still carries the old warm-pool environment.
 */
export async function createCloudWarmStandby(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CloudWarmStandby> {
  const stackId = env.PAPERCLIP_CLOUD_STACK_ID?.trim();
  if (
    env.PAPERCLIP_CLOUD_WARM_STANDBY !== "1"
    || !isCloudManagedInstance(env)
    || !stackId
    || !env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS?.trim()
    || getCloudRuntimeIdentity()
  ) return () => false;

  // Protect existing tenants if an operator accidentally sets the marker.
  // Fail startup on a read error; never infer emptiness from an unavailable DB.
  const existing = await db.select({ id: companies.id }).from(companies).limit(1);
  if (existing.length > 0) return () => false;

  let standby = true;
  return () => {
    if (standby && getCloudRuntimeIdentity()?.stackId === stackId) standby = false;
    return standby;
  };
}
