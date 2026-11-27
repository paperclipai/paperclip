// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider, useToastActions, type ToastInput } from "../context/ToastContext";
import { ToastViewport } from "./ToastViewport";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
vi.stubGlobal("cancelAnimationFrame", clearTimeout);
function Notify({ toast }: { toast: ToastInput }) {
  const { pushToast } = useToastActions();
  useEffect(() => { pushToast(toast); }, [pushToast, toast]);
  return <ToastViewport />;
}
describe("notification avatars", () => {
  it.each(["user", "agent"] as const)("carries the %s identity through the provider to the viewport", (type) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => root.render(<ToastProvider><Notify toast={{ title: "Alex Example created a task", actor: { type, id: "actor-1", name: "Alex Example" } }} /></ToastProvider>));
      expect(container.textContent).toContain("Alex Example created a task");
      if (type === "user") expect(container.querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe("AE");
      else expect(container.querySelector('[data-slot="agent-avatar"] img')?.getAttribute("src")).toContain("/api/agent-avatars/");
    } finally { act(() => root.unmount()); }
  });
});
describe("toast session replay", () => {
  it("masks both the title and the body", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => root.render(<ToastProvider><Notify toast={{ title: "Default set to ops@globex.com", body: "Globex workspace connected" }} /></ToastProvider>));
      expect(replayLeaks("ops@globex.com", container)).toEqual({ rendered: true, recorded: false });
      expect(replayLeaks("Globex workspace connected", container)).toEqual({ rendered: true, recorded: false });
    } finally { act(() => root.unmount()); }
  });
});

describe("mobile bottom nav clearance and viewport fit", () => {
  it("lifts toasts above MobileBottomNav on mobile and constrains width inside narrow viewports", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => root.render(<ToastProvider><Notify toast={{ title: "Saved", body: "Ready" }} /></ToastProvider>));
      const aside = container.querySelector("aside");
      expect(aside).not.toBeNull();
      const classes = aside!.className.split(/\s+/);
      expect(classes).toContain("inset-x-3");
      expect(classes).toContain("sm:inset-x-auto");
      expect(classes).toContain("sm:left-3");
      expect(classes).toContain("sm:w-full");
      expect(classes).toContain("bottom-(--mobile-nav-overlay-bottom)");
      expect(classes).toContain("md:bottom-3");
      expect(classes).not.toContain("w-full");
    } finally { act(() => root.unmount()); }
  });
});
