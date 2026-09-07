import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { appDefinitionDescription, appDefinitionText } from "./app-definition-display";
import { appCopyFor } from "@/lib/app-gallery-copy";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("built-in app display localization", () => {
  it("requires both the app identity and the exact upstream source text", async () => {
    const source = "Read and update pages in your Notion workspace.";
    const entry = { slug: "notion", description: source } as Parameters<typeof appDefinitionDescription>[0];
    await i18n.changeLanguage("en");
    expect(appDefinitionDescription(entry)).toBe(source);
    await i18n.changeLanguage("ru");
    expect(appDefinitionDescription(entry)).toBe("Читайте и обновляйте страницы рабочего пространства Notion.");
    expect(appDefinitionText("custom-notion", source)).toBe(source);
    expect(appDefinitionText("notion", "Updated upstream wording")).toBe("Updated upstream wording");
    expect(entry?.description).toBe(source);
  });

  it("updates captured curated copy and keeps credential-shaped values untouched", async () => {
    await i18n.changeLanguage("en");
    const copy = appCopyFor("notion");
    expect(copy.tagline).toBe("Read and update pages in your workspace.");
    await i18n.changeLanguage("ru");
    expect(copy.tagline).not.toContain("Read and update");
    expect(appDefinitionText("posthog", "phx_...")).toBe("phx_...");
    expect(appDefinitionText("supabase", "database,docs")).toBe("database,docs");
    expect(appDefinitionText("google-drive", "Read & create")).toBe("Чтение и создание");
  });
});
