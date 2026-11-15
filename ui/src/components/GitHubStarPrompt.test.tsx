// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "@paperclipai/shared";
import type { HealthStatus } from "@/api/health";
import { GitHubStarPrompt, STAR_PROMPT_SEEN_KEY } from "./GitHubStarPrompt";

const state = vi.hoisted(() => ({ companyId: "company", loading: false, onboardingOpen: false, onboardingStatus: null as string | null, done: 5, listCompact: vi.fn() }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId, loading: state.loading }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogState: () => ({ onboardingOpen: state.onboardingOpen }) }));
vi.mock("@/api/issues", () => ({ issuesApi: {
  list: () => Promise.resolve(state.onboardingStatus ? [{ id: "onboarding", originKind: ONBOARDING_FIRST_TASK_ORIGIN_KIND, status: state.onboardingStatus }] : []),
  listCompact: (...args: unknown[]) => {
    state.listCompact(...args);
    return Promise.resolve(Array.from({ length: state.done }, (_, i) => ({ id: `issue-${i}` })));
  },
} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("GitHub star prompt", () => {
  let container: HTMLDivElement;
  let root: Root;
  let navigate: NavigateFunction | null = null;
  function NavigateHandle() { navigate = useNavigate(); return null; }
  const render = async (health: Partial<HealthStatus> | null = { deploymentMode: "local_trusted" }, path = "/CHA/dashboard") => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (health) client.setQueryData(["health"], health);
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>
      <NavigateHandle /><GitHubStarPrompt />
    </MemoryRouter></QueryClientProvider>));
    // Let the onboarding and done-count queries settle, however slow the run.
    for (let idle = 0, tick = 0; idle < 2 && tick < 100; tick++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      idle = client.isFetching() === 0 ? idle + 1 : 0;
    }
  };
  const visible = () => Boolean(document.querySelector('[data-testid="github-star-prompt"]'));
  beforeEach(() => {
    Object.assign(state, { companyId: "company", loading: false, onboardingOpen: false, onboardingStatus: null, done: 5 });
    state.listCompact.mockClear();
    window.localStorage.clear();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it("opens once a self-hosted company has five done tasks, and only once", async () => {
    await render();
    expect(visible()).toBe(true);
    expect(state.listCompact).toHaveBeenCalledWith("company", { status: "done", limit: 5 }, expect.anything());
    expect(window.localStorage.getItem(STAR_PROMPT_SEEN_KEY)).not.toBeNull();
    const star = document.querySelector<HTMLAnchorElement>('a[href="https://github.com/paperclipai/paperclip"]');
    expect(star?.target).toBe("_blank");

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(visible()).toBe(false);
  });

  it("waits for another open dialog to close", async () => {
    const other = document.createElement("div");
    other.setAttribute("role", "dialog"); other.setAttribute("data-state", "open");
    document.body.append(other);
    await render();
    expect(visible()).toBe(false);
    await act(async () => { other.remove(); });
    expect(visible()).toBe(true);
  });

  it("never covers a task's Retry: it waits until no Retry banner is on screen", async () => {
    const banner = document.createElement("div");
    banner.setAttribute("role", "status"); banner.setAttribute("aria-label", "Task status");
    banner.innerHTML = '<span>Couldn’t finish this attempt. Your message is saved.</span><button data-testid="task-execution-retry">Retry</button>';
    document.body.append(banner);
    try {
      await render();
      expect(visible()).toBe(false);
      expect(banner.closest('[aria-hidden="true"]')).toBeNull();
      await act(async () => { banner.remove(); });
      expect(visible()).toBe(true);
    } finally { banner.remove(); }
  });

  it("does not interrupt while the user is looking at a task or a chat", async () => {
    await render(undefined, "/CHA/issues/CHA-4");
    expect(visible()).toBe(false);
    await act(async () => { navigate!("/CHA/chats/claude"); });
    expect(visible()).toBe(false);
    expect(window.localStorage.getItem(STAR_PROMPT_SEEN_KEY)).toBeNull();
    await act(async () => { navigate!("/CHA/issues"); });
    expect(visible()).toBe(true);
  });

  it("closes when the user goes back to a task, or a task asks for Retry", async () => {
    await render();
    expect(visible()).toBe(true);
    await act(async () => { navigate!("/CHA/issues/CHA-4"); });
    expect(visible()).toBe(false);

    window.localStorage.clear();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(visible()).toBe(true);
    const retry = document.createElement("button");
    retry.setAttribute("data-testid", "task-execution-retry");
    document.body.append(retry);
    try {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(visible()).toBe(false);
      expect(retry.closest('[aria-hidden="true"]')).toBeNull();
    } finally { retry.remove(); }
  });

  it("does not open after another tab has shown it", async () => {
    const other = document.createElement("div");
    other.setAttribute("role", "dialog"); other.setAttribute("data-state", "open");
    document.body.append(other);
    await render();
    window.localStorage.setItem(STAR_PROMPT_SEEN_KEY, new Date().toISOString());
    await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: STAR_PROMPT_SEEN_KEY })); });
    await act(async () => { other.remove(); });
    expect(visible()).toBe(false);
  });

  it("waits until the onboarding task is finished", async () => {
    state.onboardingStatus = "in_progress";
    await render();
    expect(visible()).toBe(false);
    expect(state.listCompact).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    state.onboardingStatus = "done";
    await render();
    expect(visible()).toBe(true);
  });

  it("stays hidden below five done tasks", async () => {
    state.done = 4;
    await render();
    expect(visible()).toBe(false);
    expect(window.localStorage.getItem(STAR_PROMPT_SEEN_KEY)).toBeNull();
  });

  it("stays hidden on cloud, during onboarding, and before health is known", async () => {
    await render({ deploymentMode: "authenticated", cloud: {} as HealthStatus["cloud"] });
    expect(visible()).toBe(false);
    state.onboardingOpen = true;
    await render();
    expect(visible()).toBe(false);
    state.onboardingOpen = false;
    await render(null);
    expect(visible()).toBe(false);
    expect(state.listCompact).not.toHaveBeenCalled();
  });
});
