import { t } from "@/i18n";

/** A local fallback remains reactive; server and provider errors remain verbatim. */
export class SettingsDisplayError extends Error {
  constructor(readonly messageKey: string) {
    super(messageKey);
    this.name = "SettingsDisplayError";
  }
}

export function settingsErrorText(error: Error | null | undefined): string | null {
  if (!error) return null;
  return error instanceof SettingsDisplayError ? t(`oct26Settings.${error.messageKey}`) : error.message;
}
