// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { i18n, t } from "@/i18n";
import { FinanceBillerCard } from "./FinanceBillerCard";
import { formatCents } from "../lib/utils";
import { formatDuration } from "../lib/timeline/layout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  void i18n.changeLanguage("en");
});

describe("Finance card localization", () => {
  it("switches a mounted card without changing biller identity or financial values", () => {
    const row = Object.freeze({ biller: "openai", debitCents: 12550, creditCents: 125, netCents: 12425, estimatedDebitCents: 500, eventCount: 21, kindCount: 5 });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<FinanceBillerCard row={row} />));
    expect(container.textContent).toContain("21 events across 5 kinds");
    act(() => { void i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("21 событие · 5 типов");
    expect(container.textContent).toContain("OpenAI");
    expect(container.textContent).toContain(formatCents(12425));
    expect(row).toMatchObject({ biller: "openai", debitCents: 12550, creditCents: 125, netCents: 12425 });
    expect(formatDuration(0, 90 * 60000)).toBe("1 ч 30 мин");
    act(() => { void i18n.changeLanguage("en"); });
    expect(container.textContent).toContain("21 events across 5 kinds");
    expect(formatDuration(0, 90 * 60000)).toBe("1h 30m");
  });

  it.each([[1, "событие"], [2, "события"], [5, "событий"], [21, "событие"], [22, "события"], [25, "событий"]])(
    "uses Russian financial event forms for %i", (count, noun) => {
      void i18n.changeLanguage("ru");
      expect(t("localizationCosts.rangeEvents", { count })).toBe(`${count} ${noun} за период`);
    },
  );
});
