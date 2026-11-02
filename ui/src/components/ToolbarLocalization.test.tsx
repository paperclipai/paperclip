// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n, t } from "@/i18n";
import { toolbarLabel } from "@/lib/toolbar-localization";
import { AgentsToolbar } from "./AgentsToolbar";

it("preserves the roster query/view and dispatches the canonical action only on click", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage("en"); const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const viewChange = vi.fn(), create = vi.fn();
  function Controls() { const [view, setView] = useState<"list" | "org">("org"); return <AgentsToolbar query="Raw {{query}}" onQueryChange={() => {}} view={view} onViewChange={v => { viewChange(v); setView(v); }} onNewAgent={create} />; }
  try {
    await act(async () => root.render(<Controls />)); const input = host.querySelector<HTMLInputElement>('input')!;
    for (const language of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(host.querySelector('input')).toBe(input); expect(input.value).toBe("Raw {{query}}");
      expect(host.querySelector(`button[aria-label="${t("oct26Toolbar.orgView")}"]`)?.getAttribute("aria-pressed")).toBe("true");
      expect(viewChange).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
      for (const unknown of ["Raw {{label}}", "constructor", "toString", "__proto__"]) expect(toolbarLabel(unknown)).toBe(unknown);
    }
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("oct26Toolbar.listView")}"]`)!.click());
    expect(viewChange).toHaveBeenCalledExactlyOnceWith("list");
  } finally { await act(async () => root.unmount()); host.remove(); await i18n.changeLanguage("en"); }
});
