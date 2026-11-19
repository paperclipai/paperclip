// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProjectTasks } from "./SidebarProjectTasks";
import { TooltipProvider } from "./ui/tooltip";

vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className, state: _state, end: _end, ...props }: {
    to: string; children: ReactNode; className?: string | ((state: { isActive: boolean }) => string); state?: unknown; end?: boolean;
  }) => <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, container: HTMLDivElement, client: QueryClient;
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

async function expandProject() {
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider>
    <SidebarProjectTasks project={{ id: "project", companyId: "company", name: "Launch" }} userId="viewer">
      <a href="/projects/launch/issues">Launch</a>
    </SidebarProjectTasks>
  </TooltipProvider></QueryClientProvider>));
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand Launch"]')!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

describe("SidebarProjectTasks API contract", () => {
  it("requests full task rows with read state and renders their monitoring and unread fields", async () => {
    fetchMock.mockImplementation(async input => {
      const params = new URL(String(input), "https://paperclip.test").searchParams;
      const full = params.get("view") === null;
      const readState = params.get("includeReadState") === "true";
      return new Response(JSON.stringify([
        { id: "monitor", companyId: "company", projectId: "project", identifier: "TASK-1", title: "Watching launch", status: "in_progress",
          ...(full ? { displayStatus: "monitoring" } : {}), ...(readState ? { isUnreadForMe: true } : {}) },
        { id: "read", companyId: "company", projectId: "project", identifier: "TASK-2", title: "Reviewed task", status: "todo",
          ...(readState ? { isUnreadForMe: false } : {}) },
      ]), { headers: { "Content-Type": "application/json" } });
    });
    await expandProject();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, options] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input), "https://paperclip.test");
    expect(url.pathname).toBe("/api/companies/company/issues");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      projectId: "project", includeReadState: "true", limit: "12", sortField: "updated", sortDir: "desc",
    });
    expect(options?.credentials).toBe("include");
    const monitoring = container.querySelector('a[href="/issues/TASK-1"]')!;
    expect(monitoring.querySelector('[aria-label="Unread"]')).not.toBeNull();
    expect(monitoring.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe("Monitoring");
    const read = container.querySelector('a[href="/issues/TASK-2"]')!;
    expect(read.querySelector('[aria-label="Unread"]')).toBeNull();
    expect(read.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe("Todo");
  });

  it("shows a denied read without rendering task data", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    }));
    await expandProject();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t load tasks.");
    expect(container.querySelector('a[href^="/issues/"]')).toBeNull();
    expect(container.querySelector('a[href="/projects/launch/issues"]')).not.toBeNull();
  });
});
