import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres done-transition PR gate route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type PrFixture = {
  state: "open" | "closed";
  merged: boolean;
  draft?: boolean;
  headSha: string;
  checkRuns: Array<{ status: string; conclusion: string | null }>;
};

describeEmbeddedPostgres("done transition external PR gate (AGE-569)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: ReturnType<typeof createApp>;
  let companyId!: string;
  let prFixtures: Map<string, PrFixture>;

  function createStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call in done-transition PR gate route test");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call in done-transition PR gate route test");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, createStorage()));
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-done-pr-gate-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    app = createApp(companyId);

    await db.insert(companies).values({
      id: companyId,
      name: "PR gate tenant",
      issuePrefix: "PRG",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await instanceSettingsService(db).updateExperimental({ enableExternalObjects: true });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubGitHubFetch() {
    prFixtures = new Map();
    const fetchStub = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      const prMatch = /\/repos\/acme\/app\/pulls\/(\d+)$/.exec(url);
      if (prMatch) {
        const fixture = prFixtures.get(prMatch[1]!);
        if (!fixture) return new Response("", { status: 404 });
        return new Response(
          JSON.stringify({
            state: fixture.state,
            merged: fixture.merged,
            draft: fixture.draft ?? false,
            title: `PR ${prMatch[1]}`,
            updated_at: "2026-04-24T01:02:03Z",
            head: { sha: fixture.headSha, ref: "feature" },
            base: { ref: "main" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const checkRunsMatch = /\/repos\/acme\/app\/commits\/([^/]+)\/check-runs$/.exec(url);
      if (checkRunsMatch) {
        const sha = checkRunsMatch[1]!;
        const fixture = [...prFixtures.values()].find((f) => f.headSha === sha);
        return new Response(JSON.stringify({ check_runs: fixture?.checkRuns ?? [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const statusMatch = /\/repos\/acme\/app\/commits\/([^/]+)\/status$/.exec(url);
      if (statusMatch) {
        return new Response(JSON.stringify({ state: "success", statuses: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch in done-transition PR gate test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    return fetchStub;
  }

  async function createIssueWithPr(prNumber: number, fixture: PrFixture) {
    prFixtures.set(String(prNumber), fixture);
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: `Ship PR ${prNumber}`,
        description: `Implements https://github.com/acme/app/pull/${prNumber}`,
        status: "in_progress",
        priority: "medium",
        assigneeUserId: "cloud-user-1",
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const issueId = createRes.body.id as string;

    const refreshRes = await request(app)
      .post(`/api/issues/${issueId}/external-objects/refresh`)
      .send({});
    expect(refreshRes.status, JSON.stringify(refreshRes.body)).toBe(200);

    return issueId;
  }

  it("refuses to mark done an issue linked to an open pull request", async () => {
    stubGitHubFetch();
    const issueId = await createIssueWithPr(101, {
      state: "open",
      merged: false,
      headSha: "sha-open-101",
      checkRuns: [{ status: "completed", conclusion: "success" }],
    });

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("acme/app#101");
    expect(res.body.error).toContain("open");
    expect(res.body.details).toMatchObject({
      code: "done_transition_pr_gate",
      reason: "open",
      pullRequest: expect.objectContaining({ owner: "acme", repo: "app", number: 101 }),
    });
  });

  it("refuses to mark done an issue linked to a merged pull request with red CI", async () => {
    stubGitHubFetch();
    const issueId = await createIssueWithPr(102, {
      state: "closed",
      merged: true,
      headSha: "sha-red-102",
      checkRuns: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ],
    });

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("acme/app#102");
    expect(res.body.error).toContain("checks red");
    expect(res.body.details).toMatchObject({
      code: "done_transition_pr_gate",
      reason: "checks red",
      pullRequest: expect.objectContaining({ owner: "acme", repo: "app", number: 102, checksState: "failure" }),
    });
  });

  it("refuses to mark done an issue linked to a merged pull request with pending CI", async () => {
    stubGitHubFetch();
    const issueId = await createIssueWithPr(103, {
      state: "closed",
      merged: true,
      headSha: "sha-pending-103",
      checkRuns: [{ status: "in_progress", conclusion: null }],
    });

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("acme/app#103");
    expect(res.body.error).toContain("checks pending");
    expect(res.body.details).toMatchObject({
      code: "done_transition_pr_gate",
      reason: "checks pending",
    });
  });

  it("allows marking done an issue linked to a merged pull request with green CI", async () => {
    stubGitHubFetch();
    const issueId = await createIssueWithPr(104, {
      state: "closed",
      merged: true,
      headSha: "sha-green-104",
      checkRuns: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "success" },
      ],
    });

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");
    // Let terminal-status post-commit side effects (e.g. pending interaction
    // expiry) settle before the embedded Postgres pool tears down.
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

  it("does not gate issues with no linked pull request", async () => {
    stubGitHubFetch();
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "No linked PR",
        status: "in_progress",
        priority: "medium",
        assigneeUserId: "cloud-user-1",
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);

    const res = await request(app).patch(`/api/issues/${createRes.body.id}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
});
