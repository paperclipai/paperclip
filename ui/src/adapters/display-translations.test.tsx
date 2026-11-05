// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import en from "@/i18n/catalogs/en/agent-config.json";
import zh from "@/i18n/catalogs/zh-CN/agent-config.json";
import { validateLocaleMessages } from "@/i18n/locale-validation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildSchemaAdapterConfig, SchemaConfigFields } from "./schema-config-fields";
import { getAgentConfigDisplayText, getAgentRoleLabel } from "./display-translations";

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

describe("adapter localization contracts", () => {
  it("keeps English and Chinese catalog structure and interpolation aligned", () => {
    expect(validateLocaleMessages(zh, en)).toEqual([]);
  });

  it("translates known display labels at call time and preserves unknown labels and role IDs", async () => {
    await i18n.changeLanguage("en");
    expect(getAgentRoleLabel("engineer")).toBe("Engineer");
    await i18n.changeLanguage("zh-CN");
    expect(getAgentRoleLabel("engineer")).toBe("工程师");
    expect(getAgentRoleLabel("custom_role")).toBe("custom_role");
    expect(getAgentConfigDisplayText("private-user-model-id")).toBe("private-user-model-id");
    expect(getAgentConfigDisplayText("Automatic (isolated)")).toBe("自动（隔离）");
  });

  it.each(["Engineer", "Provider", "constructor", "__proto__"])("preserves unknown role ID %s even when it collides with display copy or object properties", async (role) => {
    for (const locale of ["en", "zh-CN", "en"]) {
      await i18n.changeLanguage(locale);
      expect(getAgentRoleLabel(role)).toBe(role);
    }
  });

  it("renders translated server-defined fields but emits identical original defaults and model IDs in both locales", async () => {
    const schema = { fields: [
      { key: "provider", label: "Provider", type: "select", default: "auto", options: [{ value: "auto", label: "Auto" }] },
      { key: "mode", label: "ACP session mode", type: "select", default: "persistent", options: [{ value: "persistent", label: "Persistent" }] },
      { key: "model", label: "Model", type: "text", default: "private-provider/model-v1" },
    ] };
    const original = JSON.stringify(schema);
    const patches: unknown[] = [];
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => schema })));
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      await act(async () => {
        root.render(<TooltipProvider><SchemaConfigFields adapterType={`localization-schema-${locale}`} mode="create" isCreate values={{ adapterSchemaValues: {} } as never} set={(patch) => patches.push(patch)} config={{}} eff={(_group, _key, fallback) => fallback} mark={() => {}} models={[]} /></TooltipProvider>);
      });
      expect(host.textContent).toContain(locale === "en" ? "Provider" : "提供商");
      expect(host.textContent).toContain(locale === "en" ? "ACP session mode" : "ACP会话模式");
      expect(host.querySelector("input")?.value).toBe("private-provider/model-v1");
      await act(async () => root.unmount());
      host.remove();
    }
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual(patches[0]);
    expect(patches[0]).toEqual({ adapterSchemaValues: { provider: "auto", mode: "persistent", model: "private-provider/model-v1" } });
    expect(JSON.stringify(schema)).toBe(original);
    const values = { model: "private-provider/model-v1", adapterSchemaValues: { provider: "auto", mode: "persistent", command: "node --flag", promptTemplate: "Original {{agent.name}} prompt" } } as never;
    const chinese = buildSchemaAdapterConfig(values);
    await i18n.changeLanguage("en");
    expect(buildSchemaAdapterConfig(values)).toEqual(chinese);
  });
});
