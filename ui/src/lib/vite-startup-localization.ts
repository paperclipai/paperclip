import type { Plugin } from "vite";
import { localeMessages } from "../i18n/locales";

const MARKER = "/* PAPERCLIP_STARTUP_LOCALES */ {}";
const fields = ["startupFailedTitle", "startupFailedMessage", "startupReload", "startupSlowTitle", "startupSlowMessage"] as const;

/** Inline only the recovery copy: it must survive a failed application bundle. */
export function embedStartupLocales(html: string, catalogs: Record<string, unknown> = localeMessages): string {
  if (!html.includes(MARKER)) return html;
  const messages = Object.fromEntries(Object.entries(catalogs).map(([locale, catalog]) => {
    const group = (catalog as { sep28Core?: Record<string, unknown> }).sep28Core;
    return [locale, Object.fromEntries(fields.map((key) => {
      const value = group?.[key];
      if (typeof value !== "string" || !value) throw new Error(`Missing startup translation: ${locale}.${key}`);
      return [key, value];
    }))];
  }));
  // A translated string must never terminate the inline script or become HTML.
  const json = JSON.stringify(messages).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return html.replace(MARKER, () => json);
}

export function startupLocalizationPlugin(): Plugin {
  return {
    name: "paperclip-startup-localization",
    transformIndexHtml: { order: "pre", handler: (html) => embedStartupLocales(html) },
  };
}
