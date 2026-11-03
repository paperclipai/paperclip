import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { appDefinitionText } from "./app-definition-display";
import { appCopyFor } from "@/lib/app-gallery-copy";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("exact built-in metadata lookup", () => {
  it("preserves prototype-like custom source strings and app slugs in every locale", async () => {
    const names = ["__proto__", "constructor", "toString", "hasOwnProperty"];
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      for (const slug of ["api-key-generic", "custom-app", ...names]) {
        for (const source of names) expect(appDefinitionText(slug, source)).toBe(source);
      }
      for (const slug of names) {
        expect(appDefinitionText(slug, "API key")).toBe("API key");
        expect(appCopyFor(slug, "Custom app")).toEqual({ tagline: "Custom app", short: "Custom app" });
      }
    }
  });
});
