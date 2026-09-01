import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  formalQaPolicies,
  formalQaPreparations,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { formalQaGitHubDiscoveryService } from "../services/formal-qa-github-discovery.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("formal-QA GitHub discovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-formal-qa-discovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`truncate table formal_qa_preparations cascade`);
    await db.delete(formalQaPolicies);
    await db.delete(agents);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const reviewerAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Discovery",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Repository", status: "in_progress" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Repository",
      repoUrl: "https://github.com/acme/repository.git",
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Reviewer",
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
    });
    const [policy] = await db.insert(formalQaPolicies).values({
      companyId,
      projectId,
      projectWorkspaceId,
      reviewerAgentId,
      repository: "acme/repository",
      requiredWorkflowId: "11",
      requiredCheckName: "CI",
      requiredCheckAppId: 22,
      enabled: true,
      createdByUserId: "admin-user",
      updatedByUserId: "admin-user",
    }).returning();
    return { companyId, policy: policy! };
  }

  it("creates one inert request per ready exact head, skips drafts, and replays idempotently", async () => {
    const { companyId } = await seed();
    const firstHead = "1".repeat(40);
    const secondHead = "2".repeat(40);
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      if (url.endsWith("page=1")) {
        return new Response(JSON.stringify([
          { number: 7, state: "open", draft: false, head: { sha: firstHead } },
          { number: 8, state: "open", draft: true, head: { sha: "3".repeat(40) } },
        ]), { status: 200, headers: { link: '<https://api.github.com/example?page=2>; rel="next"' } });
      }
      return new Response(JSON.stringify([
        { number: 9, state: "open", draft: false, head: { sha: secondHead } },
      ]), { status: 200 });
    };
    const service = formalQaGitHubDiscoveryService(db, {
      fetch,
      tokenProvider: async () => "token",
      discoveryIntervalMs: 0,
    });

    const first = await service.reconcileOpenPulls({ companyId });
    const second = await service.reconcileOpenPulls({ companyId });
    expect(first).toMatchObject({ created: 2, replayed: 0, draftsSkipped: 1, deferred: 0 });
    expect(second).toMatchObject({ created: 0, replayed: 2, draftsSkipped: 1, deferred: 0 });
    expect(calls).toHaveLength(4);
    const rows = await db.select().from(formalQaPreparations);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.prNumber).sort()).toEqual([7, 9]);
    expect(rows.every((row) => row.status === "prepared" && row.headSha === "0".repeat(40))).toBe(true);
    expect(rows.every((row) => row.idempotencyKey.includes(":head:"))).toBe(true);
  });

  it("defers a policy without credentials and creates no request", async () => {
    const { companyId } = await seed();
    const service = formalQaGitHubDiscoveryService(db, {
      fetch: async () => { throw new Error("must not fetch"); },
      tokenProvider: async () => null,
      discoveryIntervalMs: 0,
    });

    await expect(service.reconcileOpenPulls({ companyId })).resolves.toMatchObject({
      policiesScanned: 1,
      created: 0,
      deferred: 1,
    });
    await expect(
      db.select().from(formalQaPreparations).where(eq(formalQaPreparations.companyId, companyId)),
    ).resolves.toEqual([]);
  });

  it("durably rotates beyond the first 25 enabled policies", async () => {
    for (let index = 0; index < 26; index += 1) await seed();
    let calls = 0;
    const service = formalQaGitHubDiscoveryService(db, {
      fetch: async () => { calls += 1; return new Response("[]", { status: 200 }); },
      tokenProvider: async () => "token",
      discoveryIntervalMs: 60_000,
    });

    await expect(service.reconcileOpenPulls()).resolves.toMatchObject({ policiesScanned: 25 });
    await expect(service.reconcileOpenPulls()).resolves.toMatchObject({ policiesScanned: 1 });
    expect(calls).toBe(26);
  });

  it("continues after the first ten GitHub pages instead of replaying page one", async () => {
    const { companyId } = await seed();
    const pages: number[] = [];
    const service = formalQaGitHubDiscoveryService(db, {
      fetch: async (url) => {
        const page = Number(new URL(url).searchParams.get("page"));
        pages.push(page);
        return new Response("[]", {
          status: 200,
          headers: page <= 10 ? { link: `<https://api.github.com/example?page=${page + 1}>; rel="next"` } : {},
        });
      },
      tokenProvider: async () => "token",
      discoveryIntervalMs: 60_000,
    });

    await expect(service.reconcileOpenPulls({ companyId })).resolves.toMatchObject({ policiesScanned: 1, deferred: 0 });
    await expect(service.reconcileOpenPulls({ companyId })).resolves.toMatchObject({ policiesScanned: 1, deferred: 0 });
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});
