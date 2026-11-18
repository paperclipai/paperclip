// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { issuesApi } from "../api/issues";
import { pendingAskUserQuestionsInteraction, pendingRequestConfirmationInteraction, pendingRequestItemVerdictsInteraction } from "../fixtures/issueThreadInteractionFixtures";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";
import type { AttentionItem, AskUserQuestionsInteraction } from "@paperclipai/shared";
import { AttentionForOtherGate } from "./AttentionCloseMenu";
import { AttentionInteractionResolver } from "./AttentionInteractionResolver";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("../api/issues", () => ({
  issuesApi: { listInteractions: vi.fn(), respondToInteraction: vi.fn(), acceptInteraction: vi.fn(), submitInteractionVerdicts: vi.fn() },
}));

vi.mock("./task-chat/TaskChatRichInput", () => ({
  TaskChatRichInput: ({ value, onSubmit }: { value: string; onSubmit(): void }) =>
    <textarea aria-label="Answer" readOnly value={value} onKeyDown={event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) onSubmit();
    }} />,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("passes the canonical pending status back after a partial item review", async () => {
  const interaction = pendingRequestItemVerdictsInteraction;
  const partial = { ...interaction, status: "pending" as const, result: { version: 1 as const, outcome: "resolved" as const,
    complete: false, items: [{ id: interaction.payload.items[0]!.id, verdict: "approve" as const, resolvedAt: new Date().toISOString() }] } };
  vi.mocked(issuesApi.listInteractions).mockResolvedValue([interaction]);
  vi.mocked(issuesApi.submitInteractionVerdicts).mockResolvedValue(partial);
  const onResolved = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><ThemeProvider>
      <AttentionInteractionResolver companyId={interaction.companyId} issueId={interaction.issueId} interactionId={interaction.id} onResolved={onResolved} />
    </ThemeProvider></TooltipProvider></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => host.querySelector<HTMLButtonElement>('button[data-verdict="approve"]')!.click());
    const apply = [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("Apply"));
    expect(apply).toBeTruthy();
    await act(async () => apply!.click());
    expect(onResolved).toHaveBeenCalledWith(partial);
  } finally { await act(async () => root.unmount()); host.remove(); client.clear(); }
});

it("refreshes a preparing approval automatically, then stops polling without accepting it", async () => {
  vi.useFakeTimers();
  const interaction = pendingRequestConfirmationInteraction;
  vi.mocked(issuesApi.listInteractions)
    .mockResolvedValueOnce([{ ...interaction, acceptanceBlocker: "workspace_sync_pending" }])
    .mockResolvedValue([interaction]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider><ThemeProvider>
          <AttentionInteractionResolver
            companyId={interaction.companyId}
            issueId={interaction.issueId}
            interactionId={interaction.id}
          />
        </ThemeProvider></TooltipProvider>
      </QueryClientProvider>,
    ));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const approve = () => container.querySelector<HTMLButtonElement>('[data-testid="confirmation-actions"] button')!;
    expect(approve().disabled).toBe(true);
    expect(container.textContent).toContain("Preparing approval…");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_001); });
    expect(issuesApi.listInteractions).toHaveBeenCalledTimes(2);
    expect(approve().disabled).toBe(false);
    expect(container.textContent).not.toContain("Preparing approval…");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(issuesApi.listInteractions).toHaveBeenCalledTimes(2);
    expect(issuesApi.acceptInteraction).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  }
});


it.each(["ctrlKey", "metaKey"] as const)("confirms another person's keyboard answer before sending (%s)", async (modifier) => {
  const interaction: AskUserQuestionsInteraction = { ...pendingAskUserQuestionsInteraction,
    id: `keyboard-${modifier}`, addresseeUserId: "dotta", payload: { version: 1, questions: [{ id: "answer", prompt: "What should we ship?", selectionMode: "single", options: [{ id: "text", label: "Write an answer", freeText: true }], allowOther: false }], questionSet: {
      schema: "paperclip.question_set.v1", questions: [{ id: "answer", prompt: "What should we ship?", required: true,
        answerMode: "text", initialText: "My draft answer" }],
    } } };
  vi.mocked(issuesApi.listInteractions).mockResolvedValue([interaction]);
  vi.mocked(issuesApi.respondToInteraction).mockResolvedValue({ ...interaction, status: "answered" });
  const item = { id: "keyboard-card", audience: { kind: "user", userId: "dotta", reason: "addressee" } } as AttentionItem;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const click = async (label: string) => act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === label)!.click());
  const sendShortcut = async () => act(async () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", [modifier]: true, bubbles: true })));
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><ThemeProvider>
      <AttentionForOtherGate item={item} currentUserId="scott" userLabelMap={new Map([["dotta", "Dotta"]])}>
        <AttentionInteractionResolver companyId={interaction.companyId} issueId={interaction.issueId} interactionId={interaction.id} currentUserId="scott" />
      </AttentionForOtherGate>
    </ThemeProvider></TooltipProvider></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await sendShortcut();
    expect(issuesApi.respondToInteraction).not.toHaveBeenCalled();
    expect(host.textContent).toContain("This is for @Dotta. Continue?");
    await click("Cancel");
    expect(issuesApi.respondToInteraction).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")!.value).toBe("My draft answer");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain("Action cancelled");
    await sendShortcut();
    expect(issuesApi.respondToInteraction).not.toHaveBeenCalled();
    await click("Continue");
    expect(issuesApi.respondToInteraction).toHaveBeenCalledExactlyOnceWith(interaction.issueId, interaction.id,
      { answers: [{ questionId: "answer", optionIds: [], otherText: "My draft answer" }] });
  } finally { await act(async () => root.unmount()); host.remove(); client.clear(); }
});
