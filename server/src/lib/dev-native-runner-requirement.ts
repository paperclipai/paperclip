export function nativeRunnerRequiredForDev({
  platform = process.platform,
  localRunnerSupported,
  rolloutEnabled,
  dotRolloutEnabled,
  persistedNativeRun,
}: {
  platform?: NodeJS.Platform;
  localRunnerSupported: boolean;
  rolloutEnabled: boolean;
  dotRolloutEnabled: boolean;
  persistedNativeRun: boolean;
}): boolean {
  return localRunnerSupported
    || (platform !== "win32" && (rolloutEnabled || dotRolloutEnabled))
    || persistedNativeRun;
}
