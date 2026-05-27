const DEFAULT_APP_DISPLAY_NAME = "Brabrix Agent";
const APP_NAME_META_NAME = "paperclip-app-name";

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readMetaAppName(): string | null {
  if (typeof document === "undefined") return null;
  const value = document.querySelector(`meta[name="${APP_NAME_META_NAME}"]`)?.getAttribute("content");
  return nonEmpty(value);
}

function readEnvAppName(): string | null {
  return nonEmpty(import.meta.env.VITE_PUBLIC_APP_NAME);
}

export function getAppDisplayName(): string {
  return readMetaAppName() ?? readEnvAppName() ?? DEFAULT_APP_DISPLAY_NAME;
}

export const APP_DISPLAY_NAME = getAppDisplayName();
