// @vitest-environment jsdom
import React from "react";
import { i18n } from "@/i18n";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiConnectionAuth,
  type AiConnectionAuthProps,
} from "./AiConnectionAuth";

let root: Root | undefined;
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  void i18n.changeLanguage("en");
});
function mount(overrides: Partial<AiConnectionAuthProps> = {}) {
  const props: AiConnectionAuthProps = {
    provider: "openai",
    method: "api_key",
    state: { phase: "idle" },
    onStart: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onDone: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (next: Partial<AiConnectionAuthProps>) =>
    flushSync(() => root!.render(<AiConnectionAuth {...props} {...next} />));
  render({});
  return { props, container, render };
}
function typeInput(input: HTMLInputElement, value: string) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AI connection authentication presentation", () => {
  it("masks keys, hands them only to the injected action, and clears after submission", () => {
    const { container, props } = mount();
    const input = container.querySelector("input")!;
    expect(input.type).toBe("password");
    typeInput(input, "example-only-key");
    flushSync(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(props.onSubmit).toHaveBeenCalledWith("example-only-key");
    expect(input.value).toBe("");
    expect(container.textContent).not.toContain("example-only-key");
  });
  it("drops private input when the provider or lifecycle phase changes", () => {
    const { container, render } = mount();
    typeInput(container.querySelector("input")!, "example-only-key");
    render({ provider: "anthropic" });
    expect(container.querySelector("input")!.value).toBe("");
    typeInput(container.querySelector("input")!, "retry-key");
    render({ state: { phase: "error", message: "Rejected" } });
    expect(container.querySelector("input")!.value).toBe("");
  });
  it("cancellation clears input and invokes only cancellation", () => {
    const { container, props } = mount();
    typeInput(container.querySelector("input")!, "example-only-key");
    flushSync(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Cancel")!
        .click(),
    );
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector("input")!.value).toBe("");
  });
  it("never offers an OpenRouter subscription or starts a provider call on render", () => {
    const { container, props } = mount({
      provider: "openrouter",
      method: "subscription",
    });
    expect(container.textContent).toContain("does not offer a subscription");
    expect(container.querySelector("input")).toBeNull();
    expect(props.onStart).not.toHaveBeenCalled();
  });
});

it("retranslates an open auth form en/ru/en without resetting secrets or invoking actions", async () => {
  const { container, props } = mount();
  const input = container.querySelector("input")!;
  typeInput(input, "not-a-real-key");
  for (const [locale, title, placeholder] of [
    ["ru", "Подключить OpenAI", "Введите ключ API"],
    ["en", "Connect OpenAI", "Enter API key here"],
  ]) {
    flushSync(() => { void i18n.changeLanguage(locale); });
    expect(container.querySelector("section")?.getAttribute("aria-label")).toBe(title);
    expect(container.querySelector("h3")?.textContent).toBe(title);
    expect(container.querySelector("input")).toBe(input);
    expect(input.placeholder).toBe(placeholder);
    expect(input.value).toBe("not-a-real-key");
    expect(props.onStart).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  }
  flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("not-a-real-key");
});

it("keeps provider diagnostics and authentication URLs verbatim while switching locale", () => {
  const { container, render, props } = mount({ method: "subscription", state: { phase: "error", message: "Provider diagnostic: EXTERNAL_401" } });
  flushSync(() => { void i18n.changeLanguage("ru"); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Provider diagnostic: EXTERNAL_401");
  render({ method: "subscription", state: { phase: "waiting", authorizationUrl: "https://example.test/auth?intent=canonical", code: "CODE-123" } });
  expect(container.querySelector('a[href="https://example.test/auth?intent=canonical"]')).not.toBeNull();
  expect(container.textContent).toContain("CODE-123");
  expect(props.onStart).not.toHaveBeenCalled();
});
