export interface PaperclipExternalConfig {
  apiUrl: string;
  /** Optional baked fallback bearer; used only when no inbound bearer is present. */
  apiKey: string | null;
  /** Optional default company UUID for company-scoped tools. */
  companyId: string | null;
  publicUrl?: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export function readConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): PaperclipExternalConfig {
  const apiUrl = nonEmpty(env.PAPERCLIP_API_URL);
  if (!apiUrl) {
    throw new Error("Missing PAPERCLIP_API_URL");
  }
  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiKey: nonEmpty(env.PAPERCLIP_API_KEY),
    companyId: nonEmpty(env.PAPERCLIP_COMPANY_ID),
    publicUrl: nonEmpty(env.PAPERCLIP_PUBLIC_URL),
  };
}
