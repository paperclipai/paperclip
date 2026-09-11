import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  toolApplications,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createGitHubDeliveryClient } from "../services/delivery/github-client.js";
import { greptileReviewService } from "../services/delivery/greptile.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function githubRepositoryResponse(): Response {
  return new Response(JSON.stringify({
    id: 42,
    name: "widget",
    full_name: "acme/widget",
    owner: { login: "acme" },
    default_branch: "main",
    private: true,
    archived: false,
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A check run row in GitHub's recorded REST shape, exactly what the client parses. */
function greptileCheckRunRow(input: {
  id: number;
  status: string;
  conclusion: string | null;
  completedAt: string | null;
  headSha: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    name: "Greptile Review",
    status: input.status,
    conclusion: input.conclusion,
    head_sha: input.headSha,
    app: { slug: "greptile-apps" },
    completed_at: input.completedAt,
    started_at: input.completedAt,
    html_url: `https://github.com/acme/widget/commit/${input.headSha}/checks`,
  };
}

/**
 * URL-routed fetch mock for the conversation-requirement sources: an empty
 * readable rules list, then the caller's protection response.
 */
function rulesThenProtectionFetch(protectionResponse: Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/rules/branches/")) return Response.json([]);
    if (url.includes("/branches/main/protection")) return protectionResponse;
    throw new Error(`unexpected requirement request: ${url}`);
  }) as typeof fetch;
}

/** Governed Greptile MCP payloads in the provider's nested shape. */
function greptileToolGateway(input: {
  review?: Record<string, unknown>;
  comments?: Array<Record<string, unknown>>;
}) {
  return {
    readConnectedTool: async ({ toolName }: { toolName: string }) => {
      if (toolName === "get_merge_request") {
        return {
          ok: true,
          result: { content: JSON.stringify({ mergeRequest: { codeReviews: [input.review ?? { status: "COMPLETED" }] } }) },
        };
      }
      return { ok: true, result: { content: JSON.stringify({ comments: input.comments ?? [] }) } };
    },
  };
}

describeEmbeddedPostgres("GitHub delivery connection credentials", () => {
  let db!: Db;
  let stopDb: (() => Promise<void>) | undefined;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-github-delivery-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("github-delivery-client");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 120_000);

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function createPersonalPatFixture() {
    const [company] = await db.insert(companies).values({
      name: `GitHub delivery ${randomUUID()}`,
      issuePrefix: `GH${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const ownerUserId = `owner-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "member",
      status: "active",
    });

    const secrets = secretService(db);
    const definition = await secrets.createUserSecretDefinition(company!.id, {
      key: `github-delivery-${randomUUID()}`,
      name: "GitHub delivery token",
      provider: "local_encrypted",
      managedMode: "paperclip_managed",
    });
    const token = `github-delivery-token-${randomUUID()}`;
    const personalSecret = await secrets.createCurrentUserSecretValue(
      company!.id,
      ownerUserId,
      { definitionId: definition!.id, value: token },
      { userId: ownerUserId },
    );
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `github-${randomUUID()}`,
      name: "GitHub",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company!.id,
      applicationId: application!.id,
      name: "GitHub personal PAT",
      uid: `github/${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "api_key",
      credentialSource: "paperclip_vault",
      credentialPolicy: "per_user",
      config: { sourceTemplateKey: "github" },
      transportConfig: {},
      credentialRefs: [{
        name: "credentials.authorization",
        secretId: personalSecret!.id,
        version: "latest",
        placement: "header",
        key: "Authorization",
        prefix: "Bearer ",
      }],
      credentialSecretRefs: [],
      status: "active",
      enabled: true,
    }).returning();
    const [grant] = await db.insert(connectionGrants).values({
      companyId: company!.id,
      connectionId: connection!.id,
      kind: "user",
      subjectUserId: ownerUserId,
      credentialSecretRefs: [{
        secretId: personalSecret!.id,
        versionSelector: "latest",
        configPath: "credentials.authorization",
        required: true,
        label: "GitHub token",
      }],
      status: "active",
      isDefault: false,
      createdByUserId: ownerUserId,
    }).returning();
    await secrets.syncUserSecretDeclarationsForTarget(
      company!.id,
      { targetType: "tool_connection", targetId: connection!.id },
      [{
        definitionKey: definition!.key,
        configPath: "credentials.authorization",
        envKey: "GITHUB_TOKEN",
        versionSelector: "latest",
        required: true,
        label: "GitHub token",
      }],
    );

    return {
      company: company!,
      connection: connection!,
      definition: definition!,
      grant: grant!,
      ownerUserId,
      personalSecret: personalSecret!,
      token,
    };
  }

  it("discovers an authoritative pull request from GitHub's array response", async () => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([{ number: 42 }]))
      .mockResolvedValueOnce(Response.json({
        number: 42, html_url: "https://github.com/acme/widget/pull/42", state: "open",
        head: { sha: head, ref: "delivery/candidate" }, base: { ref: "main" },
      }));
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock });
    expect(await client.findOpenPullRequest(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", "delivery/candidate", "main"))
      .toMatchObject({ ok: true, value: { number: 42, headSha: head, headRef: "delivery/candidate", baseRef: "main" } });
  });

  it("preserves approvals and blocking findings from GitHub's review array", async () => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      { state: "APPROVED", user: { login: "approver" }, commit_id: head, submitted_at: "2026-09-09T10:00:00Z" },
      { state: "CHANGES_REQUESTED", user: { login: "reviewer" }, commit_id: head, submitted_at: "2026-09-09T11:00:00Z" },
    ]));
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock });
    expect(await client.getReviews(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", 42))
      .toMatchObject({ ok: true, value: { blockingFindings: 1, approvals: [{ login: "approver", commitSha: head }] } });
  });

  it("correlates Greptile node identities with the GitHub comment revision", async () => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const client = createGitHubDeliveryClient(db, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json([{
        id: 123, node_id: "PRRC_reviewFinding", commit_id: head,
        user: { login: "greptile-apps[bot]" }, body: "P1: invalid carrier",
        path: "dispatch.ts", line: 30,
      }])),
    });
    expect(await client.getReviewComments(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", 42))
      .toMatchObject({ ok: true, value: [{ id: "PRRC_reviewFinding", commitSha: head, path: "dispatch.ts", line: 30 }] });
  });

  it("projects the personal PAT Authorization binding into a real delivery request", async () => {
    const fixture = await createPersonalPatFixture();
    const fetchMock = vi.fn(async () => githubRepositoryResponse());
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock as typeof fetch });

    const result = await client.getRepository(
      fixture.company.id,
      fixture.connection.id,
      "github.com",
      "acme",
      "widget",
    );

    expect(result).toMatchObject({
      ok: true,
      value: { id: "42", owner: "acme", name: "widget", fullName: "acme/widget" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widget",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${fixture.token}` }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain(fixture.token);
  });

  it("fails closed for disabled, revoked, cross-company, and host-mismatched connections", async () => {
    const fixture = await createPersonalPatFixture();
    const fetchMock = vi.fn(async () => githubRepositoryResponse());
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock as typeof fetch });
    const requestRepository = (companyId = fixture.company.id, host = "github.com") => client.getRepository(
      companyId,
      fixture.connection.id,
      host,
      "acme",
      "widget",
    );

    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, fixture.connection.id));
    await expect(requestRepository()).resolves.toMatchObject({
      ok: false,
      errorCode: "connection_missing",
    });

    await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, fixture.connection.id));
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, fixture.grant.id));
    await expect(requestRepository()).resolves.toMatchObject({
      ok: false,
      errorCode: "connection_missing",
    });

    await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, fixture.grant.id));
    await expect(requestRepository(randomUUID())).resolves.toMatchObject({
      ok: false,
      errorCode: "connection_missing",
    });
    await expect(requestRepository(fixture.company.id, "github.enterprise.test")).resolves.toMatchObject({
      ok: false,
      errorCode: "connection_missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a grant whose personal secret belongs to a different identity", async () => {
    const fixture = await createPersonalPatFixture();
    const intruderUserId = `intruder-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: fixture.company.id,
      principalType: "user",
      principalId: intruderUserId,
      membershipRole: "member",
      status: "active",
    });
    await secretService(db).createCurrentUserSecretValue(
      fixture.company.id,
      intruderUserId,
      { definitionId: fixture.definition.id, value: `intruder-token-${randomUUID()}` },
      { userId: intruderUserId },
    );
    await db.update(connectionGrants).set({ subjectUserId: intruderUserId }).where(eq(connectionGrants.id, fixture.grant.id));
    const fetchMock = vi.fn(async () => githubRepositoryResponse());
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock as typeof fetch });

    await expect(client.getRepository(
      fixture.company.id,
      fixture.connection.id,
      "github.com",
      "acme",
      "widget",
    )).resolves.toMatchObject({
      ok: false,
      errorCode: "connection_missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects ambiguous active personal grants rather than choosing an owner", async () => {
    const fixture = await createPersonalPatFixture();
    const secondOwnerUserId = `owner-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: fixture.company.id,
      principalType: "user",
      principalId: secondOwnerUserId,
      membershipRole: "member",
      status: "active",
    });
    const secondSecret = await secretService(db).createCurrentUserSecretValue(
      fixture.company.id,
      secondOwnerUserId,
      { definitionId: fixture.definition.id, value: `second-owner-token-${randomUUID()}` },
      { userId: secondOwnerUserId },
    );
    await db.insert(connectionGrants).values({
      companyId: fixture.company.id,
      connectionId: fixture.connection.id,
      kind: "user",
      subjectUserId: secondOwnerUserId,
      credentialSecretRefs: [{
        secretId: secondSecret!.id,
        versionSelector: "latest",
        configPath: "credentials.authorization",
        required: true,
        label: "GitHub token",
      }],
      status: "active",
      isDefault: false,
      createdByUserId: secondOwnerUserId,
    });
    const fetchMock = vi.fn(async () => githubRepositoryResponse());
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock as typeof fetch });

    await expect(client.getRepository(
      fixture.company.id,
      fixture.connection.id,
      "github.com",
      "acme",
      "widget",
    )).resolves.toMatchObject({
      ok: false,
      errorCode: "connection_missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows check-run pagination and records the complete run list", async () => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        total_count: 2,
        check_runs: [greptileCheckRunRow({ id: 103022939100, status: "completed", conclusion: "success", completedAt: "2026-09-10T11:00:00Z", headSha: head })],
      }))
      .mockResolvedValueOnce(Response.json({
        total_count: 2,
        check_runs: [greptileCheckRunRow({ id: 103022939200, status: "completed", conclusion: "failure", completedAt: "2026-09-10T12:00:00Z", headSha: head })],
      }));
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock });

    await expect(client.getCheckRuns(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", head))
      .resolves.toMatchObject({
        ok: true,
        value: [
          expect.objectContaining({ id: 103022939100, conclusion: "success", appSlug: "greptile-apps" }),
          expect.objectContaining({ id: 103022939200, conclusion: "failure" }),
        ],
      });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.github.com/repos/acme/widget/commits/${head}/check-runs?per_page=100&page=1`,
      `https://api.github.com/repos/acme/widget/commits/${head}/check-runs?per_page=100&page=2`,
    ]);
  });

  it.each([
    { name: "missing total_count", payload: { check_runs: [] } },
    { name: "string total_count", payload: { total_count: "1", check_runs: [] } },
    { name: "fractional total_count", payload: { total_count: 1.5, check_runs: [] } },
    { name: "negative total_count", payload: { total_count: -1, check_runs: [] } },
  ])("fails closed on unreadable check-run pagination metadata: $name", async ({ payload }) => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock });

    await expect(client.getCheckRuns(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", head))
      .resolves.toMatchObject({ ok: false, errorCode: "github_invalid_response" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the check-run list is truncated before total_count is accounted for", async () => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        total_count: 2,
        check_runs: [greptileCheckRunRow({ id: 103022939100, status: "completed", conclusion: "success", completedAt: "2026-09-10T11:00:00Z", headSha: head })],
      }))
      .mockResolvedValueOnce(Response.json({ total_count: 2, check_runs: [] }));
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock });

    await expect(client.getCheckRuns(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", head))
      .resolves.toMatchObject({ ok: false, errorCode: "github_invalid_response" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when check-run pages run out before total_count is accounted for", async () => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    // Every page reports one run but claims eleven total: the page bound
    // exhausts and the unprovable list is rejected, never truncated into proof.
    let id = 103022939100;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      total_count: 11,
      check_runs: [greptileCheckRunRow({ id: id++, status: "completed", conclusion: "success", completedAt: "2026-09-10T11:00:00Z", headSha: head })],
    }));
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock });

    await expect(client.getCheckRuns(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", head))
      .resolves.toMatchObject({ ok: false, errorCode: "github_invalid_response" });
  });

  it.each([
    { name: "a changing total", secondTotal: 3, secondId: 103022939101 },
    { name: "a duplicated run", secondTotal: 2, secondId: 103022939100 },
  ])("refuses a complete-evidence claim across $name", async ({ secondTotal, secondId }) => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const firstRun = greptileCheckRunRow({
      id: 103022939100, status: "completed", conclusion: "success",
      completedAt: "2026-09-10T11:00:00Z", headSha: head,
    });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ total_count: 2, check_runs: [firstRun] }))
      .mockResolvedValueOnce(Response.json({ total_count: secondTotal, check_runs: [{ ...firstRun, id: secondId }] }));
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock });
    await expect(client.getCheckRuns(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", head))
      .resolves.toMatchObject({ ok: false, errorCode: "github_invalid_response" });
  });

  // The consumer regression: a naive first-page read proves the stale success
  // because the superseding outcome sits beyond it. The real client must parse
  // both pages so the hidden outcome stays in the evidence.
  it.each([
    {
      name: "failed",
      hidden: { id: 103022939200, status: "completed", conclusion: "failure" as string | null, completedAt: "2026-09-10T12:00:00Z" as string | null },
    },
    {
      name: "in flight",
      hidden: { id: 103022939300, status: "in_progress", conclusion: null, completedAt: null },
    },
  ])("cannot ignore a later $name Greptile outcome hidden beyond the first check-run page", async ({ hidden }) => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const reviewedHead = "b".repeat(40);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/pulls/7/comments")) return Response.json([]);
      if (url.includes("/pulls/7/reviews")) {
        return Response.json([{
          id: 501,
          user: { login: "greptile-apps[bot]" },
          state: "COMMENTED",
          submitted_at: "2026-09-10T11:59:08Z",
          commit_id: reviewedHead,
        }]);
      }
      if (url.includes("/check-runs")) {
        return new URL(url).searchParams.get("page") === "2"
          ? Response.json({ total_count: 2, check_runs: [greptileCheckRunRow({ ...hidden, headSha: head })] })
          : Response.json({
              total_count: 2,
              check_runs: [greptileCheckRunRow({ id: 103022939100, status: "completed", conclusion: "success", completedAt: "2026-09-10T11:00:00Z", headSha: head })],
            });
      }
      throw new Error(`Unexpected GitHub path: ${url}`);
    });
    // GitHub's review record still names the older revision, so only a
    // complete check-run read could prove the current head: the older success
    // sits on the first page, the later outcome beyond it.
    const greptile = greptileReviewService({} as Db, {
      github: createGitHubDeliveryClient(db, { fetch: fetchMock }),
      toolGateway: greptileToolGateway({ review: { status: "COMPLETED", revision: reviewedHead }, comments: [] }),
    });

    await expect(greptile.read({
      companyId: fixture.company.id,
      connectionId: fixture.connection.id,
      repositoryName: "acme/widget",
      defaultBranch: "main",
      prNumber: 7,
      correlation: {
        host: "github.com",
        connectionId: fixture.connection.id,
        owner: "acme",
        repo: "widget",
        headSha: head,
      },
    })).resolves.toMatchObject({ ok: true, headSha: reviewedHead });

    expect(fetchMock.mock.calls.map(([url]) => url).filter((url) => String(url).includes("/check-runs"))).toEqual([
      `https://api.github.com/repos/acme/widget/commits/${head}/check-runs?per_page=100&page=1`,
      `https://api.github.com/repos/acme/widget/commits/${head}/check-runs?per_page=100&page=2`,
    ]);
  });

  it("still proves the current head from a complete first-page Greptile check", async () => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const reviewedHead = "b".repeat(40);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/pulls/7/comments")) return Response.json([]);
      if (url.includes("/pulls/7/reviews")) {
        return Response.json([{
          id: 501,
          user: { login: "greptile-apps[bot]" },
          state: "COMMENTED",
          submitted_at: "2026-09-10T11:59:08Z",
          commit_id: reviewedHead,
        }]);
      }
      if (url.includes("/check-runs")) {
        return Response.json({
          total_count: 1,
          check_runs: [greptileCheckRunRow({ id: 103022939200, status: "completed", conclusion: "success", completedAt: "2026-09-10T12:00:00Z", headSha: head })],
        });
      }
      throw new Error(`Unexpected GitHub path: ${url}`);
    });
    const greptile = greptileReviewService({} as Db, {
      github: createGitHubDeliveryClient(db, { fetch: fetchMock }),
      toolGateway: greptileToolGateway({ review: { status: "COMPLETED", revision: reviewedHead }, comments: [] }),
    });

    await expect(greptile.read({
      companyId: fixture.company.id,
      connectionId: fixture.connection.id,
      repositoryName: "acme/widget",
      defaultBranch: "main",
      prNumber: 7,
      correlation: {
        host: "github.com",
        connectionId: fixture.connection.id,
        owner: "acme",
        repo: "widget",
        headSha: head,
      },
    })).resolves.toMatchObject({
      ok: true,
      status: "none",
      reviewState: "completed",
      headSha: head,
      blockingFindings: 0,
      findings: [],
    });
    // Comments, reviews, and one check-run page: a pull request with no
    // findings has nothing a review thread could clear, so the thread record is
    // not read at all.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads review threads with GitHub's resolution record across pages", async () => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const threadRow = (input: { id: string; resolved: boolean; comments: string[] }) => ({
      id: input.id,
      isResolved: input.resolved,
      isOutdated: false,
      path: "dispatch.ts",
      line: 30,
      comments: {
        totalCount: input.comments.length,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: input.comments.map((id) => ({
          id,
          commit: { oid: head },
          createdAt: "2026-09-10T10:00:00Z",
          author: { login: "greptile-apps" },
        })),
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.github.com/graphql");
      const body = JSON.parse(String(init?.body)) as { variables: { cursor: string | null } };
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: body.variables.cursor === null
                ? {
                  totalCount: 2,
                  pageInfo: { hasNextPage: true, endCursor: "thread-page-2" },
                  nodes: [threadRow({ id: "PRRT_first", resolved: true, comments: ["PRRC_first"] })],
                }
                : {
                  totalCount: 2,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [threadRow({ id: "PRRT_second", resolved: false, comments: ["PRRC_second"] })],
                },
            },
          },
        },
      });
    });
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock });

    await expect(client.getReviewThreads(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", 42))
      .resolves.toMatchObject({
        ok: true,
        value: [
          { id: "PRRT_first", isResolved: true, comments: [{ id: "PRRC_first", commitSha: head }] },
          { id: "PRRT_second", isResolved: false, comments: [{ id: "PRRC_second", commitSha: head }] },
        ],
      });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("proves the conversation-resolution requirement from the ruleset record alone", async () => {
    const fixture = await createPersonalPatFixture();
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/rules/branches/main")) {
        return Response.json([
          { rule_type: "deletion" },
          { rule_type: "pull_request", parameters: { required_review_thread_resolution: true, required_approving_review_count: 1 } },
        ]);
      }
      throw new Error(`unexpected requirement request: ${url}`);
    });
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock });

    await expect(client.getConversationResolutionRequirement(
      fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", "main",
    )).resolves.toMatchObject({ ok: true, value: { state: "required" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads legacy branch protection for the conversation requirement and proves absence only from readable sources", async () => {
    const fixture = await createPersonalPatFixture();
    const requiredClient = createGitHubDeliveryClient(db, {
      fetch: rulesThenProtectionFetch(Response.json({ required_conversation_resolution: { enabled: true } })),
    });
    await expect(requiredClient.getConversationResolutionRequirement(
      fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", "main",
    )).resolves.toMatchObject({ ok: true, value: { state: "required" } });

    // Both sources readable and neither requires resolution: a proven negative.
    const absentClient = createGitHubDeliveryClient(db, {
      fetch: rulesThenProtectionFetch(Response.json({ required_status_checks: { strict: true }, enabled: true })),
    });
    await expect(absentClient.getConversationResolutionRequirement(
      fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", "main",
    )).resolves.toMatchObject({ ok: true, value: { state: "not_required" } });
  });

  it("reports an unreadable conversation requirement as unknown, never as not-required", async () => {
    const fixture = await createPersonalPatFixture();
    // Forbidden legacy protection: rules alone cannot prove absence.
    const forbiddenClient = createGitHubDeliveryClient(db, {
      fetch: rulesThenProtectionFetch(Response.json({ message: "Must have admin rights" }, { status: 403 })),
    });
    await expect(forbiddenClient.getConversationResolutionRequirement(
      fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", "main",
    )).resolves.toMatchObject({ ok: true, value: { state: "unknown" } });
    // Unreachable rules and unreadable protection: still unknown.
    const unreachableClient = createGitHubDeliveryClient(db, {
      fetch: vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    await expect(unreachableClient.getConversationResolutionRequirement(
      fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", "main",
    )).resolves.toMatchObject({ ok: true, value: { state: "unknown" } });
  });

  it("follows a review thread's own comment pages before it is complete", async () => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const commentRow = (id: string) => ({
      id,
      commit: { oid: head },
      createdAt: "2026-09-10T10:00:00Z",
      author: { login: "greptile-apps" },
    });
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      if (body.variables.id === "PRRT_long") {
        return Response.json({
          data: {
            node: {
              comments: {
                totalCount: 2,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [commentRow("PRRC_second")],
              },
            },
          },
        });
      }
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: "PRRT_long",
                  isResolved: true,
                  isOutdated: false,
                  path: "dispatch.ts",
                  line: 30,
                  comments: {
                    totalCount: 2,
                    pageInfo: { hasNextPage: true, endCursor: "comment-page-2" },
                    nodes: [commentRow("PRRC_first")],
                  },
                }],
              },
            },
          },
        },
      });
    });
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock });

    await expect(client.getReviewThreads(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", 42))
      .resolves.toMatchObject({
        ok: true,
        value: [{
          id: "PRRT_long",
          isResolved: true,
          comments: [{ id: "PRRC_first" }, { id: "PRRC_second" }],
        }],
      });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("follows the review-comment list to its own end before treating it as complete", async () => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const commentRow = (id: number) => ({
      id,
      node_id: `PRRC_${id}`,
      commit_id: head,
      user: { login: "greptile-apps[bot]" },
      body: `P1: finding ${id}`,
      path: "dispatch.ts",
      line: 30,
    });
    // A first page that fills the requested size is not the end of the list: a
    // finding identity beyond it would otherwise be silently absent.
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(Array.from({ length: 100 }, (_unused, index) => commentRow(index + 1))))
      .mockResolvedValueOnce(Response.json([commentRow(101)]));
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock });
    const result = await client.getReviewComments(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", 42);

    expect(result.ok && result.value).toHaveLength(101);
    expect(result.ok && result.value?.at(-1)).toMatchObject({ id: "PRRC_101", commitSha: head });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/acme/widget/pulls/42/comments?per_page=100&page=1",
      "https://api.github.com/repos/acme/widget/pulls/42/comments?per_page=100&page=2",
    ]);
  });

  it("fails closed when the review-comment list is still full at the page bound", async () => {
    const fixture = await createPersonalPatFixture();
    const head = "a".repeat(40);
    const fullPage = Array.from({ length: 100 }, (_unused, index) => ({
      id: index + 1,
      node_id: `PRRC_${index + 1}`,
      commit_id: head,
      body: "P1: finding",
    }));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(fullPage));
    const client = createGitHubDeliveryClient(db, { fetch: fetchMock });

    // Every page is full and the bound runs out: the record is unreadable, not
    // a complete list of the pages that happened to fit.
    await expect(client.getReviewComments(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", 42))
      .resolves.toMatchObject({ ok: false, errorCode: "github_invalid_response" });
  });

  it("fails closed when the review-thread record is incomplete or unreadable", async () => {
    const fixture = await createPersonalPatFixture();
    // GitHub's own total is the completeness proof: an empty first page that
    // claims two threads is a truncated record, never an empty pull request.
    const truncated = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      },
    }));
    const client = createGitHubDeliveryClient(db, { fetch: truncated });
    await expect(client.getReviewThreads(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", 42))
      .resolves.toMatchObject({ ok: false, errorCode: "github_invalid_response" });

    // A GraphQL error is a failed read, not an empty thread list.
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ errors: [{ message: "Bad credentials" }] }));
    const rejectedClient = createGitHubDeliveryClient(db, { fetch: rejected });
    await expect(rejectedClient.getReviewThreads(fixture.company.id, fixture.connection.id, "github.com", "acme", "widget", 42))
      .resolves.toMatchObject({ ok: false, errorCode: "github_unexpected_response" });
  });
});
