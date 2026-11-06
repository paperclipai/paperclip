// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthStatus } from "@/api/health";
import { AnnouncementWell } from "./AnnouncementWell";
import { announcementPreview } from "@/lib/announcement-preview";

// N-13: the connectors announcement must not appear in a new user's first
// session, i.e. while the company's onboarding first task is still open.
const state = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: "alice", settled: true }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", loading: false }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogState: () => ({ onboardingOpen: false }) }));
vi.mock("@/context/ToastContext", () => ({ useOptionalToastActions: () => null, useOptionalToastState: () => [] }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: state.list } }));
vi.mock("@/hooks/useAnnouncement", () => ({ useAnnouncement: (options: { enabled: boolean }) => ({
  announcement: options.enabled ? announcementPreview : null, dismiss: vi.fn(),
}) }));
vi.mock("./AnnouncementCard", () => ({ AnnouncementCard: () => <p>Announcement fixture</p> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const firstTask = (status: string) => ({ id: "issue-1", companyId: "company", originKind: "onboarding_first_task", status });

describe("announcement well during onboarding", () => {
  let container: HTMLDivElement;
  let root: Root;
  const health = { deploymentMode: "authenticated" } as HealthStatus;
  const visible = () => Boolean(container.querySelector('[aria-label="Paperclip announcements"]'));
  const render = async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><AnnouncementWell health={health} /></QueryClientProvider>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  beforeEach(() => {
    state.list.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it("stays hidden while the onboarding first task is open", async () => {
    state.list.mockResolvedValue([firstTask("todo")]);
    await render();
    expect(visible()).toBe(false);
  });

  it("shows once the onboarding first task is finished, or when the company never had one", async () => {
    state.list.mockResolvedValue([firstTask("done")]);
    await render();
    expect(visible()).toBe(true);
    await act(async () => root.unmount()); root = createRoot(container);
    state.list.mockResolvedValue([]);
    await render();
    expect(visible()).toBe(true);
  });

  it("stays hidden when onboarding state cannot be read", async () => {
    state.list.mockRejectedValue(new Error("offline"));
    await render();
    expect(visible()).toBe(false);
  });
});
