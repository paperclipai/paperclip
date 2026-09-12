// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySkillVersion } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentSkillRow, type AgentSkillRowData } from "./AgentSkillRow";
import { AgentSkillReleasePicker } from "./AgentSkillReleasePicker";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("agent skill control localization", () => {
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

  it("updates accessibility labels without changing the skill or release selection", async () => {
    const onCheckedChange = vi.fn();
    const onReleaseChange = vi.fn();
    const data = {
      key: "org/custom-skill",
      name: "My custom skill",
      icon: { key: "org/custom-skill", name: "My custom skill" },
      summary: "Keep these user instructions in English.",
      linkTo: null,
    } as AgentSkillRowData;
    const releases = [{ id: "v7-id", releaseName: "V7 — Roster champion" }] as CompanySkillVersion[];
    const original = structuredClone({ data, releases });
    await act(async () => {
      root.render(
        <TooltipProvider>
          <AgentSkillRow variant="enabled" data={data} checked onCheckedChange={onCheckedChange} />
          <AgentSkillReleasePicker releases={releases} value="v7-id" onChange={onReleaseChange} />
        </TooltipProvider>,
      );
    });
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.getAttribute("aria-label")).toBe("Disable My custom skill");
    expect(container.querySelector('[aria-label="Skill release"]')).toBeTruthy();
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(toggle.getAttribute("aria-label")).toBe("Отключить My custom skill");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[aria-label="Релиз навыка"]')).toBeTruthy();
    expect(container.textContent).toContain("V7 — Roster champion");
    expect(container.textContent).toContain("Keep these user instructions in English.");
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(onReleaseChange).not.toHaveBeenCalled();
    expect({ data, releases }).toEqual(original);
    await act(async () => toggle.click());
    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([1, 2, 5, 11, 21])("uses a numeric count for the enabled total (%s)", async (count) => {
    await i18n.changeLanguage("ru");
    expect(i18n.t("localizationAgentManagement.enabledCount", { count, total: 30 }))
      .toBe(`Включено ${count} из 30`);
  });
});
