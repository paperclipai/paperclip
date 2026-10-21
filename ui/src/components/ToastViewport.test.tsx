// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider, useToastActions, type ToastInput } from "../context/ToastContext";
import { ToastViewport } from "./ToastViewport";

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
