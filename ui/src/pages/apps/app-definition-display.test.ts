import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { appDefinitionDescription, appDefinitionText } from "./app-definition-display";
import { appCopyFor } from "@/lib/app-gallery-copy";
import agentmail from "../../../../packages/shared/src/app-definitions/agentmail.json";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("built-in app display localization", () => {
  it("translates the new AgentMail definition without editing its credential or protocol fields", async () => {
    const original = JSON.stringify(agentmail);
    const method = agentmail.methods[0]!;
    for (const language of ["en", "ru", "en"]) {
      await i18n.changeLanguage(language);
      for (const source of [agentmail.description, method.label, method.whenToUse, method.guidanceMd, method.credentialFields[0]!.label]) {
        const label = appDefinitionText("agentmail", source);
        if (language === "en") expect(label).toBe(source);
        else expect(label).toMatch(/[А-Яа-яЁё]/);
        expect(appDefinitionText("custom-agentmail", source)).toBe(source);
      }
      expect(appDefinitionText("agentmail", "am_…")).toBe("am_…");
      expect(appDefinitionText("agentmail", "A custom description")).toBe("A custom description");
      expect(JSON.stringify(agentmail)).toBe(original);
    }
  });
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
