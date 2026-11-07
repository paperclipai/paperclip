import type { Express } from "express";
import request from "supertest";
import { describe, expect, it, type Mock } from "vitest";

export function registerInteractionLocationTests({ mockInteractionService, mockIssueService, mockAccessDecide, createApp, createIssue, ISSUE_ID, ASSIGNEE_AGENT_ID }: {
  mockInteractionService: { getById: Mock };
  mockIssueService: { getById: Mock };
  mockAccessDecide: Mock;
  createApp: (actor?: { type: string; userId: string; companyIds: string[]; source: string; isInstanceAdmin: boolean }) => Promise<Express>;
  createIssue: (patch: { status: string; assigneeAgentId: string }) => unknown;
  ISSUE_ID: string;
  ASSIGNEE_AGENT_ID: string;
}) {
  describe("interaction location route", () => {
  const INTERACTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  it("returns the fixed v1 location for a readable card", async () => {
    mockInteractionService.getById.mockResolvedValueOnce({ id: INTERACTION_ID, companyId: "company-1", issueId: ISSUE_ID, status: "pending" });
    mockIssueService.getById.mockResolvedValue(createIssue({ status: "in_review", assigneeAgentId: ASSIGNEE_AGENT_ID }));
    const res = await request(await createApp()).get(`/api/companies/company-1/interaction-locations/${INTERACTION_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: 1, companyId: "company-1", interactionId: INTERACTION_ID, issueId: ISSUE_ID });
  });

  it("answers 404 for an unknown or malformed id and for another company's card", async () => {
    mockInteractionService.getById.mockResolvedValueOnce(null);
    await request(await createApp()).get(`/api/companies/company-1/interaction-locations/${INTERACTION_ID}`).expect(404);
    await request(await createApp()).get("/api/companies/company-1/interaction-locations/not-a-uuid").expect(404);
    mockInteractionService.getById.mockResolvedValueOnce({ id: INTERACTION_ID, companyId: "company-2", issueId: ISSUE_ID, status: "pending" });
    await request(await createApp()).get(`/api/companies/company-1/interaction-locations/${INTERACTION_ID}`).expect(404);
  });

  it("normalizes a padded identifier before database access", async () => {
    mockInteractionService.getById.mockResolvedValue({ id: INTERACTION_ID, companyId: "company-1", issueId: ISSUE_ID });
    const res = await request(await createApp()).get(`/api/companies/company-1/interaction-locations/%20${INTERACTION_ID}%20`);
    expect(res.status).toBe(200);
    expect(mockInteractionService.getById).toHaveBeenCalledWith(INTERACTION_ID);
  });

  it("hides the location when issue read access is denied", async () => {
    mockInteractionService.getById.mockResolvedValue({ id: INTERACTION_ID, companyId: "company-1", issueId: ISSUE_ID });
    mockAccessDecide.mockResolvedValue({ allowed: false, action: "issue:read", reason: "deny_issue_private", explanation: "Private issue" });
    const res = await request(await createApp()).get(`/api/companies/company-1/interaction-locations/${INTERACTION_ID}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    expect(mockAccessDecide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read" }));
  });

  it("refuses a board actor without access to the company", async () => {
    const res = await request(await createApp({ type: "board", userId: "u", companyIds: ["company-9"], source: "session", isInstanceAdmin: false }))
      .get(`/api/companies/company-1/interaction-locations/${INTERACTION_ID}`);
    expect(res.status).toBe(403);
  });
});

}
