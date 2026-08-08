import { describe, it, expect, vi } from "vitest";
import { createCheckRun, getCheckRuns } from "../src/tools/checks.js";
import { RefusalError } from "../src/audit.js";
import type { GitHubClient } from "../src/auth.js";

const runCtx = { agentId: "a", runId: "r", companyId: "c", projectId: "p" };

function makeClient(overrides: Record<string, unknown> = {}): GitHubClient {
  return {
    owner: "o",
    name: "r",
    rest: {
      checks: {
        create: vi.fn().mockResolvedValue({
          data: { id: 99, html_url: "https://x/y", conclusion: "success" },
        }),
        listForRef: vi.fn().mockResolvedValue({
          data: { check_runs: [] },
        }),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc" } } }),
      },
      ...overrides,
    } as never,
    graphql: vi.fn() as never,
  };
}

describe("createCheckRun refusal rules", () => {
  it("refuses completed status without details", async () => {
    const client = makeClient();
    await expect(
      createCheckRun(
        client,
        { name: "build", headSha: "abc", status: "completed", conclusion: "success", summary: "s" },
        runCtx,
      ),
    ).rejects.toBeInstanceOf(RefusalError);
  });

  it("refuses completed status with thin details (<200 chars)", async () => {
    const client = makeClient();
    await expect(
      createCheckRun(
        client,
        { name: "build", headSha: "abc", status: "completed", conclusion: "success", details: "too short" },
        runCtx,
      ),
    ).rejects.toThrow(/evidence_too_thin/);
  });

  it("refuses completed status without conclusion", async () => {
    const client = makeClient();
    const longDetails = "x".repeat(250);
    await expect(
      createCheckRun(
        client,
        { name: "build", headSha: "abc", status: "completed", details: longDetails },
        runCtx,
      ),
    ).rejects.toThrow(/missing_conclusion/);
  });

  it("accepts in_progress without details", async () => {
    const client = makeClient();
    const result = await createCheckRun(
      client,
      { name: "build", headSha: "abc", status: "in_progress", summary: "running" },
      runCtx,
    );
    expect(result.error).toBeUndefined();
    expect((result.data as { id: number }).id).toBe(99);
  });

  it("accepts completed with full evidence", async () => {
    const client = makeClient();
    const longDetails = "evidence detail. ".repeat(20); // ~340 chars
    const result = await createCheckRun(
      client,
      { name: "build", headSha: "abc", status: "completed", conclusion: "success", details: longDetails },
      runCtx,
    );
    expect(result.error).toBeUndefined();
  });
});

describe("getCheckRuns", () => {
  it("looks up head sha from PR then lists checks", async () => {
    const client = makeClient();
    const result = await getCheckRuns(client, { prNumber: 7 }, runCtx);
    expect(result.error).toBeUndefined();
    const listForRef = (client.rest as never as { checks: { listForRef: ReturnType<typeof vi.fn> } }).checks.listForRef;
    expect(listForRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "abc" }));
  });

  it("filters by check name when provided", async () => {
    const client = makeClient();
    await getCheckRuns(client, { prNumber: 7, name: "quality / cargo-deny" }, runCtx);
    const listForRef = (client.rest as never as { checks: { listForRef: ReturnType<typeof vi.fn> } }).checks.listForRef;
    expect(listForRef.mock.calls[0]?.[0].check_name).toBe("quality / cargo-deny");
  });
});
