// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ConnectModelPreview } from "./ConnectModelPreview";

vi.mock("./PillGuy", () => ({ PillGuy: () => null }));
vi.mock("./SleepingZs", () => ({ SleepingZs: () => null }));
vi.mock("./AgentPreview", () => ({ AgentPreview: ({ agentName }: { agentName: string }) => <span>{agentName}</span> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ConnectModelPreview localization", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    await i18n.changeLanguage("en");
  });

  it("preserves the selected source and API mode while localizing the radio group and CTA", async () => {
    await act(async () => root.render(<ConnectModelPreview initialSourceId="codex_local" initialUseApiKeys />));
    const source = container.querySelector('[role="radio"][aria-checked="true"]')!;
    const checkbox = container.querySelector('[role="checkbox"]')!;
    const group = container.querySelector('[role="radiogroup"]')!;
    expect(source.textContent).toContain("Codex");
    expect(group.getAttribute("aria-label")).toBe("Model source");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Use API keys instead");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(group.getAttribute("aria-label")).toBe("Поставщик модели");
    expect(source.getAttribute("aria-checked")).toBe("true");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Использовать API-ключи вместо подписки");
    expect(container.textContent).toContain("Подключить");
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("Darnold");
    await act(async () => checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(source.getAttribute("aria-checked")).toBe("true");
  });
});
