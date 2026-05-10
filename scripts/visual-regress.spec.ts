import { test, expect, Page } from "@playwright/test";

const PAGES: Array<{ name: string; path: string }> = [
  { name: "dashboard", path: "/" },
  { name: "issues", path: "/issues" },
  { name: "routines", path: "/routines" },
  { name: "company-settings", path: "/company/settings" },
  { name: "instance-settings", path: "/instance/settings/profile" },
];

const LANGUAGES = ["en"] as const;

async function setLanguage(page: Page, lang: string) {
  await page.addInitScript((selectedLang) => {
    try {
      window.localStorage.setItem("paperclip_language", selectedLang);
    } catch {
      // ignore
    }
  }, lang);
}

for (const lang of LANGUAGES) {
  for (const { name, path } of PAGES) {
    test(`visual regression - ${lang} - ${name}`, async ({ page }) => {
      await setLanguage(page, lang);
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveScreenshot(`${lang}-${name}.png`, {
        fullPage: true,
      });
    });
  }
}
