// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { DEPLOY_AUTHORIZATION_ISSUED_EVENT, issuesApi } from "./issues";

describe("issuesApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.get.mockResolvedValue([]);
    mockApi.post.mockResolvedValue({});
  });

  it("passes parentId through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { parentId: "issue-parent-1", limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?parentId=issue-parent-1&limit=25",
    );
  });

  it("passes descendantOf through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { descendantOf: "issue-root-1", includeBlockedBy: true, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?descendantOf=issue-root-1&includeBlockedBy=true&limit=25",
    );
  });

  it("passes generic workspaceId filters through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { workspaceId: "workspace-1", limit: 1000 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?workspaceId=workspace-1&limit=1000",
    );
  });

  it("passes pagination offsets through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { limit: 500, offset: 1500 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?limit=500&offset=1500",
    );
  });

  it("passes issue list sort options through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      limit: 500,
      sortField: "updated",
      sortDir: "desc",
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?limit=500&sortField=updated&sortDir=desc",
    );
  });

  it("requests the compact issue list view explicitly", async () => {
    await issuesApi.listCompact("company-1", {
      touchedByUserId: "me",
      includeLiveDescendantSummary: true,
      limit: 100,
      sortField: "updated",
      sortDir: "desc",
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?touchedByUserId=me&includeLiveDescendantSummary=true&limit=100&sortField=updated&sortDir=desc&view=compact",
    );
  });

  it("passes plan document filters through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { hasPlanDocument: false, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?hasPlanDocument=false&limit=25",
    );
  });

  it("passes live descendant summary opt-in through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { includeLiveDescendantSummary: true, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?includeLiveDescendantSummary=true&limit=25",
    );
  });

  it("posts recovery action resolution to the source issue endpoint", async () => {
    await issuesApi.resolveRecoveryAction("issue-1", {
      actionId: "00000000-0000-0000-0000-0000000000aa",
      outcome: "restored",
      sourceIssueStatus: "done",
    });

    expect(mockApi.post).toHaveBeenCalledWith(
      "/issues/issue-1/recovery-actions/resolve",
      {
        actionId: "00000000-0000-0000-0000-0000000000aa",
        outcome: "restored",
        sourceIssueStatus: "done",
      },
    );
  });

  it("surfaces a one-time deploy authorization and returns the accepted interaction", async () => {
    const interaction = {
      id: "interaction-1",
      companyId: "company-1",
      issueId: "issue-1",
      kind: "request_confirmation",
      status: "accepted",
    };
    const deployAuthorization = {
      id: "authorization-1",
      candidateId: "candidate-1",
      token: "one-time-secret-token",
      tokenReturnedOnce: true,
      alreadyIssued: false,
      targetHost: "srv1749248",
      imageDigest: "ghcr.io/backbond/scanner@sha256:abc",
      environment: "production",
      sequence: 21,
      expiresAt: "2026-07-21T00:00:00.000Z",
    };
    mockApi.post.mockResolvedValue({ interaction, deployAuthorization });
    const listener = vi.fn();
    window.addEventListener(DEPLOY_AUTHORIZATION_ISSUED_EVENT, listener);

    const result = await issuesApi.acceptInteraction("issue-1", "interaction-1");

    expect(result).toBe(interaction);
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(deployAuthorization);
    window.removeEventListener(DEPLOY_AUTHORIZATION_ISSUED_EVENT, listener);
  });

  it("does not emit an event when an authorization token was already issued", async () => {
    const interaction = { id: "interaction-1" };
    mockApi.post.mockResolvedValue({
      interaction,
      deployAuthorization: { token: null, tokenReturnedOnce: false },
    });
    const listener = vi.fn();
    window.addEventListener(DEPLOY_AUTHORIZATION_ISSUED_EVENT, listener);

    expect(await issuesApi.acceptInteraction("issue-1", "interaction-1")).toBe(interaction);
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(DEPLOY_AUTHORIZATION_ISSUED_EVENT, listener);
  });
});
