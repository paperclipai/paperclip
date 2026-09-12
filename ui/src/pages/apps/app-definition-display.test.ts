import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { appDefinitionDescription, appDefinitionText } from "./app-definition-display";
import { appCopyFor } from "@/lib/app-gallery-copy";
import agentmail from "../../../../packages/shared/src/app-definitions/agentmail.json";
import anthropic from "../../../../packages/shared/src/app-definitions/anthropic.json";
import openai from "../../../../packages/shared/src/app-definitions/openai.json";
import openrouter from "../../../../packages/shared/src/app-definitions/openrouter.json";
import photon from "../../../../packages/shared/src/app-definitions/imessage-photon.json";
import xai from "../../../../packages/shared/src/app-definitions/xai.json";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("built-in app display localization", () => {
  it.each([anthropic, openai, openrouter, xai])("localizes $slug AI account metadata without changing canonical values", async (definition) => {
    const original = JSON.stringify(definition);
    const sources = [definition.description];
    const aiMethods = definition.methods.filter((method) => "purpose" in method && method.purpose === "ai");
    expect(aiMethods.length).toBeGreaterThan(0);
    for (const method of aiMethods) {
      for (const [key, value] of Object.entries(method)) {
        if (["label", "whenToUse", "guidanceMd"].includes(key) && typeof value === "string") sources.push(value);
      }
      if ("credentialFields" in method) {
        for (const field of method.credentialFields ?? []) {
          sources.push(field.label);
          if (field.placeholder) sources.push(field.placeholder);
        }
      }
    }
    for (const language of ["en", "ru", "en"]) {
      await i18n.changeLanguage(language);
      for (const source of sources) {
        const rendered = appDefinitionText(definition.slug, source);
        if (language === "en") expect(rendered).toBe(source);
        else expect(rendered).toMatch(/[А-Яа-яЁё]/);
        expect(appDefinitionText(`custom-${definition.slug}`, source)).toBe(source);
      }
      for (const value of [definition.slug, definition.name, "ai-api_key", "ai-subscription", "runtime_auth", "api_key", "apiKey", "oauth", "subscription", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "Custom account guidance"]) {
        expect(appDefinitionText(definition.slug, value)).toBe(value);
      }
      expect(JSON.stringify(definition)).toBe(original);
    }
  });

  it("localizes Photon metadata while preserving the canonical schema and custom copy", async () => {
    const original = JSON.stringify(photon);
    const method = photon.methods[0]!;
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      for (const source of [photon.description, method.label, method.whenToUse, method.guidanceMd, method.credentialFields[0]!.label, method.credentialFields[0]!.placeholder]) {
        const rendered = appDefinitionText("imessage-photon", source);
        if (locale === "en") expect(rendered).toBe(source);
        else expect(rendered).toMatch(/[А-Яа-яЁё]/);
        expect(appDefinitionText("custom-photon", source)).toBe(source);
      }
      for (const value of ["imessage-photon", "projectSecret", "chat_sdk", "direct_message", "group_chat", "iMessage Photon", "Custom project description"]) {
        expect(appDefinitionText("imessage-photon", value)).toBe(value);
      }
      expect(JSON.stringify(photon)).toBe(original);
    }
  });
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
