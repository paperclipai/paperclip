// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelinesIndexTable } from "./Pipelines";
import { i18n } from "@/i18n";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div data-testid="sort-options">{children}</div>,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("pipeline locale switching", () => {
  it("updates every sort option on the mounted table and keeps the selected direction", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        await i18n.changeLanguage("en");
        root.render(<PipelinesIndexTable pipelines={[]} viewMode="flat" onViewModeChange={() => {}} connectionsAvailable={false} search="" onSearchChange={() => {}} />);
      });
      const keys = ["sortName", "sortLastActivity", "sortMostToReview", "sortMostInMotion", "sortMostOpenItems"];
      const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="sort-options"] button')];
      expect(buttons()).toHaveLength(5);
      expect(buttons().map((button) => button.firstElementChild?.textContent)).toEqual(keys.map((key) => i18n.t(`pages.pipelines.${key}`)));
      await act(async () => { buttons()[0].click(); });
      expect(buttons()[0].textContent).toContain("↓");
      await act(async () => { await i18n.changeLanguage("ru"); });
      expect(buttons().map((button) => button.firstElementChild?.textContent)).toEqual(keys.map((key) => i18n.t(`pages.pipelines.${key}`)));
      expect(buttons()[0].textContent).toContain("↓");
      expect(container.querySelector("input")?.placeholder).toBe(i18n.t("pages.pipelines.searchPipelines"));
      await act(async () => { await i18n.changeLanguage("en"); });
      expect(buttons()[0].textContent).toContain("↓");
      expect(buttons()[0].firstElementChild?.textContent).toBe(i18n.t("pages.pipelines.sortName"));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
