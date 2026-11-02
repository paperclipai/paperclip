import { t } from "@/i18n";

/** Only app-authored UI errors use catalog keys; external diagnostics stay intact. */
export class LocalizedUiError extends Error {
  constructor(key: string, values: Record<string, unknown> = {}) {
    super(t(key, values));
    Object.defineProperty(this, "message", {
      configurable: true,
      get: () => t(key, values),
    });
  }
}
