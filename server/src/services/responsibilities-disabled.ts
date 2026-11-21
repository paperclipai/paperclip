import { notFound } from "../errors.js";

export const RESPONSIBILITIES_DISABLED_CODE = "responsibilities_disabled";

/**
 * What an agent is told while the feature is off: in the route's error, the
 * tools' error and the chat prompt alike.
 */
export const RESPONSIBILITIES_OFF_GUIDANCE = "Areas and responsibilities are turned off on this instance; an instance admin turns them on "
  + "with Responsibilities in Experimental settings, and agent credentials cannot change that setting. This is not an empty list: "
  + "tell the person the feature is off instead of saying they have no responsibilities, and do not look for them through other tools.";

/**
 * The denial for any area or responsibility operation while the instance has
 * `enableResponsibilities` off. The code lets an agent tell "turned off" from
 * "nothing there"; the status and message stay what clients already expect.
 */
export function responsibilitiesDisabledError() {
  return notFound("Responsibilities are not enabled", { code: RESPONSIBILITIES_DISABLED_CODE, remediation: RESPONSIBILITIES_OFF_GUIDANCE });
}
