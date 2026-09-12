// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuotaWindow } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { AccountingModelCard } from "./AccountingModelCard";
import { CodexSubscriptionPanel } from "./CodexSubscriptionPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("accounting and quota display localization", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
  });

  it("updates accounting points created before a locale switch", async () => {
    await act(async () => root.render(<AccountingModelCard />));
    expect(container.textContent).toContain("tokens + billed dollars");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("токены и выставленные суммы в долларах");
    expect(container.textContent).toContain("cost_events");
    expect(container.textContent).not.toContain("tokens + billed dollars");
    expect(container.textContent).toContain("OpenRouter, Cloudflare, Bedrock");
  });

  it("localizes known quota labels without changing values, model names, grouping, or source objects", async () => {
    const windows: QuotaWindow[] = [
      { label: "Credits", usedPercent: null, resetsAt: null, valueLabel: "$12.34 remaining", detail: null },
      { label: "GPT-5.3-Codex-Spark · Weekly limit", usedPercent: 92, resetsAt: null, valueLabel: null, detail: "Provider detail remains verbatim" },
      { label: "5h limit", usedPercent: 12.5, resetsAt: "2026-08-31T12:00:00Z", valueLabel: null, detail: null },
    ];
    const original = structuredClone(windows);
    await act(async () => root.render(<CodexSubscriptionPanel windows={windows} source="codex-rpc" error="Custom provider error" />));
    expect(container.textContent).toContain("12.5% used");
    expect(container.textContent).toContain("$12.34 remaining");
    expect(container.textContent).toContain("Resets");
    const barWidths = Array.from(container.querySelectorAll<HTMLElement>("[style]")).map((node) => node.style.width);
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("Использовано 12,5%");
    expect(container.textContent).toContain("Осталось $12.34");
    expect(container.textContent).toContain("Сброс");
    expect(container.textContent).toContain("GPT-5.3-Codex-Spark · Недельный лимит");
    expect(container.textContent).toContain("Provider detail remains verbatim");
    expect(container.textContent).toContain("Custom provider error");
    expect(Array.from(container.querySelectorAll<HTMLElement>("[style]")).map((node) => node.style.width)).toEqual(barWidths);
    expect(windows).toEqual(original);
  });

  it("preserves unknown provider labels and values", async () => {
    await i18n.changeLanguage("ru");
    const windows: QuotaWindow[] = [
      { label: "Custom weekly budget", usedPercent: null, resetsAt: null, valueLabel: "20 custom units", detail: "Unrecognized detail" },
      { label: "toString", usedPercent: null, resetsAt: null, valueLabel: "Custom amount", detail: null },
    ];
    await act(async () => root.render(<CodexSubscriptionPanel windows={windows} source="custom-provider" />));
    expect(container.textContent).toContain("Custom weekly budget");
    expect(container.textContent).toContain("20 custom units");
    expect(container.textContent).toContain("Unrecognized detail");
    expect(container.textContent).toContain("custom-provider");
    expect(container.textContent).toContain("toString");
  });
});
