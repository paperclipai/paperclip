// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesignSandboxProvider, useDesignSandbox } from "./DesignSandboxContext";
import { useFlyoutAppearance } from "@/components/ui/flyout";
import { useAvatarInitials } from "@/components/ui/avatar-initials";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
function Subject() { return <><output>{String(useDesignSandbox())}:{useFlyoutAppearance()}</output><span data-testid="avatar-initials">{useAvatarInitials("BO")}</span></>; }
function render() { act(() => root.render(<StrictMode><DesignSandboxProvider><Subject /></DesignSandboxProvider></StrictMode>)); }
beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_PAPERCLIP_DESIGN_SANDBOX", "true");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.classList.remove("design-proposal-theme"); localStorage.clear(); vi.unstubAllEnvs(); });

it("requires a dev instance opt-in; browser storage cannot activate a production build", () => {
  vi.stubEnv("DEV", false); render();
  expect(host.querySelector("output")?.textContent).toBe("false:default");
  expect(host.querySelector("button")).toBeNull();
  expect(document.body.classList.contains("design-proposal-theme")).toBe(false);
});
it("does not affect ordinary development instances", () => {
  vi.stubEnv("VITE_PAPERCLIP_DESIGN_SANDBOX", "false"); render();
  expect(host.querySelector("output")?.textContent).toBe("false:default");
  expect(document.body.classList.contains("design-proposal-theme")).toBe(false);
});
it("toggles the exact proposal theme and portaled-menu appearance together and restores defaults", () => {
  render();
  expect(host.querySelector("output")?.textContent).toBe("true:refreshed");
  expect(host.querySelector('[data-testid="avatar-initials"]')?.textContent).toBe("B");
  expect(document.body.classList.contains("design-proposal-theme")).toBe(true);
  act(() => host.querySelector("button")!.click());
  expect(host.querySelector("output")?.textContent).toBe("false:default");
  expect(host.querySelector('[data-testid="avatar-initials"]')?.textContent).toBe("BO");
  expect(document.body.classList.contains("design-proposal-theme")).toBe(false);
  expect(localStorage.getItem("paperclip.design-proposals.sandbox")).toBe("off");
});
it("honors the saved off preference and cleans up the marker when unmounted", () => {
  localStorage.setItem("paperclip.design-proposals.sandbox", "off"); render();
  expect(host.querySelector("output")?.textContent).toBe("false:default");
  act(() => host.querySelector("button")!.click());
  expect(document.body.classList.contains("design-proposal-theme")).toBe(true);
  act(() => root.render(null));
  expect(document.body.classList.contains("design-proposal-theme")).toBe(false);
});
