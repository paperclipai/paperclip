import { notFound } from "../errors.js";

export const RESPONSIBILITIES_DISABLED_CODE = "responsibilities_disabled";

const REMEDIATION = "Areas and responsibilities are an experimental feature that is turned off on this instance. "
  + "An instance admin turns them on with Responsibilities in Experimental settings; agent credentials cannot change that setting. "
  + "This is not an empty list: tell the person the feature is off instead of saying they have no responsibilities.";

/**
 * The denial for any area or responsibility operation while the instance has
 * `enableResponsibilities` off. The code lets an agent tell "turned off" from
 * "nothing there"; the status and message stay what clients already expect.
 */
export function responsibilitiesDisabledError() {
  return notFound("Responsibilities are not enabled", { code: RESPONSIBILITIES_DISABLED_CODE, remediation: REMEDIATION });
}

export async function assertResponsibilitiesEnabled(settings: { getExperimental(): Promise<{ enableResponsibilities?: boolean }> }) {
  if ((await settings.getExperimental()).enableResponsibilities !== true) throw responsibilitiesDisabledError();
}
