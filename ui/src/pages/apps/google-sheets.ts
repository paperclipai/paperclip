export function parseGoogleSheetIds(value: string): { ids: string[]; invalidCount: number } {
  const ids: string[] = [];
  let invalidCount = 0;
  for (const rawToken of value.split(/[\s,]+/g)) {
    const token = rawToken.trim().replace(/[),.;\]]+$/g, "");
    if (!token) continue;
    try {
      const parsed = new URL(token);
      const match = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/i);
      if (match?.[1]) {
        ids.push(decodeURIComponent(match[1]));
        continue;
      }
      invalidCount += 1;
    } catch {
      invalidCount += 1;
    }
  }
  return { ids: Array.from(new Set(ids)), invalidCount };
}

export function googleSheetsConfigWithAllowlist(
  currentConfig: Record<string, unknown> | null | undefined,
  allowedSpreadsheetIds: string[],
): Record<string, unknown> {
  const env = currentConfig && typeof currentConfig.env === "object" && !Array.isArray(currentConfig.env)
    ? currentConfig.env as Record<string, unknown>
    : {};
  return {
    ...(currentConfig ?? {}),
    allowedSpreadsheetIds,
    env: {
      ...env,
      GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS: allowedSpreadsheetIds.join(","),
    },
  };
}
