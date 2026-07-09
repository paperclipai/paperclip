import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { HttpError } from "../errors.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue trigger date tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue trigger date", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-trigger-at-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "TRG") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Agent`,
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    triggerAt?: Date | null;
    assigneeAgentId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: `Issue ${input.identifier}`,
      status: "todo",
      priority: "medium",
      originKind: "manual",
      originFingerprint: "default",
      triggerAt: input.triggerAt ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
    });
    return id;
  }

  it("rejects checkout while the trigger date is in the future", async () => {
    const { companyId, agentId } = await createCompany();
    const triggerAt = new Date(Date.now() + 60 * 60 * 1000);
    const issueId = await insertIssue({
      companyId,
      identifier: "TRG-1",
      triggerAt,
      assigneeAgentId: agentId,
    });

    const error = await svc.checkout(issueId, agentId, ["todo"], null).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(422);
    expect((error as HttpError).details).toMatchObject({
      triggerAt: triggerAt.toISOString(),
    });
  });

  it("allows checkout once the trigger date has passed", async () => {
    const { companyId, agentId } = await createCompany();
    const issueId = await insertIssue({
      companyId,
      identifier: "TRG-2",
      triggerAt: new Date(Date.now() - 60 * 1000),
      assigneeAgentId: agentId,
    });

    const checkedOut = await svc.checkout(issueId, agentId, ["todo"], null);
    expect(checkedOut?.status).toBe("in_progress");
  });

  it("allows checkout when no trigger date is set", async () => {
    const { companyId, agentId } = await createCompany();
    const issueId = await insertIssue({
      companyId,
      identifier: "TRG-3",
      assigneeAgentId: agentId,
    });

    const checkedOut = await svc.checkout(issueId, agentId, ["todo"], null);
    expect(checkedOut?.status).toBe("in_progress");
  });
});
