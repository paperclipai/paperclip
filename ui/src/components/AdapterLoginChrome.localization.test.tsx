// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { LocalProviderLoginInstructions, OnboardingCardField, ProviderApiKeyCard, ProviderSubscriptionCard } from "./AdapterLoginChrome";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("shared provider login localization", () => {
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

  it.each(["submitted_code", "displayed_code"] as const)("preserves the %s authorization destination and draft across en/ru/en", async (mode) => {
    const submit = vi.fn();
    const change = vi.fn();
    function Card() {
      const [draft, setDraft] = useState("RAW-CODE-123");
      return <ProviderSubscriptionCard mode={mode} providerName="OpenAI" authorizationUrl="https://auth.openai.com/device?challenge=raw">
        <OnboardingCardField value={draft} onChange={(value) => { change(value); setDraft(value); }} onSubmit={submit} />
      </ProviderSubscriptionCard>;
    }
    await act(async () => root.render(<Card />));
    const input = container.querySelector("input")!;
    const anchor = container.querySelector("a")!;
    for (const locale of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.querySelector("input")).toBe(input);
      expect(input.value).toBe("RAW-CODE-123");
      expect(input.getAttribute("aria-label")).toBe(locale === "ru" ? "Код авторизации" : "Authorization code");
      expect(container.querySelector("a")).toBe(anchor);
      expect(anchor.textContent).toBe(locale === "ru" ? "Войдите в OpenAI" : "Sign in to OpenAI");
      expect(anchor.getAttribute("href")).toBe("https://auth.openai.com/device?challenge=raw");
      expect(anchor.getAttribute("rel")).toBe("noreferrer noopener");
      expect(container.textContent).toContain(locale === "ru"
        ? mode === "submitted_code" ? "затем вернитесь и введите код авторизации" : "с помощью кода авторизации ниже"
        : mode === "submitted_code" ? "then come back and enter authorization code" : "by providing the authorization code below");
      expect(submit).not.toHaveBeenCalled();
      expect(change).not.toHaveBeenCalled();
    }
  });

  it("keeps API credentials masked and unchanged on locale switches", async () => {
    const change = vi.fn();
    const submit = vi.fn();
    await act(async () => root.render(<ProviderApiKeyCard providerName="OpenAI" value="raw-secret-fixture" onChange={change} onSubmit={submit} />));
    const input = container.querySelector("input")!;
    for (const locale of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.querySelector("input")).toBe(input);
      expect(input.type).toBe("password");
      expect(input.value).toBe("raw-secret-fixture");
      expect(input.getAttribute("aria-label")).toBe(locale === "ru" ? "Ключ API" : "API key");
      expect(container.textContent).toContain(locale === "ru" ? "OpenAI" : "Provide your OpenAI API key to connect");
      expect(change).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    }
  });

  it("preserves expanded local login instructions and raw commands without retrying on locale change", async () => {
    const retry = vi.fn();
    const command = "CODEX_HOME='/fixture/isolated-login' codex login";
    await act(async () => root.render(<LocalProviderLoginInstructions adapterType="codex_local" login={{ status: "ready", command, preparing: false, error: null, retry }} />));
    const different = [...container.querySelectorAll("button")].find((button) => button.textContent === "Use a different account")!;
    await act(async () => different.click());
    const code = container.querySelector("code")!;
    for (const locale of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.querySelector("code")).toBe(code);
      expect(code.textContent).toBe(command);
      expect(container.textContent).toContain(locale === "ru" ? "Вход в Codex CLI выполнен" : "Codex CLI is signed in");
      expect(container.querySelector("button[aria-label]")?.getAttribute("aria-label")).toBe(locale === "ru" ? "Скопировать команду входа" : "Copy sign-in command");
      expect(retry).not.toHaveBeenCalled();
    }
  });

  it("preserves provider errors verbatim", async () => {
    const retry = vi.fn();
    await act(async () => root.render(<LocalProviderLoginInstructions adapterType="claude_local" login={{ preparing: false, error: "Provider error: denied <raw>", retry }} />));
    for (const locale of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Provider error: denied <raw>");
      expect(retry).not.toHaveBeenCalled();
    }
  });
});
