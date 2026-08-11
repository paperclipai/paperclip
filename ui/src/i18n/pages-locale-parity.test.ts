import { describe, expect, it } from "vitest";

import en from "./locales/en.json";
import { localeMessages } from "./locales";

const PAGES_SEGMENTS = [
  "auth",
  "cliAuth",
  "boardClaim",
  "joinRequestQueue",
  "companies",
  "instanceAccess",
  "instanceGeneralSettings",
  "goalDetail",
  "training",
] as const;

type PagesMessages = Record<string, Record<string, string>>;

function pagesOf(messages: unknown): PagesMessages {
  return (messages as { pages?: PagesMessages }).pages ?? {};
}

describe("auth/access/instance pages locale parity", () => {
  it("defines the page segments in English", () => {
    const enPages = en.pages as unknown as PagesMessages;
    for (const segment of PAGES_SEGMENTS) {
      expect(enPages[segment], `pages.${segment}`).toBeDefined();
      expect(Object.keys(enPages[segment]).length, `pages.${segment}`).toBeGreaterThan(0);
    }
  });

  it("keeps every locale's key set in sync with English for these segments", () => {
    const enPages = en.pages as unknown as PagesMessages;
    for (const [locale, messages] of Object.entries(localeMessages)) {
      const localePages = pagesOf(messages);
      for (const segment of PAGES_SEGMENTS) {
        const englishKeys = Object.keys(enPages[segment]).sort();
        const localeKeys = Object.keys(localePages[segment] ?? {}).sort();
        expect(localeKeys, `${locale} pages.${segment}`).toEqual(englishKeys);
      }
    }
  });
});
