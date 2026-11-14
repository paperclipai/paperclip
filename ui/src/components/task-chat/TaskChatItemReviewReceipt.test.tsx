// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/context/ThemeContext";
import { completeRequestItemVerdictsInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { TaskChatInteractionCard } from "./TaskChatInteractionCard";

const preference = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => preference }));

describe("completed item-review receipts", () => {
  it.each([false, true])("retains inspectable verdicts and reasons with Coordinator enabled=%s", enabled => {
    preference.enabled = enabled;
    const interaction = completeRequestItemVerdictsInteraction;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      flushSync(() => root.render(<TooltipProvider><ThemeProvider>
        <TaskChatInteractionCard presentation="timeline" item={{ id: `interaction:${interaction.id}`, kind: "interaction", interaction }} />
      </ThemeProvider></TooltipProvider>));
      const disclosure = host.querySelector<HTMLDetailsElement>('details[data-testid="task-chat-interaction-receipt"]');
      expect(disclosure).not.toBeNull();
      expect(disclosure!.open).toBe(false);
      disclosure!.querySelector("summary")!.click();
      expect(disclosure!.open).toBe(true);
      for (const result of interaction.result!.items) {
        const label = interaction.payload.items.find(item => item.id === result.id)!.label;
        const row = [...disclosure!.querySelectorAll("li")].find(item => item.textContent?.includes(label));
        expect(row?.textContent).toContain(result.verdict);
        if (result.reason) expect(row?.textContent).toContain(result.reason);
      }
      expect(host.querySelector('a[href^="#comment-interaction-response:"]')).toBeNull();
    } finally {
      flushSync(() => root.unmount());
      host.remove();
    }
  });
});
