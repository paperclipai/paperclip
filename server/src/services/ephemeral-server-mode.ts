/** Whether this server runs in volume-free ephemeral (multi-host) mode. A
 * leaf module so recovery code can read the mode without importing the
 * ephemeral data-eligibility checks and their dependency graph. */
export const ephemeralServerEnabled = () => process.env.PAPERCLIP_EPHEMERAL_SERVER === "true";
