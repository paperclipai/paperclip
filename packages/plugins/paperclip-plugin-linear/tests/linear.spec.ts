import { describe, it, expect, vi } from "vitest";
import {
  attachmentLinkURL,
  ensureProjectLink,
  listIssuesByIds,
  listOpenIssues,
  markDuplicate,
} from "../src/linear.js";

// gql() (linear.ts:222) calls fetch(LINEAR_API, {..., body: JSON.stringify({query, variables})}),
// checks res.ok, then res.json() -> { data, errors }. Mock that contract.
function mockFetch(jsonResponses: unknown[]) {
  const fn = vi.fn();
  for (const r of jsonResponses) {
    fn.mockResolvedValueOnce({ ok: true, json: async () => r });
  }
  return fn as unknown as typeof fetch;
}

describe("markDuplicate", () => {
  it("creates a duplicate relation dupe -> keeper when none exists", async () => {
    const fetch = mockFetch([
      { data: { issue: { relations: { nodes: [] } } } },
      { data: { issueRelationCreate: { success: true, issueRelation: { id: "rel-1" } } } },
    ]);
    const res = await markDuplicate(fetch, "tok", "dupe-id", "keeper-id");
    expect(res).toEqual({ success: true, issueRelationId: "rel-1", alreadyRelated: false });
    const precheckBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(precheckBody.query).toContain("query IssueRelations($id: String!)");
    const mutationBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(mutationBody.variables).toEqual({
      input: { issueId: "dupe-id", relatedIssueId: "keeper-id", type: "duplicate" },
    });
  });

  it("is idempotent: existing duplicate relation -> no create, alreadyRelated=true", async () => {
    const fetch = mockFetch([
      { data: { issue: { relations: { nodes: [
        { id: "rel-x", type: "duplicate", relatedIssue: { id: "keeper-id" } },
      ] } } } },
    ]);
    const res = await markDuplicate(fetch, "tok", "dupe-id", "keeper-id");
    expect(res).toEqual({ success: true, issueRelationId: "rel-x", alreadyRelated: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rethrows non-duplicate API errors", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { issue: { relations: { nodes: [] } } } }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" }) as unknown as typeof fetch;
    await expect(markDuplicate(fetch, "tok", "d", "k")).rejects.toThrow(/Linear API error: 500/);
  });

  it("handles race: create returns a duplicate-error after the pre-check passed", async () => {
    // pre-check sees no relation, then the create mutation loses a race and the
    // API reports it already exists -> swallow as idempotent success (id null).
    const fetch = mockFetch([
      { data: { issue: { relations: { nodes: [] } } } },
      { data: null, errors: [{ message: "Issue relation already exists" }] },
    ]);
    const res = await markDuplicate(fetch, "tok", "dupe-id", "keeper-id");
    expect(res).toEqual({ success: true, issueRelationId: null, alreadyRelated: true });
  });
});

describe("listOpenIssues", () => {
  it("excludes both Linear canceled spellings from open issue import", async () => {
    const fetch = mockFetch([
      {
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    await listOpenIssues(fetch, "tok", "team-1");

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.query).toContain('"completed", "canceled", "cancelled"');
  });
});

describe("listIssuesByIds", () => {
  it("uses Linear ID variables for the id.in filter", async () => {
    const fetch = mockFetch([
      {
        data: {
          issues: {
            nodes: [
              {
                id: "issue-1",
                identifier: "BLO-1",
                title: "Test",
                description: null,
                url: "https://linear.app/blockc/issue/BLO-1/test",
                priority: 0,
                createdAt: "2026-06-09T00:00:00.000Z",
                updatedAt: "2026-06-09T00:00:00.000Z",
                state: { name: "Todo", type: "unstarted" },
                assignee: null,
                labels: { nodes: [] },
                project: null,
              },
            ],
          },
        },
      },
    ]);

    const issues = await listIssuesByIds(fetch, "tok", ["issue-1", "issue-1", ""]);

    expect(issues).toHaveLength(1);
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.query).toContain("query ListIssuesByIds($ids: [ID!]!, $first: Int!)");
    expect(body.variables).toEqual({ ids: ["issue-1"], first: 1 });
  });
});

describe("Paperclip backlink helpers", () => {
  it("passes Linear app-integration attachment fields through to attachmentCreate", async () => {
    const fetch = mockFetch([
      { data: { attachmentCreate: { success: true, attachment: { id: "att-1" } } } },
    ]);

    const result = await attachmentLinkURL(fetch, "tok", {
      issueId: "issue-1",
      url: "https://paperclip.test/BLO/issues/BLO-1",
      title: "Paperclip mirror: BLO-1",
      subtitle: "Open in Paperclip",
      iconUrl: "https://paperclip.test/favicon-32x32.png",
      createAsUser: "Paperclip",
      displayIconUrl: "https://paperclip.test/favicon-32x32.png",
      groupBySource: true,
      metadata: { source: "paperclip" },
    });

    expect(result).toEqual({ success: true, attachmentId: "att-1" });
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.variables.input).toMatchObject({
      issueId: "issue-1",
      url: "https://paperclip.test/BLO/issues/BLO-1",
      title: "Paperclip mirror: BLO-1",
      subtitle: "Open in Paperclip",
      iconUrl: "https://paperclip.test/favicon-32x32.png",
      createAsUser: "Paperclip",
      displayIconUrl: "https://paperclip.test/favicon-32x32.png",
      groupBySource: true,
      metadata: { source: "paperclip" },
    });
  });

  it("passes sortOrder through when creating a Linear project external link", async () => {
    const fetch = mockFetch([
      { data: { project: { externalLinks: { nodes: [] } } } },
      {
        data: {
          entityExternalLinkCreate: {
            success: true,
            entityExternalLink: {
              id: "link-1",
              url: "https://paperclip.test/BLO/projects/project",
              label: "Paperclip project",
            },
          },
        },
      },
    ]);

    const result = await ensureProjectLink(fetch, "tok", {
      projectId: "project-1",
      url: "https://paperclip.test/BLO/projects/project",
      label: "Paperclip project",
      sortOrder: -100,
    });

    expect(result.created).toBe(true);
    const createBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(createBody.variables.input).toMatchObject({
      projectId: "project-1",
      url: "https://paperclip.test/BLO/projects/project",
      label: "Paperclip project",
      sortOrder: -100,
    });
  });

  it("passes sortOrder through when updating an existing Linear project external link", async () => {
    const fetch = mockFetch([
      {
        data: {
          project: {
            externalLinks: {
              nodes: [{ id: "link-1", url: "https://old.example/project", label: "Paperclip project" }],
            },
          },
        },
      },
      {
        data: {
          entityExternalLinkUpdate: {
            success: true,
            entityExternalLink: {
              id: "link-1",
              url: "https://paperclip.test/BLO/projects/project",
              label: "Paperclip project",
            },
          },
        },
      },
    ]);

    const result = await ensureProjectLink(fetch, "tok", {
      projectId: "project-1",
      url: "https://paperclip.test/BLO/projects/project",
      label: "Paperclip project",
      sortOrder: -100,
    });

    expect(result.updated).toBe(true);
    const updateBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(updateBody.variables.input).toMatchObject({
      url: "https://paperclip.test/BLO/projects/project",
      label: "Paperclip project",
      sortOrder: -100,
    });
  });
});
