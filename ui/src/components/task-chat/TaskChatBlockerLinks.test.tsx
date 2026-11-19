// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISSUE_SUMMARIES_MAX_IDS,
  type IssueBlockerAttention,
  type IssueRelationIssueSummary,
  type IssueSummary,
} from "@paperclipai/shared";
import { StatusIcon } from "../StatusIcon";
import { taskStatusIconProps } from "@/lib/task-status-presentation";
import { TaskChatPresentationProvider } from "./presentation-mode";
import { resolveTaskChatLiveWork, TaskChatLiveWorkLinks } from "./TaskChatBlockerLinks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockSummaries = vi.hoisted(() => vi.fn());

vi.mock("@/api/issues", () => ({
  issuesApi: { summaries: mockSummaries },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: false, userId: "user-1" }),
}));

const covered: IssueBlockerAttention = {
  state: "covered",
  reason: "active_dependency",
  unresolvedBlockerCount: 1,
  coveredBlockerCount: 1,
  stalledBlockerCount: 0,
  attentionBlockerCount: 0,
  sampleBlockerIdentifier: null,
  sampleStalledBlockerIdentifier: null,
};

function relation(id: string, identifier: string, status: IssueRelationIssueSummary["status"]): IssueRelationIssueSummary {
  return { id, identifier, title: `Task ${identifier}`, status, priority: "medium", assigneeAgentId: "agent-1", assigneeUserId: null };
}

// The onboarding walk: BRA-1 waits on BRA-2 (running), todo tasks and
// blocked tasks that are "covered" in the task list. Six steps plus a live
// terminal blocker; every summaries request stays within the endpoint limit.
const terminal = relation("bra-9", "BRA-9", "in_progress");
const blockers = [
  { ...relation("bra-2", "BRA-2", "in_progress"), terminalBlockers: [terminal] },
  relation("bra-3", "BRA-3", "todo"),
  relation("bra-4", "BRA-4", "todo"),
  relation("bra-5", "BRA-5", "blocked"),
  relation("bra-6", "BRA-6", "todo"),
  relation("bra-7", "BRA-7", "blocked"),
];

const summaries: IssueSummary[] = [...blockers, terminal].map((blocker) => ({
  id: blocker.id,
  companyId: "company-1",
  title: blocker.title,
  identifier: blocker.identifier,
  status: blocker.status,
  updatedAt: new Date("2026-11-06T00:00:00Z"),
  externalConversationState: null,
  ...(blocker.status === "blocked" ? { blockerAttention: covered } : {}),
}));

function listGlyph(summary: IssueSummary) {
  return renderToStaticMarkup(<StatusIcon {...taskStatusIconProps(summary)} />);
}

function glyphToken(markup: string): string | null {
  return markup.match(/var\((--status-task-icon-[a-z_]+)\)/)?.[1] ?? null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockSummaries.mockReset();
  mockSummaries.mockImplementation(async (_companyId: string, ids: readonly string[]) => {
    if (ids.length > ISSUE_SUMMARIES_MAX_IDS) throw new Error("Too many issue summary IDs");
    return summaries.filter((summary) => ids.includes(summary.id));
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderStrip(streamlined: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const liveWork = resolveTaskChatLiveWork(blockers, new Set(["bra-2", "bra-9"]));
  if (!liveWork) throw new Error("expected live work");
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TaskChatPresentationProvider mode={streamlined ? "streamlined" : "production"}>
          <TaskChatLiveWorkLinks liveWork={liveWork} placement="bottom" companyId="company-1" />
        </TaskChatPresentationProvider>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => {
    expect(container.innerHTML).not.toContain("var(--status-task-icon-blocked)");
  });
  return container.innerHTML;
}

describe("TaskChatLiveWorkLinks status glyphs (BUG-07)", () => {
  for (const streamlined of [true, false]) {
    it(`draws each waiting task with the task list's glyph and colour token (${streamlined ? "streamlined" : "production"})`, async () => {
      const html = await renderStrip(streamlined);
      const steps = [...container.querySelectorAll('[data-testid="task-chat-live-work-step"]')].map((step) => step.outerHTML);
      expect(steps).toHaveLength(blockers.length);

      for (const summary of summaries.filter((candidate) => candidate.id !== terminal.id)) {
        const step = steps.find((markup) => markup.includes(`>${summary.identifier}<`));
        expect(step, summary.identifier!).toBeDefined();
        const expected = listGlyph(summary);
        expect(glyphToken(step!), summary.identifier!).toBe(glyphToken(expected));
        const expectedLabel = expected.match(/aria-label="([^"]+)"/)?.[1];
        expect(step!, summary.identifier!).toContain(`aria-label="${expectedLabel}"`);
      }

      // The live terminal blocker ("Now running") draws the shared glyph too.
      const nowRunning = [...container.querySelectorAll("a")].find((link) => link.textContent?.includes("BRA-9"));
      const nowRunningRow = (streamlined ? nowRunning : nowRunning?.parentElement)?.outerHTML ?? "";
      expect(glyphToken(nowRunningRow)).toBe(glyphToken(listGlyph(summaries.at(-1)!)));

      // Blocked-but-covered tasks: blue in-queue glyph, never the red blocked one.
      expect(html).toContain("var(--status-task-icon-in_queue)");
      expect(html).not.toContain("var(--status-task-icon-blocked)");
      // Every request stays within the summaries endpoint limit.
      for (const [, ids] of mockSummaries.mock.calls) {
        expect((ids as string[]).length).toBeLessThanOrEqual(ISSUE_SUMMARIES_MAX_IDS);
      }
    });
  }
});
