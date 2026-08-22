const RUN_ERROR_CODE_LABELS: Record<string, string> = {
  process_lost: "Run interrupted by control-plane restart",
};

export function getRunErrorCodeLabel(errorCode: string | null | undefined): string | null {
  if (!errorCode) return null;
  return RUN_ERROR_CODE_LABELS[errorCode] ?? null;
}

export function formatRunErrorCode(errorCode: string | null | undefined): string | null {
  if (!errorCode) return null;
  const label = getRunErrorCodeLabel(errorCode);
  return label ? `${label} (${errorCode})` : errorCode;
}
