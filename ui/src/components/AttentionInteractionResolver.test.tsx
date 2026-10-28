// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { issuesApi } from "../api/issues";
import { pendingAskUserQuestionsInteraction, pendingRequestConfirmationInteraction } from "../fixtures/issueThreadInteractionFixtures";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";
import { AttentionInteractionResolver } from "./AttentionInteractionResolver";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("../api/issues", () => ({
  issuesApi: { listInteractions: vi.fn(), acceptInteraction: vi.fn() },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("renders question prompts as width-constrained markdown in the decisions resolver", async () => {
  const interaction = {
    ...pendingAskUserQuestionsInteraction,
    payload: {
      version: 1 as const,
      questions: [{
        id: "setup",
        prompt: "**Set up access**\n\n```sh\nvery-long-command --target=https://example.org/a/long/unbroken/path/that/exceeds/a/mobile/viewport\n```",
        selectionMode: "single" as const,
        required: true,
        options: [{ id: "done", label: "Done" }],
      }],
    },
  };
  vi.mocked(issuesApi.listInteractions).mockResolvedValue([interaction]);
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
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const prompt = container.querySelector(`[id="${interaction.id}-setup-prompt"]`);
    expect(prompt).toBeTruthy();
    const body = prompt?.querySelector(".paperclip-markdown");
    expect(body?.className).toContain("min-w-0");
    expect(body?.querySelector("strong")?.textContent).toBe("Set up access");
    expect(body?.querySelector(".paperclip-markdown-codeblock pre")?.textContent).toContain("very-long-command");
    expect(prompt?.textContent).not.toContain("**");
    expect(prompt?.parentElement?.className).toContain("min-w-0");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  }
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
