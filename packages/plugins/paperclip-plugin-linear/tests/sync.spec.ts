import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { STATE_KEYS } from "../src/constants.js";
import { syncFromLinear, type IssueLink } from "../src/sync.js";
import type { LinearIssue } from "../src/linear.js";

function makeLink(overrides: Partial<IssueLink> = {}): IssueLink {
  return {
    paperclipIssueId: "pc-1",
    paperclipCompanyId: "comp-1",
    linearIssueId: "lin-1",
    linearIdentifier: "BLO-1",
    linearUrl: "https://linear.app/blockc/issue/BLO-1",
    syncDirection: "bidirectional",
    lastSyncAt: "2026-06-10T00:00:00.000Z",
    lastLinearStateType: "unstarted",
    lastCommentSyncAt: null,
    ...overrides,
  };
}

function makeLinearIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "lin-1",
    identifier: "BLO-1",
    title: "Linear title",
    description: null,
    state: { name: "In Progress", type: "started" },
    priority: 2,
    url: "https://linear.app/blockc/issue/BLO-1",
    assignee: null,
    labels: { nodes: [] },
    project: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("syncFromLinear", () => {
  it("does not push in_progress to an unassigned Paperclip issue", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "Paperclip title",
          status: "todo",
          priority: "low",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
    });

    const update = vi.spyOn(harness.ctx.issues, "update");

    await syncFromLinear(harness.ctx, makeLink(), makeLinearIssue());

    expect(update).toHaveBeenCalledWith(
      "pc-1",
      expect.not.objectContaining({ status: "in_progress" }),
      "comp-1",
    );
    const issue = await harness.ctx.issues.get("pc-1", "comp-1");
    expect(issue).toMatchObject({
      title: "Linear title",
      status: "todo",
      priority: "high",
    });
    expect(harness.getState({
      scopeKind: "instance",
      stateKey: `${STATE_KEYS.linkPrefix}pc-1`,
    })).toMatchObject({ lastLinearStateType: "unstarted" });
  });

  it("retries a skipped in_progress sync when the Linear assignee later maps", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "Paperclip title",
          status: "todo",
          priority: "low",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
    });

    await syncFromLinear(harness.ctx, makeLink(), makeLinearIssue());
    const skippedLink = harness.getState({
      scopeKind: "instance",
      stateKey: `${STATE_KEYS.linkPrefix}pc-1`,
    }) as IssueLink;
    vi.spyOn(harness.ctx.users, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
    });

    await syncFromLinear(
      harness.ctx,
      skippedLink,
      makeLinearIssue({ assignee: { name: "Alice", email: "alice@example.com" } }),
    );

    const issue = await harness.ctx.issues.get("pc-1", "comp-1");
    expect(issue).toMatchObject({
      assigneeUserId: "user-1",
      status: "in_progress",
    });
    expect(harness.getState({
      scopeKind: "instance",
      stateKey: `${STATE_KEYS.linkPrefix}pc-1`,
    })).toMatchObject({ lastLinearStateType: "started" });
  });

  it("pushes in_progress when the Linear assignee maps to a Paperclip user", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        {
          id: "pc-1",
          companyId: "comp-1",
          title: "Paperclip title",
          status: "todo",
          priority: "low",
          assigneeAgentId: null,
          assigneeUserId: null,
        } as never,
      ],
    });
    vi.spyOn(harness.ctx.users, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
    });

    const update = vi.spyOn(harness.ctx.issues, "update");

    await syncFromLinear(
      harness.ctx,
      makeLink(),
      makeLinearIssue({ assignee: { name: "Alice", email: "alice@example.com" } }),
    );

    expect(update).toHaveBeenCalledWith(
      "pc-1",
      expect.objectContaining({ assigneeUserId: "user-1", status: "in_progress" }),
      "comp-1",
    );
    const issue = await harness.ctx.issues.get("pc-1", "comp-1");
    expect(issue).toMatchObject({
      assigneeUserId: "user-1",
      status: "in_progress",
    });
  });
});
