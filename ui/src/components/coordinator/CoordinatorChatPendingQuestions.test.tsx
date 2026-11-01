// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatorChatPendingQuestion, CoordinatorChatQuestionStatus, useCoordinatorChatPendingQuestions } from "./CoordinatorChatPendingQuestions";
import { coordinatorTaskQuestion, coordinatorTaskQuestionAttention } from "@/fixtures/coordinatorTaskQuestion";
import { queryKeys } from "@/lib/queryKeys";
import { ThemeProvider } from "@/context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({ get: vi.fn(), detach: vi.fn(), list: vi.fn(), answer: vi.fn(), viewer: "user-board", enabled: true }));
vi.mock("@/api/client", () => ({ api: { get: mocks.get }, detachInflightGet: mocks.detach }));
vi.mock("@/api/issues", () => ({ issuesApi: { listInteractions: mocks.list, respondToInteraction: mocks.answer } }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: mocks.enabled, userId: mocks.viewer }) }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root; let client: QueryClient;
function Chat({ conversation = true }: { conversation?: boolean }) {
  const query = useCoordinatorChatPendingQuestions("chat", conversation);
  return <><CoordinatorChatQuestionStatus query={query} />{query.questions.map(item => <CoordinatorChatPendingQuestion key={item.id} item={item} />)}</>;
}
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
async function paint(conversation = true) {
  await act(() => root.render(<QueryClientProvider client={client}><TooltipProvider><ThemeProvider><Chat conversation={conversation} /></ThemeProvider></TooltipProvider></QueryClientProvider>));
  await flush(); await flush();
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.viewer = "user-board"; mocks.enabled = true;
  mocks.get.mockResolvedValue([coordinatorTaskQuestionAttention]); mocks.list.mockResolvedValue([coordinatorTaskQuestion]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); client.clear(); });

describe("pending task questions in agent chat", () => {
  it("keeps Classic and ordinary task threads free of additional projection requests", async () => {
    await paint(false); expect(mocks.get).not.toHaveBeenCalled();
    mocks.enabled = false; await paint(); expect(mocks.get).not.toHaveBeenCalled();
  });
  it("answers the canonical task question and refreshes all decision surfaces", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await paint();
    expect(host.textContent).toContain("Mira needs your input on Write the launch post.");
    expect(host.querySelector("a")?.getAttribute("href")).toBe(`/issues/PAPER-102#interaction-${coordinatorTaskQuestion.id}`);
    const resolved = { ...coordinatorTaskQuestion, status: "answered", resolvedAt: new Date(), result: { version: 1, answers: [{ questionId: "audience", optionIds: ["operators"] }] } };
    mocks.answer.mockImplementation(async () => { mocks.list.mockResolvedValue([resolved]); mocks.get.mockResolvedValue([]); return resolved; });
    await act(() => host.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
    await act(() => [...host.querySelectorAll("button")].find(button => button.textContent === "Confirm audience")!.click());
    await flush(); await flush();
    expect(mocks.answer).toHaveBeenCalledWith(coordinatorTaskQuestion.issueId, coordinatorTaskQuestion.id, expect.objectContaining({ answers: expect.any(Array) }));
    expect(host.querySelector("[data-testid=coordinator-chat-pending-question]")).toBeNull();
    for (const queryKey of [queryKeys.attention(coordinatorTaskQuestion.companyId), ["issues", "pending-questions"], ["issues", "decision-receipts"]]) expect(invalidate).toHaveBeenCalledWith({ queryKey });
  });
  it("drops cached questions after authorization loss and separates viewers", async () => {
    await paint(); expect(host.textContent).toContain("Who is the primary reader?");
    mocks.get.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    await act(() => client.invalidateQueries({ queryKey: ["issues", "pending-questions"] })); await flush();
    expect(host.querySelector("[data-testid=coordinator-chat-pending-question]")).toBeNull();
    expect(host.textContent).toContain("Task questions couldn’t load.");
    mocks.viewer = "another-viewer"; mocks.get.mockResolvedValue([]); await paint();
    expect(host.textContent).not.toContain("Who is the primary reader?");
    expect(mocks.get).toHaveBeenCalledWith("/issues/chat/pending-questions", expect.objectContaining({ cache: "no-store" }));
  });
});
