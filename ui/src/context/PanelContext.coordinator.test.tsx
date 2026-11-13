// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelProvider, usePanel } from "./PanelContext";

const preference = vi.hoisted(() => ({ enabled: false, userId: "person-a" }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => preference }));
let panel: ReturnType<typeof usePanel>;
function Probe() { panel = usePanel(); return <span>{String(panel.panelVisible)}</span>; }
describe("Coordinator panel visibility", () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => { preference.enabled = false; preference.userId = "person-a"; localStorage.clear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(() => { flushSync(() => root.unmount()); container.remove(); });
  function render() { flushSync(() => root.render(<PanelProvider><Probe /></PanelProvider>)); }
  it("starts closed in Coordinator and restores classic visibility when switched off", () => {
    localStorage.setItem("paperclip:panel-visible", "true"); render();
    expect(panel.panelVisible).toBe(true);
    preference.enabled = true; render(); expect(panel.panelVisible).toBe(false);
    flushSync(() => panel.setPanelVisible(true)); expect(panel.panelVisible).toBe(true);
    flushSync(() => panel.setPanelVisible(false));
    expect(localStorage.getItem("paperclip:panel-visible")).toBe("true");
    preference.enabled = false; render(); expect(panel.panelVisible).toBe(true);
  });
  it("does not carry another person's open context pane across identity changes", () => {
    preference.enabled = true; render(); flushSync(() => panel.setPanelVisible(true));
    preference.userId = "person-b"; render(); expect(panel.panelVisible).toBe(false);
  });
});
