// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { PipelineStageHistoryPanel } from "./PipelineStageHistoryPanel";

const listDocumentRevisionsMock = vi.hoisted(() => vi.fn());
const restoreDocumentRevisionMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/pipelines", () => ({
  pipelinesApi: {
    listDocumentRevisions: (pipelineId: string, key: string) => listDocumentRevisionsMock(pipelineId, key),
    restoreDocumentRevision: (pipelineId: string, key: string, revisionId: string) =>
      restoreDocumentRevisionMock(pipelineId, key, revisionId),
  },
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const revision = {
  id: "rev-1",
  revisionNumber: 1,
  createdAt: "2026-04-10T00:00:00.000Z",
  changeSummary: "Initial instructions",
  body: "Do the thing.",
};

const revisionsKey = queryKeys.pipelines.documentRevisions("pipeline-1", "stage:review");

describe("PipelineStageHistoryPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listDocumentRevisionsMock.mockResolvedValue([revision]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderOpenPanel(client: QueryClient) {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PipelineStageHistoryPanel
            pipelineId="pipeline-1"
            documentKey="stage:review"
            currentRevisionId={null}
            hasDocument
            onRestored={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    const trigger = container.querySelector("button");
    expect(trigger, "collapsible trigger").toBeTruthy();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("keeps loaded revisions on screen when a refetch fails transiently", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = await renderOpenPanel(client);
    expect(container.textContent).toContain("Revision 1");

    listDocumentRevisionsMock.mockRejectedValue(
      new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" }),
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: revisionsKey });
    });
    await flushReact();

    expect(listDocumentRevisionsMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Revision 1");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).not.toContain("Paperclip is restarting.");
    expect(container.textContent).not.toContain("tenant_app_unavailable");

    await act(async () => root.unmount());
  });

  it("shows readable copy and a Retry button when revisions fail to load", async () => {
    listDocumentRevisionsMock.mockRejectedValueOnce(new ApiError("Boom", 500, { error: "Boom" }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = await renderOpenPanel(client);

    // The inline error shows the readable server message and a Retry button.
    expect(container.querySelector('[data-query-view="error"]')).not.toBeNull();
    expect(container.textContent).toContain("Boom");
    expect(container.textContent).not.toContain("Revision 1");
    const retryButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    expect(retryButton, "Retry button").toBeTruthy();

    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Revision 1");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();

    await act(async () => root.unmount());
  });
});
