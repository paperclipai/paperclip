import type { Express } from "express";
import request from "supertest";
import { expect, it, type Mock } from "vitest";

export function makeIssue(
  status:
    | "backlog"
    | "todo"
    | "done"
    | "blocked"
    | "cancelled"
    | "in_progress"
    | "in_review",
) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Comment reopen default",
  };
}

export function makeIssueUpdateReceipt(
  existing: ReturnType<typeof makeIssue>,
  patch: Record<string, unknown>,
) {
  const fields = Object.fromEntries(
    Object.entries(patch).filter(
      ([key]) => key !== "actorAgentId" && key !== "actorUserId",
    ),
  );
  const changes = Object.fromEntries(
    Object.entries(fields)
      .filter(
        ([key, value]) =>
          !Object.is(existing[key as keyof typeof existing], value),
      )
      .map(([key, value]) => [
        key,
        { from: existing[key as keyof typeof existing], to: value },
      ]),
  );
  return { ...existing, ...fields, changes };
}

export function createScheduledRetry() {
  return {
    runId: "retry-run-1",
    status: "scheduled_retry",
    agentId: "22222222-2222-4222-8222-222222222222",
    agentName: "CodexCoder",
    retryOfRunId: "source-run-1",
    scheduledRetryAt: new Date("2026-05-18T14:00:00.000Z"),
    scheduledRetryAttempt: 1,
    scheduledRetryReason: "transient_failure",
    error: null,
    errorCode: null,
  };
}

export function registerNoWakeRouteTests({ mockHeartbeatService, mockIssueService, createApp, installActor, waitForWakeup }: {
  mockHeartbeatService: { wakeup: Mock; cancelRun: Mock };
  mockIssueService: { getById: Mock; getCurrentScheduledRetry: Mock; update: Mock; addComment: Mock };
  createApp: () => Express;
  installActor: (app: Express) => Promise<Express>;
  waitForWakeup: (assertion: () => void) => Promise<void>;
}) {
  it.each(["post", "patch"] as const)("keeps marked %s comments informational on blocked, closed, and retrying issues", async method => {
    for (const status of ["blocked", "done", "cancelled", "in_progress"] as const) {
      mockHeartbeatService.wakeup.mockClear();
      mockHeartbeatService.cancelRun.mockClear();
      mockIssueService.update.mockClear();
      const issue = { ...makeIssue(status), executionRunId: status === "in_progress" ? "retry-run-1" : null };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.getCurrentScheduledRetry.mockResolvedValue(createScheduledRetry());
      mockIssueService.update.mockImplementation(async (_id, patch) => makeIssueUpdateReceipt(issue, patch));
      const app = await installActor(createApp());
      const response = method === "post"
        ? await request(app).post(`/api/issues/${issue.id}/comments`).send({ body: "  [NO-WAKE] Information only" })
        : await request(app).patch(`/api/issues/${issue.id}`).send({ comment: "  [NO-WAKE] Information only" });
      expect(response.status).toBe(method === "post" ? 201 : 200);
      expect(mockIssueService.addComment).toHaveBeenCalled();
      expect(mockIssueService.update.mock.calls.every(call => call[1].status == null || call[1].status === status)).toBe(true);
      expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    }
  });

  it.each(["post", "patch"] as const)("honors explicit resume and reopen on marked %s comments", async method => {
    for (const intent of ["resume", "reopen"] as const) {
      mockHeartbeatService.wakeup.mockClear();
      const issue = makeIssue("done");
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id, patch) => makeIssueUpdateReceipt(issue, patch));
      const app = await installActor(createApp());
      const response = method === "post"
        ? await request(app).post(`/api/issues/${issue.id}/comments`).send({ body: "[no-wake] Continue", [intent]: true })
        : await request(app).patch(`/api/issues/${issue.id}`).send({ comment: "[no-wake] Continue", [intent]: true });
      expect(response.status).toBe(method === "post" ? 201 : 200);
      await waitForWakeup(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalled());
      expect(mockIssueService.update.mock.calls.some(call => call[1].status === "todo")).toBe(true);
    }
  });

}
