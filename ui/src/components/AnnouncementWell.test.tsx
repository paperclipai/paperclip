// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthStatus } from "@/api/health";
import { AnnouncementWell } from "./AnnouncementWell";
import { announcementPreview } from "@/lib/announcement-preview";

const state = vi.hoisted(() => ({
  userId: "alice" as string | null, settled: true, companyId: "company", loading: false,
  onboardingOpen: false, toasts: [] as unknown[], dismiss: vi.fn(), hook: vi.fn(),
}));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: state.userId, settled: state.settled }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId, loading: state.loading }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogState: () => ({ onboardingOpen: state.onboardingOpen }) }));
vi.mock("@/context/ToastContext", () => ({ useOptionalToastActions: () => null, useOptionalToastState: () => state.toasts }));
vi.mock("@/hooks/useAnnouncement", () => ({ useAnnouncement: (options: { enabled: boolean }) => {
  state.hook(options);
  return { announcement: options.enabled ? announcementPreview : null, dismiss: state.dismiss };
} }));
vi.mock("./AnnouncementCard", () => ({ AnnouncementCard: ({ onDismiss }: { onDismiss: () => void }) => <button onClick={onDismiss}>Dismiss fixture</button> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("announcement placement gates", () => {
  let container: HTMLDivElement;
  let root: Root;
  let health: HealthStatus;
  const render = async () => { await act(async () => root.render(<AnnouncementWell health={health} />)); };
  const visible = () => Boolean(container.querySelector('[aria-label="Paperclip announcements"]'));
  beforeEach(() => {
    Object.assign(state, { userId: "alice", settled: true, companyId: "company", loading: false, onboardingOpen: false, toasts: [] });
    vi.clearAllMocks();
    health = { deploymentMode: "authenticated" } as HealthStatus;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  it("waits for identity, company and onboarding, and uses local-board in no-login mode", async () => {
    state.settled = false; await render(); expect(visible()).toBe(false);
    state.settled = true; state.loading = true; await render(); expect(visible()).toBe(false);
    state.loading = false; state.onboardingOpen = true; await render(); expect(visible()).toBe(false);
    state.onboardingOpen = false; await render(); expect(visible()).toBe(true);
    state.userId = null; await render(); expect(visible()).toBe(false);
    health = { deploymentMode: "local_trusted" } as HealthStatus; await render(); expect(visible()).toBe(true);
    expect(state.hook).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "local-board", enabled: true }));
  });
  it("yields to toasts and modal/command dialogs without dismissing", async () => {
    await render(); expect(visible()).toBe(true);
    state.toasts = [{}]; await render(); expect(visible()).toBe(false);
    state.toasts = []; await render(); expect(visible()).toBe(true);
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); dialog.setAttribute("data-state", "open");
    await act(async () => { document.body.append(dialog); }); expect(visible()).toBe(false);
    await act(async () => { dialog.remove(); }); expect(visible()).toBe(true);
    expect(state.dismiss).not.toHaveBeenCalled();
  });
});
