// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  issueThreadInteractionFixtureMeta,
  pendingGroupedSecretProposalInteraction,
} from "../fixtures/issueThreadInteractionFixtures";
import { AttentionInteractionResolver } from "./AttentionInteractionResolver";

const issuesApiMocks = vi.hoisted(() => ({
  listInteractions: vi.fn(),
  acceptInteraction: vi.fn(),
}));

const connectionIntentsApiMocks = vi.hoisted(() => ({
  setupOptions: vi.fn(),
  complete: vi.fn(),
  decline: vi.fn(),
}));

vi.mock("../api/issues", () => ({ issuesApi: issuesApiMocks }));
vi.mock("@/api/connection-intents", () => ({
  connectionIntentsApi: connectionIntentsApiMocks,
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GROUPED_BINDING_IDS = pendingGroupedSecretProposalInteraction.payload.secretProposal!
  .bindings!.map((binding) => binding.proposalId);

describe("AttentionInteractionResolver", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    issuesApiMocks.listInteractions.mockReset();
    issuesApiMocks.acceptInteraction.mockReset();
    issuesApiMocks.listInteractions.mockResolvedValue([
      pendingGroupedSecretProposalInteraction,
    ]);
    issuesApiMocks.acceptInteraction.mockResolvedValue(
      pendingGroupedSecretProposalInteraction,
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderResolver() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ThemeProvider>
              <AttentionInteractionResolver
                companyId={issueThreadInteractionFixtureMeta.companyId}
                issueId={issueThreadInteractionFixtureMeta.issueId}
                interactionId={pendingGroupedSecretProposalInteraction.id}
              />
            </ThemeProvider>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
  }

  async function waitFor(predicate: () => boolean, attempts = 40): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (predicate()) return;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    throw new Error("waitFor predicate did not become true");
  }

  /**
   * The card is only half the path: the queue's own accept handler has to carry
   * the cleared bindings to the API. A handler that declares fewer parameters
   * than the callback type drops the fifth argument in silence, which approves
   * every binding the approver just refused.
   */
  it("sends the bindings a human cleared on the card to the accept route", async () => {
    renderResolver();
    await waitFor(() => container.textContent?.includes("Bindings (3)") === true);

    const checkboxes = Array.from(
      container.querySelectorAll<HTMLElement>('[role="checkbox"]'),
    );
    expect(checkboxes).toHaveLength(3);
    await act(async () => {
      checkboxes[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const approve = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Create bindings"),
    );
    expect(approve).toBeTruthy();
    await act(async () => {
      approve?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => issuesApiMocks.acceptInteraction.mock.calls.length > 0);
    expect(issuesApiMocks.acceptInteraction).toHaveBeenCalledWith(
      issueThreadInteractionFixtureMeta.issueId,
      pendingGroupedSecretProposalInteraction.id,
      expect.objectContaining({ rejectProposalIds: [GROUPED_BINDING_IDS[1]] }),
    );
  });

  it("sends no rejection list when the human keeps every binding", async () => {
    renderResolver();
    await waitFor(() => container.textContent?.includes("Bindings (3)") === true);

    const approve = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Create bindings"),
    );
    await act(async () => {
      approve?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => issuesApiMocks.acceptInteraction.mock.calls.length > 0);
    const options = issuesApiMocks.acceptInteraction.mock.calls[0]?.[2] as {
      rejectProposalIds?: string[];
    };
    expect(options.rejectProposalIds).toBeUndefined();
  });
});
