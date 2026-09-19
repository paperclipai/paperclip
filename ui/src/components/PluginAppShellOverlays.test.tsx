// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginAppShellOverlays } from "./PluginAppShellOverlays";

const state = vi.hoisted(() => ({ userId: "alice" as string | null, settled: true, company: "first", onboarding: false, dismissed: false, pathname: "/ACME/issues", context: {} as Record<string, unknown>, failed: false, mounts: 0, disposals: 0 }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: state.userId, settled: state.settled }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.company, selectedCompany: { issuePrefix: "ACME" }, loading: false }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogState: () => ({ onboardingOpen: state.onboarding, onboardingRouteDismissed: state.dismissed }) }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ pathname: state.pathname }) }));
vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ errorMessage: state.failed ? "unavailable" : null, slots: [{ pluginId: "fixture", pluginVersion: "1.0.0", id: "overlay" }] }),
  PluginSlotMount: ({ context }: { context: Record<string, unknown> }) => {
    state.context = context;
    const [draft, setDraft] = useState("");
    useEffect(() => { state.mounts++; return () => { state.disposals++; }; }, []);
    return <button onClick={() => setDraft("private draft")}>{draft || "empty"}</button>;
  },
}));
let root: Root | undefined;
let container: HTMLDivElement;
function render(localTrusted = false) {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  flushSync(() => root!.render(<PluginAppShellOverlays localTrusted={localTrusted} />));
}
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = undefined; container?.remove();
  Object.assign(state, { userId: "alice", settled: true, company: "first", onboarding: false, dismissed: false, pathname: "/ACME/issues", context: {}, failed: false, mounts: 0, disposals: 0 });
});
describe("persistent app-shell plugin lifecycle", () => {
  it("passes the complete host context promised by PluginWidgetProps", () => {
    render();
    expect(state.context).toEqual({ companyId: "first", companyPrefix: "ACME", projectId: null, entityId: null, entityType: null, parentEntityId: null, userId: "alice" });
  });
  it("disposes drafts on route-driven onboarding and remounts after dismissal", () => {
    render(); flushSync(() => container.querySelector("button")!.click());
    state.pathname = "/ACME/onboarding"; render();
    expect(state.onboarding).toBe(false); expect(container.textContent).toBe(""); expect(state.disposals).toBe(1);
    state.dismissed = true; render(); expect(container.textContent).toBe("empty");
  });
  it("keeps a draft during shell rerenders and clears it on account/company transitions", () => {
    render(); flushSync(() => container.querySelector("button")!.click());
    render(); expect(container.textContent).toBe("private draft"); expect(state.mounts).toBe(1);
    state.userId = "bob"; render(); expect(container.textContent).toBe("empty"); expect(state.disposals).toBe(1);
    flushSync(() => container.querySelector("button")!.click());
    state.company = "second"; render(); expect(container.textContent).toBe("empty"); expect(state.disposals).toBe(2);
  });
  it("disposes private UI on sign-out and waits for a settled identity", () => {
    render(); state.userId = null; render(); expect(container.textContent).toBe(""); expect(state.disposals).toBe(1);
    state.userId = "bob"; state.settled = false; render(); expect(state.mounts).toBe(1);
    state.settled = true; render(); expect(state.mounts).toBe(2);
  });
  it("does not render during onboarding or contribution errors", () => {
    state.onboarding = true; render(); expect(state.mounts).toBe(0);
    state.onboarding = false; state.failed = true; render(); expect(container.textContent).toBe("");
  });
  it("clears account state when returning to the sessionless local board", () => {
    render(true); flushSync(() => container.querySelector("button")!.click());
    state.settled = false; render(true); expect(container.textContent).toBe(""); expect(state.disposals).toBe(1);
    state.userId = null; state.settled = true; render(true);
    expect(container.textContent).toBe("empty"); expect(state.mounts).toBe(2);
    flushSync(() => container.querySelector("button")!.click());
    state.userId = "bob"; render(true); expect(container.textContent).toBe("empty"); expect(state.disposals).toBe(2);
  });
});
