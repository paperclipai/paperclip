// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { AgentSetupError, agentSetupErrorText } from "@/lib/agent-setup-error";
import { SavedProviderKeySelect } from "./onboarding/SavedProviderKeySelect";
import { RuntimeTestCard } from "./RuntimeTestCard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("agent setup localization", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
  });

  it.each(["api", "subscription"] as const)("keeps the %s selector, selection and callback values across language changes", async (kind) => {
    const onChange = vi.fn();
    await act(async () => root.render(<SavedProviderKeySelect
      kind={kind} value="company:raw-id" loading={false} error={false} onChange={onChange}
      options={[{ id: "company:raw-id", label: "Provider-owned <account>", binding: { type: "secret_ref", secretId: "raw-id", version: "latest" } }]}
    />));
    const select = container.querySelector("select")!;
    for (const locale of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.querySelector("select")).toBe(select);
      expect(select.value).toBe("company:raw-id");
      expect(select.getAttribute("aria-label")).toBe(locale === "ru"
        ? kind === "api" ? "Сохранённый ключ API" : "Сохранённая подписка"
        : kind === "api" ? "Saved API key" : "Saved subscription");
      expect(select.options[0].text).toBe("Provider-owned <account>");
      expect(onChange).not.toHaveBeenCalled();
    }
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("updates test copy without rerunning the probe or translating provider output", async () => {
    const onTest = vi.fn();
    await act(async () => root.render(<RuntimeTestCard state="pass" onTest={onTest} result={{
      adapterType: "codex_local", status: "pass", testedAt: "2026-09-11T00:00:00Z",
      checks: [{ code: "provider_check", level: "info", message: "Provider-owned output" }],
    }} />));
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.querySelector("section")?.getAttribute("aria-label")).toBe("Проверка среды выполнения");
    expect(container.textContent).toContain("Подключение установлено");
    expect(container.textContent).toContain("Provider-owned output");
    expect(onTest).not.toHaveBeenCalled();
  });

  it("retranslates stored local errors while preserving chained provider errors", async () => {
    const error = new AgentSetupError("agentSetup.enterKeyOrSecret", { envKey: "API_SERVER_KEY" });
    const cleanup = new AgentSetupError("agentSetup.unusedCredentialRemovalFailed", {}, new Error("Provider-owned failure"));
    expect(agentSetupErrorText(error, i18n.t.bind(i18n))).toBe("Enter API_SERVER_KEY or select an organization secret.");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(agentSetupErrorText(error, i18n.t.bind(i18n))).toBe("Введите API_SERVER_KEY или выберите секрет организации.");
    expect(agentSetupErrorText(cleanup, i18n.t.bind(i18n))).toMatch(/^Provider-owned failure Не удалось/);
  });
});
