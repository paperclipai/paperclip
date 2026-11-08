// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { i18n } from "@/i18n";
import { HttpConfigFields } from "../adapters/http/config-fields";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { help } from "./agent-config-primitives";
import { TooltipProvider } from "./ui/tooltip";
import { TrustPresetSection } from "./TrustPresetSection";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("agent configuration localization", () => {
  it("localizes nested trust presets while submitting identical canonical permissions in English and Chinese", async () => {
    const payloads: unknown[] = [];
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      flushSync(() => root.render(<TooltipProvider><TrustPresetSection permissions={{ trustPreset: "standard" }} onChange={(value) => payloads.push(value)} /></TooltipProvider>));
      expect(host.textContent).toContain(locale === "en" ? "Low-trust review" : "低信任审核");
      const select = host.querySelector("select")!;
      expect(Array.from(select.options, (option) => option.value)).toEqual(["standard", "low_trust_review"]);
      select.value = "low_trust_review";
      flushSync(() => select.dispatchEvent(new Event("change", { bubbles: true })));
      flushSync(() => root.unmount());
      host.remove();
    }
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toEqual(payloads[0]);
    expect(payloads[0]).toMatchObject({ trustPreset: "low_trust_review" });
  });
  it("evaluates exported display helpers and nested help in the current locale", async () => {
    await i18n.changeLanguage("en");
    expect(getAdapterDisplay("process").label).toBe("Process");
    expect(help.name).toBe("Display name for this agent.");
    await i18n.changeLanguage("zh-CN");
    expect(getAdapterDisplay("process").label).toBe("进程");
    expect(help.name).toBe("此智能体的显示名称。");
    expect(getAdapterDisplay("codex_local").label).toBe("Codex");
  });
  it("updates mounted adapter fields without modifying the submitted configuration", async () => {
    await i18n.changeLanguage("en");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const values = { url: "https://example.com/agent" };
    flushSync(() => root.render(<TooltipProvider><HttpConfigFields adapterType="http" mode="create" isCreate values={values as never} set={() => {}} config={{}} eff={(_group, _key, fallback) => fallback} mark={() => {}} models={[]} /></TooltipProvider>));
    expect(host.textContent).toContain("Webhook URL");
    await i18n.changeLanguage("zh-CN");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).toContain("Webhook 地址");
    expect(host.querySelector("input")?.value).toBe(values.url);
    flushSync(() => root.unmount());
    host.remove();
  });
});
