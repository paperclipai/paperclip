// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupWizardNavigation, SetupWizardSidebarOutlet } from "./SetupWizard";
import { SetupWizardSidebarProvider } from "@/context/SetupWizardSidebarContext";
const setSidebarOpen = vi.hoisted(() => vi.fn());
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: true, setSidebarOpen }) }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("SetupWizard sidebar takeover", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); vi.clearAllMocks(); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  it("replaces section navigation, portals the steps, and restores the menu on exit", () => {
    const select = vi.fn();
    const render = (wizard: boolean) => act(() => root.render(<SetupWizardSidebarProvider>
      <SetupWizardSidebarOutlet><nav aria-label="Routine navigation">Overview · Triggers</nav></SetupWizardSidebarOutlet>
      {wizard && <SetupWizardNavigation takeover ariaLabel="Trigger setup progress" labels={["Choose", "Connect", "Check"]} step={1} availableStep={1} onSelect={select} />}
    </SetupWizardSidebarProvider>));
    render(false);
    expect(container.querySelector('[aria-label="Routine navigation"]')).not.toBeNull();
    render(true);
    expect(container.querySelector('[aria-label="Routine navigation"]')).toBeNull();
    expect(container.querySelector('aside nav[aria-label="Trigger setup progress"]')).not.toBeNull();
    const buttons = container.querySelectorAll<HTMLButtonElement>("nav button");
    expect(buttons[1].getAttribute("aria-current")).toBe("step");
    expect(buttons[2].disabled).toBe(true);
    act(() => buttons[0].click());
    expect(select).toHaveBeenCalledWith(0);
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
    render(false);
    expect(container.querySelector('[aria-label="Routine navigation"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Trigger setup progress"]')).toBeNull();
  });
  it("keeps steps accessible when the shell has no sidebar outlet", () => {
    act(() => root.render(<SetupWizardSidebarProvider>
      <SetupWizardNavigation takeover ariaLabel="Trigger setup progress" labels={["Choose", "Connect", "Check"]} step={1} availableStep={1} onSelect={vi.fn()} />
    </SetupWizardSidebarProvider>));
    expect(container.querySelector('nav[aria-label="Trigger setup progress"]')).not.toBeNull();
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Connect");
  });

});
