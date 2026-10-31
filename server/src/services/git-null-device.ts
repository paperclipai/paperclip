/**
 * Null device path for Git config isolation (GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, core.hooksPath).
 * Do not use os.devNull: on Windows it is `\\.\nul`, which Git for Windows rejects as a config
 * file ("unable to access '\\.\nul': Invalid argument"). Git maps `/dev/null` to the null device
 * on every platform.
 */
export const GIT_NULL_DEVICE = "/dev/null";
