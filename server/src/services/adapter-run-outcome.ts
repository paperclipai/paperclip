export function adapterResultCompletedSuccessfully(input: {
  timedOut?: boolean | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  resultJson?: Record<string, unknown> | null;
}) {
  if (input.timedOut || input.errorMessage) return false;
  if ((input.exitCode ?? 0) === 0) return true;

  const resultJson =
    typeof input.resultJson === "object" && input.resultJson !== null && !Array.isArray(input.resultJson)
      ? input.resultJson
      : {};
  const dirtyExitCode =
    typeof resultJson.dirtyExitCode === "number" && Number.isFinite(resultJson.dirtyExitCode)
      ? resultJson.dirtyExitCode
      : Number.NaN;
  return resultJson.dirtyExit === true && dirtyExitCode === input.exitCode;
}
