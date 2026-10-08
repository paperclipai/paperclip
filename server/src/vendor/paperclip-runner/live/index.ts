/** Source shim; server build replaces it with the runner's compiled live tree. */
type RunnerLiveModule = typeof import("@paperclipai/paperclip-runner/live");
const sourceUrl = new URL(
  "../../../../../packages/paperclip-runner/src/live/index.ts",
  import.meta.url,
);
const runner = (await import(sourceUrl.href)) as RunnerLiveModule;

export const probeCopilotMetadata = runner.probeCopilotMetadata;
export const validateCopilotMetadata = runner.validateCopilotMetadata;
export const probeAcpxClaudeInstallation = runner.probeAcpxClaudeInstallation;
export const probeAcpxGrokInstallation = runner.probeAcpxGrokInstallation;
export const probeAcpxCursorInstallation = runner.probeAcpxCursorInstallation;
