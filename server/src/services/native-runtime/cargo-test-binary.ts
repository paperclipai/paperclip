import { isAbsolute, resolve } from "node:path";

/** Resolve Cargo integration-test binaries under the target directory used by
 * the matching runner workspace build.
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
  return resolve(targetDirectory, profile, `${binaryName}${process.platform === "win32" ? ".exe" : ""}`);
}

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
