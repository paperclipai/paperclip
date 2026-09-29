import { isAbsolute, resolve } from "node:path";

/** Resolve a Cargo-built test fixture without depending on the shared default
 * target directory. Relative CARGO_TARGET_DIR values are relative to Cargo's
 * workspace (the runner crate workspace), matching Cargo's build invocation.
 */
export function resolveRunnerCargoTestBinary(
  runnerWorkspace: string,
  profile: "debug" | "release",
  binaryName: string,
): string {
  const configuredTarget = process.env.CARGO_TARGET_DIR;
  const targetDirectory = configuredTarget
    ? isAbsolute(configuredTarget)
      ? configuredTarget
      : resolve(runnerWorkspace, configuredTarget)
    : resolve(runnerWorkspace, "target");
  const executable = `${binaryName}${process.platform === "win32" ? ".exe" : ""}`;
  return resolve(targetDirectory, profile, executable);
}

/** Preserve existing staged/default resolution when no isolated Cargo target
 * is configured, while honoring CARGO_TARGET_DIR for fixture runs.
 */
export function resolveRunnerCargoTestBinaryOrDefault(
  runnerWorkspace: string,
  profile: "debug" | "release",
  binaryName: string,
  defaultBinary: () => string,
): string {
  return process.env.CARGO_TARGET_DIR
    ? resolveRunnerCargoTestBinary(runnerWorkspace, profile, binaryName)
    : defaultBinary();
}
