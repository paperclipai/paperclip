// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { pendingAskUserQuestionsInteraction } from "../fixtures/issueThreadInteractionFixtures";
import { ThemeProvider } from "../context/ThemeContext";
import { ToastProvider } from "../context/ToastContext";
import { TooltipProvider } from "./ui/tooltip";
import { AttentionQueueRow } from "./AttentionQueueRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: { listInteractions: vi.fn(), acceptInteraction: vi.fn(), rejectInteraction: vi.fn() },
}));

afterEach(() => {
  vi.clearAllMocks();
});

const longCommand =
  "very-long-command --target=https://example.org/a/long/unbroken/path/that/exceeds/a/mobile/viewport";

const interaction = {
  ...pendingAskUserQuestionsInteraction,
  payload: {
    version: 1 as const,
    questions: [{
      id: "setup",
      prompt: `**Set up access**\n\nOpen https://example.org/a/long/unbroken/path/that/exceeds/a/mobile/viewport first.\n\n\`\`\`sh\n${longCommand}\n\`\`\``,
      selectionMode: "single" as const,
      required: true,
      options: [{ id: "done", label: "Done" }],
    }],
  },
};

const item = {
  id: "a1",
  companyId: interaction.companyId,
  sourceKind: "issue_thread_interaction",
  subject: {
    kind: "interaction",
    id: interaction.id,
    companyId: interaction.companyId,
    title: "Set up access",
    identifier: null,
    status: "pending",
    href: `/PAP/issues/${interaction.issueId}#interaction-${interaction.id}`,
    metadata: { kind: "ask_user_questions", issueId: interaction.issueId },
  },
  whyNow: "Questions are waiting for an answer.",
  decisionVerbs: [],
  inlineResolvable: true,
  entryRule: "",
  exitRule: "",
  dedupKey: `interaction:${interaction.id}`,
  dismissalKey: `attention:interaction:${interaction.id}`,
  severity: "high",
  rank: 0,
  activityAt: "2026-07-09T12:00:00Z",
  createdAt: "2026-07-09T12:00:00Z",
  updatedAt: "2026-07-09T12:00:00Z",
  relatedIssue: null,
  project: null,
  workspace: null,
  detail: null,
  dismissal: null,
  expiresAt: null,
  ruleKey: null,
  originAgentName: null,
  queues: [],
  shelf: false,
  retentionDays: 30,
  keep: false,
  archivedAt: null,
  retentionVersion: 1,
  decideBy: null,
  decideByAttribution: null,
  snoozedUntil: null,
  trainingExampleId: null,
} as AttentionItem;

function isRowFlex(element: Element) {
  const classes = element.className.split(/\s+/);
  return classes.includes("flex") && !classes.includes("flex-col");
}

it("keeps a long question prompt shrinkable inside the clipping decisions row", async () => {
  vi.mocked(issuesApi.listInteractions).mockResolvedValue([interaction]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  container.style.width = "320px";
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ToastProvider>
        <QueryClientProvider client={client}>
          <TooltipProvider><ThemeProvider>
            <AttentionQueueRow
              item={item}
              companyId={interaction.companyId}
              expanded
              onToggleExpand={() => {}}
              onDismiss={() => {}}
            />
          </ThemeProvider></TooltipProvider>
        </QueryClientProvider>
      </ToastProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const prompt = container.querySelector(`[id="${interaction.id}-setup-prompt"]`);
    expect(prompt).toBeTruthy();
    const body = prompt?.querySelector(".paperclip-markdown");
    expect(body?.querySelector("strong")?.textContent).toBe("Set up access");
    expect(body?.className).toContain("break-words");
    expect(body?.querySelector(".paperclip-markdown-codeblock pre")?.textContent).toContain(longCommand);
    expect(prompt?.textContent).not.toContain("**");

    const clippingRow = Array.from(container.querySelectorAll(".overflow-hidden"))
      .find((element) => element.className.includes("rounded-xl") && element.contains(prompt!));
    expect(clippingRow).toBeTruthy();

    const unshrinkable: string[] = [];
    for (let element: Element | null = body ?? null; element && element !== clippingRow; element = element.parentElement) {
      const parent = element.parentElement;
      if (parent && isRowFlex(parent) && !element.className.split(/\s+/).includes("min-w-0")) {
        unshrinkable.push(element.outerHTML.slice(0, 120));
      }
    }
    expect(unshrinkable).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  }
});
