// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import { CodexLocalConfigFields } from "./config-fields";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

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

it("retranslates the ACPX read permission EN → RU → EN without changing saved modes or making writes", async () => {
  const config = Object.freeze({
    provider: "acpx",
    acpxAgent: "claude",
    acpxPermissionMode: "approve-reads",
    model: "customer/model-42",
    lifecycleMode: "warm",
    idleTimeoutMs: 45_000,
  });
  const original = JSON.stringify(config);
  const mark = vi.fn();
  await act(async () => root.render(
    <TooltipProvider>
      <CodexLocalConfigFields
        mode="edit"
        isCreate={false}
        adapterType="paperclip_runner"
        values={null}
        set={null}
        config={config}
        eff={(_group, _field, value) => value}
        mark={mark}
        models={[]}
        hideInstructionsFile
      />
    </TooltipProvider>,
  ));
  const permissionSelector = () => container.querySelector(`button[role="combobox"][aria-label=${JSON.stringify(i18n.t("localizationAgents.ui314_Permission_mode"))}]`);
  const permission = permissionSelector()!;
  const harnessSelector = () => container.querySelector(`button[role="combobox"][aria-label=${JSON.stringify(i18n.t("oct6Beta.copy001"))}]`);
  const harness = harnessSelector()!;
  const nativeValues = () => Array.from(container.querySelectorAll("select"), (select) => ({
    value: select.value,
    options: Array.from(select.options, (option) => option.value),
  }));
  const originalValues = nativeValues();
  for (const language of ["en", "ru", "en"] as const) {
    await act(async () => { await i18n.changeLanguage(language); });
    expect(permissionSelector()).toBe(permission);
    expect(permission.textContent).toBe(language === "ru"
      ? "Разрешить чтение в Paperclip"
      : "Allow Paperclip reads");
    expect(permission.getAttribute("aria-label")).toBe(language === "ru"
      ? "Режим разрешений"
      : "Permission mode");
    expect(harnessSelector()).toBe(harness);
    expect(harness.textContent).toBe(language === "ru" ? "Агенты ACP" : "ACP agents");
    expect(nativeValues()).toEqual(originalValues);
    expect(container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("45000");
    expect(JSON.stringify(config)).toBe(original);
    expect(mark).not.toHaveBeenCalled();
  }
});
