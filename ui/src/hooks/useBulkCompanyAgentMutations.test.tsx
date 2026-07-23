// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const listMock = vi.fn();
const pauseMock = vi.fn();
const resumeMock = vi.fn();
const pushToastMock = vi.fn();

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: (...args: unknown[]) => listMock(...args),
    pause: (...args: unknown[]) => pauseMock(...args),
    resume: (...args: unknown[]) => resumeMock(...args),
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

import { useBulkCompanyAgentMutations } from "./useBulkCompanyAgentMutations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Minimal agent shape — only `id` and `status` are read by the hook.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const agent = (id: string, status: string): any => ({ id, status });

let root: ReturnType<typeof createRoot> | null = null;
let api: ReturnType<typeof useBulkCompanyAgentMutations> | null = null;

function Harness({ companyId }: { companyId: string | null }) {
  api = useBulkCompanyAgentMutations(companyId);
  return null;
}

function mount(companyId: string | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(QueryClientProvider, { client }, createElement(Harness, { companyId })),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  api = null;
  vi.clearAllMocks();
});

describe("useBulkCompanyAgentMutations", () => {
  it("pauses only agents that are not paused/terminated/pending_approval", async () => {
    listMock.mockResolvedValue([
      agent("a1", "active"),
      agent("a2", "active"),
      agent("a3", "paused"),
      agent("a4", "terminated"),
      agent("a5", "pending_approval"),
    ]);
    pauseMock.mockResolvedValue({});
    mount("co-1");

    let count = 0;
    await act(async () => {
      count = await api!.bulkPause.mutateAsync();
    });

    expect(count).toBe(2);
    expect(pauseMock).toHaveBeenCalledTimes(2);
    expect(pauseMock).toHaveBeenCalledWith("a1", "co-1");
    expect(pauseMock).toHaveBeenCalledWith("a2", "co-1");
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success", title: "Paused 2 agents" }),
    );
  });

  it("resumes only paused agents", async () => {
    listMock.mockResolvedValue([agent("a1", "active"), agent("a3", "paused")]);
    resumeMock.mockResolvedValue({});
    mount("co-1");

    let count = 0;
    await act(async () => {
      count = await api!.bulkResume.mutateAsync();
    });

    expect(count).toBe(1);
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).toHaveBeenCalledWith("a3", "co-1");
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success", title: "Resumed 1 agent" }),
    );
  });

  it("throws and surfaces an error toast when a pause fails", async () => {
    listMock.mockResolvedValue([agent("a1", "active"), agent("a2", "active")]);
    pauseMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("boom"));
    mount("co-1");

    let err: Error | null = null;
    await act(async () => {
      try {
        await api!.bulkPause.mutateAsync();
      } catch (e) {
        err = e as Error;
      }
    });

    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/failed to pause/);
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("no-ops without calling the API when companyId is null", async () => {
    mount(null);

    let count = 0;
    await act(async () => {
      count = await api!.bulkPause.mutateAsync();
    });

    expect(count).toBe(0);
    expect(listMock).not.toHaveBeenCalled();
  });
});
