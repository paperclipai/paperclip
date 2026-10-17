import { describe, it, expect, vi } from "vitest";
import { listIssues } from "../src/tools/issues.js";
import type { GitHubClient } from "../src/auth.js";

const runCtx = { agentId: "a", runId: "r", companyId: "c", projectId: "p" };

function makeClient(rows: unknown[]): GitHubClient {
  return {
    owner: "o",
    name: "r",
    rest: {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({ data: rows }),
      },
    } as never,
    graphql: vi.fn() as never,
  };
}

describe("listIssues", () => {
  it("filters out pull requests, keeps issues", async () => {
    const client = makeClient([
      {
        number: 1,
        title: "real issue",
        state: "open",
        labels: [],
        user: { login: "alice" },
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
        body: "",
      },
      {
        number: 2,
        title: "actually a PR",
        state: "open",
        labels: [],
        user: { login: "bob" },
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
        body: "",
        pull_request: { url: "..." },
      },
    ]);
    const result = await listIssues(client, {}, runCtx);
    const issues = (result.data as { issues: Array<{ number: number }> }).issues;
    expect(issues.map((i) => i.number)).toEqual([1]);
  });

  it("normalizes string and object label entries", async () => {
    const client = makeClient([
      {
        number: 5,
        title: "x",
        state: "open",
        labels: [{ name: "compliance" }, "phase1", { name: "" }],
        user: { login: "a" },
        created_at: "x",
        updated_at: "x",
        body: "",
      },
    ]);
    const result = await listIssues(client, {}, runCtx);
    const labels = (result.data as { issues: Array<{ labels: string[] }> }).issues[0]!.labels;
    expect(labels).toEqual(["compliance", "phase1"]);
  });

  it("passes through label and state filters", async () => {
    const client = makeClient([]);
    await listIssues(client, { labels: ["a", "b"], state: "closed", perPage: 50 }, runCtx);
    const listForRepo = (client.rest as never as { issues: { listForRepo: ReturnType<typeof vi.fn> } }).issues.listForRepo;
    expect(listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ labels: "a,b", state: "closed", per_page: 50 }),
    );
  });

  it("caps perPage at 100", async () => {
    const client = makeClient([]);
    await listIssues(client, { perPage: 500 }, runCtx);
    const listForRepo = (client.rest as never as { issues: { listForRepo: ReturnType<typeof vi.fn> } }).issues.listForRepo;
    expect(listForRepo.mock.calls[0]?.[0].per_page).toBe(100);
  });

  it("treats null body as empty string", async () => {
    const client = makeClient([
      {
        number: 9,
        title: "x",
        state: "open",
        labels: [],
        user: { login: "a" },
        created_at: "x",
        updated_at: "x",
        body: null,
      },
    ]);
    const result = await listIssues(client, {}, runCtx);
    expect((result.data as { issues: Array<{ body: string }> }).issues[0]!.body).toBe("");
  });
});
