import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionGrants, createDb, heartbeatRuns, issues, issueWorkProducts } from "@paperclipai/db";
import { githubCredentialsFixture } from "../../__tests__/helpers/github-credentials-fixture.js";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import * as githubFetch from "../github-fetch.js";
import * as gitCredentials from "../git-credentials.js";
import { verifyNativePullRequestCompletion } from "./native-pull-request-completion.js";

const vault = vi.hoisted(() => ({
  getByName: vi.fn(async () => null),
  resolveUserSecretValue: vi.fn(async (_company: string, input: { responsibleUserId: string }) => ({
    value: `test-token-${input.responsibleUserId}`,
  })),
  resolveSecretValue: vi.fn(async () => "test-dedicated-token"),
}));
vi.mock("../secrets.js", () => ({ secretService: () => vault }));

const report = { artifacts: [{ kind: "pull_request", ref: "https://github.com/example/private-repo/pull/42" }] };

describe("native PR completion GitHub authorization", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  const fixture = githubCredentialsFixture(() => db);
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("native-pr-credentials-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  async function seed() {
    const binding = await fixture.seed();
    await db.update(heartbeatRuns).set({ nativeIssueId: binding.issueId, runtimeMode: "native" })
      .where(eq(heartbeatRuns.id, binding.runId));
    await db.update(issues).set({ status: "in_progress", assigneeAgentId: binding.agentId })
      .where(eq(issues.id, binding.issueId));
    return binding;
  }

  it("verifies private merged PRs with the run's managed identity, resolving credentials once", async () => {
    const binding = await seed();
    await fixture.grant(binding, "A");
    await db.insert(issueWorkProducts).values({ companyId: binding.companyId, issueId: binding.issueId,
      type: "pull_request", provider: "github", title: "Another delivery", status: "merged",
      url: "https://github.com/example/private-repo/pull/43" });
    const fetcher = vi.spyOn(githubFetch, "ghFetch").mockImplementation(async (_url, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer test-token-A"
        ? Response.json({ state: "closed", merged: true })
        : new Response(null, { status: 404 }));

    expect(await verifyNativePullRequestCompletion(db, binding, report))
      .toEqual(new Set(["example/private-repo#42", "example/private-repo#43"]));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vault.resolveUserSecretValue).toHaveBeenCalledTimes(1);
    expect(vault.getByName).not.toHaveBeenCalled();
  });

  it("uses the current accepted run identity and fails closed after its grant is revoked", async () => {
    const binding = await seed();
    await fixture.grant(binding, "A");
    const other = await fixture.grant(binding, "B");
    const fallback = vi.spyOn(gitCredentials, "resolveGitHubApiCredential")
      .mockResolvedValue({ token: "test-ambient-token", source: "server_env", secretName: null });
    const fetcher = vi.spyOn(githubFetch, "ghFetch").mockImplementation(async () => Response.json({ merged: true }));
    await verifyNativePullRequestCompletion(db, binding, report);
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer test-token-A");
    await fixture.switchTo(binding, "B");
    await verifyNativePullRequestCompletion(db, binding, report);
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get("authorization")).toBe("Bearer test-token-B");
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, other.id));

    await expect(verifyNativePullRequestCompletion(db, binding, report)).rejects.toThrow("not been verified as merged");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, binding.issueId)))[0]!.status).toBe("in_progress");
  });

  it.each([
    { state: "open", merged: false },
    { state: "open", draft: true, merged: false },
    { state: "closed", merged: false },
  ])("still rejects a PR whose current GitHub state is %j", async fields => {
    const binding = await seed();
    await fixture.grant(binding, "A");
    vi.spyOn(githubFetch, "ghFetch").mockImplementation(async () => Response.json(fields));
    await expect(verifyNativePullRequestCompletion(db, binding, report)).rejects.toThrow("not been verified as merged");
  });

  it.each([401, 403, 404, 500])("does not accept inaccessible merge evidence after GitHub HTTP %s", async status => {
    const binding = await seed();
    await fixture.grant(binding, "A");
    vi.spyOn(githubFetch, "ghFetch").mockImplementation(async () => new Response(null, { status }));
    await expect(verifyNativePullRequestCompletion(db, binding, report)).rejects.toThrow("not been verified as merged");
  });

  it("does not borrow a managed credential from another company", async () => {
    const binding = await seed(), other = await seed();
    await fixture.grant(other, "A");
    vi.spyOn(gitCredentials, "resolveGitHubApiCredential").mockResolvedValue(null);
    const fetcher = vi.spyOn(githubFetch, "ghFetch").mockImplementation(async () => new Response(null, { status: 404 }));
    await expect(verifyNativePullRequestCompletion(db, binding, report)).rejects.toThrow("not been verified as merged");
    expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("preserves legacy credentials when no managed identity is configured", async () => {
    const binding = await seed();
    const fallback = vi.spyOn(gitCredentials, "resolveGitHubApiCredential")
      .mockResolvedValue({ token: "test-company-token", source: "company_secret", secretName: "GH_TOKEN" });
    const fetcher = vi.spyOn(githubFetch, "ghFetch").mockImplementation(async () => Response.json({ merged: true }));
    expect(await verifyNativePullRequestCompletion(db, binding, report)).toEqual(new Set(["example/private-repo#42"]));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer test-company-token");
  });

  it("keeps the server-environment credential boundary for private repositories", async () => {
    const binding = await seed();
    vi.spyOn(gitCredentials, "resolveGitHubApiCredential")
      .mockResolvedValue({ token: "test-instance-token", source: "server_env", secretName: null });
    const fetcher = vi.spyOn(githubFetch, "ghFetch").mockImplementation(async () => Response.json({ private: true }));
    await expect(verifyNativePullRequestCompletion(db, binding, report)).rejects.toThrow("not been verified as merged");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.github.com/repos/example/private-repo");
  });

  it("preserves the fallback for runs that predate managed identity contexts", async () => {
    const binding = await seed();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: null }).where(eq(heartbeatRuns.id, binding.runId));
    vi.spyOn(gitCredentials, "resolveGitHubApiCredential")
      .mockResolvedValue({ token: "test-company-token", source: "company_secret", secretName: "GH_TOKEN" });
    vi.spyOn(githubFetch, "ghFetch").mockImplementation(async () => Response.json({ merged: true }));
    expect(await verifyNativePullRequestCompletion(db, binding, report)).toEqual(new Set(["example/private-repo#42"]));
  });

  it("does not acquire credentials for a run outside the bound company or task", async () => {
    const binding = await seed(), other = await seed();
    await fixture.grant(binding, "A");
    const fetcher = vi.spyOn(githubFetch, "ghFetch");
    for (const invalid of [{ ...binding, companyId: other.companyId }, { ...binding, issueId: other.issueId }]) {
      await expect(verifyNativePullRequestCompletion(db, invalid, report)).rejects.toThrow("source is unavailable");
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
  });

  it("does not acquire credentials when the task has no PR deliverables", async () => {
    const binding = await seed();
    const fetcher = vi.spyOn(githubFetch, "ghFetch");
    expect(await verifyNativePullRequestCompletion(db, binding, {})).toEqual(new Set());
    expect(fetcher).not.toHaveBeenCalled();
    expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    expect(vault.getByName).not.toHaveBeenCalled();
  });
});
