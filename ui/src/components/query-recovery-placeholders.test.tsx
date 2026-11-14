// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ConnectivityProvider, createConnectivityStore } from "@/lib/connectivity";
import { CaseHandoffHistory } from "./cases/CaseHandoffHistory";
import { TaskDecisionRecord } from "./TaskDecisionRecord";

const query = vi.hoisted(() => ({ status: "pending", fetchStatus: "paused", data: undefined,
  error: null as unknown, refetch: vi.fn(), isPending: true, isLoading: false }));
vi.mock("@tanstack/react-query", async original => ({
  ...await original<typeof import("@tanstack/react-query")>(), useQuery: () => query, useInfiniteQuery: () => query,
}));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ hash: "#decision-one" }), Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("./DecisionResolver", () => ({ DecisionResolver: () => null }));

it.each(["paused", "failed"])("keeps uncached reads in their loading state through a %s outage", async state => {
  Object.assign(query, { status: state === "paused" ? "pending" : "error", fetchStatus: state === "paused" ? "paused" : "idle",
    error: state === "failed" ? new ApiError("Restarting", 503, { error: "tenant_app_unavailable" }) : null,
    isPending: state === "paused", isLoading: false });
  const store = createConnectivityStore();
  store.setBrowserOnline(false);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ConnectivityProvider store={store}>
      <CaseHandoffHistory caseId="case-one" />
      <TaskDecisionRecord companyId="company-one" issueId="task-one" viewerId="user-one" />
    </ConnectivityProvider>));
    expect(container.textContent).toContain("Loading handoffs…");
    expect(container.textContent).toContain("Loading decision…");
    expect(container.textContent).not.toContain("No handoffs yet.");
    expect(container.textContent).not.toContain("not available");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally { await act(async () => root.unmount()); store.dispose(); }
});
