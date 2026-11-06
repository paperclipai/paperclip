// @vitest-environment node

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IssueBlockerAttention, IssueRelationIssueSummary, IssueSummary } from "@paperclipai/shared";
import { StatusIcon } from "../StatusIcon";
import { queryKeys } from "@/lib/queryKeys";
import { taskStatusIconProps } from "@/lib/task-status-presentation";
import { TaskChatPresentationProvider } from "./presentation-mode";
import { resolveTaskChatLiveWork, TaskChatLiveWorkLinks } from "./TaskChatBlockerLinks";

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

// The onboarding walk: BRA-1 waits on BRA-2 (running), BRA-3/4 (todo) and
// BRA-5 (blocked on BRA-4, so "covered" in the task list).
const blockers = [
  relation("bra-2", "BRA-2", "in_progress"),
  relation("bra-3", "BRA-3", "todo"),
  relation("bra-4", "BRA-4", "todo"),
  relation("bra-5", "BRA-5", "blocked"),
];

const summaries: IssueSummary[] = blockers.map((blocker) => ({
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

function renderStrip(streamlined: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(
    queryKeys.issues.summaryBatch("company-1", "user-1", blockers.map((blocker) => blocker.id).sort()),
    summaries,
  );
  const liveWork = resolveTaskChatLiveWork(blockers, new Set(["bra-2"]));
  if (!liveWork) throw new Error("expected live work");
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TaskChatPresentationProvider mode={streamlined ? "streamlined" : "production"}>
        <TaskChatLiveWorkLinks liveWork={liveWork} placement="bottom" companyId="company-1" />
      </TaskChatPresentationProvider>
    </QueryClientProvider>,
  );
}

describe("TaskChatLiveWorkLinks status glyphs (BUG-07)", () => {
  for (const streamlined of [true, false]) {
    it(`draws each waiting task with the task list's glyph and colour token (${streamlined ? "streamlined" : "production"})`, () => {
      const html = renderStrip(streamlined);
      const steps = html.split('data-testid="task-chat-live-work-step"').slice(1);
      expect(steps).toHaveLength(4);

      for (const summary of summaries) {
        const step = steps.find((markup) => markup.includes(`>${summary.identifier}<`));
        expect(step, summary.identifier!).toBeDefined();
        const expected = listGlyph(summary);
        expect(glyphToken(step!), summary.identifier!).toBe(glyphToken(expected));
        const expectedLabel = expected.match(/aria-label="([^"]+)"/)?.[1];
        expect(step!, summary.identifier!).toContain(`aria-label="${expectedLabel}"`);
      }
      // BRA-5 is blocked but covered: blue in-queue glyph, never the red blocked one.
      expect(html).toContain("var(--status-task-icon-in_queue)");
      expect(html).not.toContain("var(--status-task-icon-blocked)");
    });
  }
});
