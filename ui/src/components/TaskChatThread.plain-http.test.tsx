// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskChatThread, type TaskChatThreadProps } from "./TaskChatThread";

vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({ transcriptByRun: new Map(), isInitialHydrating: false }),
}));
vi.mock("@/components/transcript/useNativeRunTranscripts", () => ({
  useNativeRunTranscripts: () => ({ transcriptByRun: new Map(), errorsByRun: new Map(), terminalHydratedRunIds: new Set() }),
}));
vi.mock("@/hooks/useIssuePlanDocument", () => ({ useIssuePlanDocument: () => ({ data: null }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: false, loaded: true, userId: "viewer" }),
}));
vi.mock("@/components/coordinator/CoordinatorChatTaskHandoffs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/coordinator/CoordinatorChatTaskHandoffs")>()),
  useCoordinatorChatTaskHandoffs: () => ({ handoffs: [], isSuccess: true, enabled: false }),
}));
vi.mock("@/components/coordinator/CoordinatorChatDecisionReceipts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/coordinator/CoordinatorChatDecisionReceipts")>()),
  useCoordinatorChatDecisionReceipts: () => ({ receipts: [], enabled: false }),
}));
vi.mock("@/components/coordinator/CoordinatorChatPendingQuestions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/coordinator/CoordinatorChatPendingQuestions")>()),
  useCoordinatorChatPendingQuestions: () => ({ questions: [], enabled: false }),
}));
vi.mock("@/api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/issues")>()),
  issuesApi: { summaries: vi.fn(async () => []) },
}));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/issues/chat", hash: "", search: "", key: "test", state: null }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("./task-chat/TaskChatComposer", () => ({
  TaskChatComposer: ({ onAdd }: { onAdd: (body: string) => Promise<void> }) => (
    <button type="button" data-testid="plain-http-send" onClick={() => void onAdd("Ship the note")}>Send</button>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("TaskChatThread plain HTTP", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const randomValues = crypto.getRandomValues.bind(crypto);

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    client.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("assigns a request id when the sender omits one and randomUUID is missing", async () => {
    const onAdd = vi.fn<TaskChatThreadProps["onAdd"]>(async () => {});
    await act(() => root.render(
      <QueryClientProvider client={client}>
        <TaskChatThread issueId="chat" currentUserId="viewer" comments={[]} onAdd={onAdd} />
      </QueryClientProvider>,
    ));
    vi.stubGlobal("crypto", { getRandomValues: randomValues });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="plain-http-send"]')!.click();
    });

    expect(onAdd).toHaveBeenCalledOnce();
    const [body, , , , requestId] = onAdd.mock.calls[0] ?? [];
    expect(body).toBe("Ship the note");
    expect(requestId).toMatch(REQUEST_ID);
  });
});
