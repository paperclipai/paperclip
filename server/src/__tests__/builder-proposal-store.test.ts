import { randomUUID } from "node:crypto";
import {
  builderMessages,
  builderProposals,
  builderSessions,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { builderProposalStore } from "../services/builder/proposal-store.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres builder proposal store tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("builderProposalStore.updateStatusFromApproval", () => {
  let db!: ReturnType<typeof createDb>;
  let store!: ReturnType<typeof builderProposalStore>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-builder-proposal-store-");
    db = createDb(tempDb.connectionString);
    store = builderProposalStore(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(builderProposals);
    await db.delete(builderMessages);
    await db.delete(builderSessions);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("stamps decidedAt when an approval-driven proposal becomes applied", async () => {
    const companyId = randomUUID();
    const sessionId = randomUUID();
    const messageId = randomUUID();
    const proposalId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Bizbox",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(builderSessions).values({
      id: sessionId,
      companyId,
      createdByUserId: "user-1",
      title: "Builder session",
      adapterType: "claude_local",
      model: "test-model",
    });

    await db.insert(builderMessages).values({
      id: messageId,
      sessionId,
      companyId,
      sequence: 1,
      role: "assistant",
      content: { text: "ready" },
    });

    await db.insert(builderProposals).values({
      id: proposalId,
      sessionId,
      messageId,
      companyId,
      kind: "hire_agent",
      payload: { role: "engineer" },
      status: "pending",
    });

    const updated = await store.updateStatusFromApproval(proposalId, "applied", "user-1");

    expect(updated).not.toBeNull();
    expect(updated).toMatchObject({
      id: proposalId,
      status: "applied",
      decidedByUserId: "user-1",
    });
    expect(updated?.decidedAt).toBeInstanceOf(Date);
  });
});
