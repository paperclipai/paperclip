import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companySecretProposals,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import { canReadDecisionSource } from "../services/decision-queues.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres secret proposal attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = Date.parse("2026-07-09T12:00:00.000Z");
const DAY = 86_400_000;

describeEmbeddedPostgres("attention: pending secret proposals (#22712)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-secret-proposals-");
    db = createDb(externalUrl ?? tempDb!.connectionString, { maxConnections: 4 });
  }, 30_000);

  afterEach(async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      await tx.execute(sql`TRUNCATE TABLE companies CASCADE`);
    });
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seed(prefix: string) {
    const companyId = randomUUID();
    const proposerId = randomUUID();
    const targetId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `${prefix} Co`, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: proposerId, companyId, name: "PlatformEng", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: targetId, companyId, name: "QA", role: "qa", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, identifier: `${prefix}-1`, title: "Rotate a token", status: "in_progress",
      priority: "medium", assigneeAgentId: proposerId, originKind: "manual", originFingerprint: "default",
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: proposerId, invocationSource: "assignment", status: "succeeded",
      contextSnapshot: { issueId }, createdAt: new Date(NOW - DAY), updatedAt: new Date(NOW - DAY),
    });
    return { companyId, proposerId, targetId, issueId, runId };
  }

  const ciphertext = { scheme: "test", data: "SECRET-CIPHERTEXT-MUST-NOT-LEAK" };
  const fingerprint = "f".repeat(64);

  async function insertSecretProposal(s: Awaited<ReturnType<typeof seed>>, input: { name: string; status?: string; expiresAt?: Date }) {
    const id = randomUUID();
    await db.insert(companySecretProposals).values({
      id, companyId: s.companyId, kind: "secret", status: input.status ?? "pending",
      proposedName: input.name, proposedKey: input.name.split("/").at(-1)!, justification: "rotate",
      valueCiphertext: ciphertext, valueFingerprintSha256: fingerprint, valueLength: 42,
      proposedByAgentId: s.proposerId, originIssueId: s.issueId, originRunId: s.runId,
      expiresAt: input.expiresAt ?? new Date(NOW + 10 * DAY),
      createdAt: new Date(NOW - 60_000), updatedAt: new Date(NOW - 60_000),
    });
    return id;
  }

  async function insertBindingProposal(s: Awaited<ReturnType<typeof seed>>, input: { secretProposalId: string; configPath: string; cardStatus?: string }) {
    let interactionId: string | null = null;
    if (input.cardStatus) {
      interactionId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: interactionId, companyId: s.companyId, issueId: s.issueId, kind: "request_confirmation", status: input.cardStatus,
        title: "Confirm secret binding", createdByAgentId: s.proposerId, addresseeUserId: "board-user",
        payload: { version: 1, prompt: "Bind?" },
      });
    }
    const id = randomUUID();
    await db.insert(companySecretProposals).values({
      id, companyId: s.companyId, kind: "binding", status: "pending", justification: "bind",
      secretProposalId: input.secretProposalId, targetType: "agent", targetId: s.targetId, configPath: input.configPath,
      proposedByAgentId: s.proposerId, originIssueId: s.issueId, originRunId: s.runId, interactionId,
      expiresAt: new Date(NOW + 10 * DAY), createdAt: new Date(NOW - 30_000), updatedAt: new Date(NOW - 30_000),
    });
    return id;
  }

  const list = (companyId: string) => attentionService(db, { now: () => NOW }).list(companyId, { userId: "board-user", limit: 100 });
  const proposalItems = (feed: Awaited<ReturnType<typeof list>>) => feed.items.filter((item) => item.sourceKind === "secret_proposal");

  it("shows a pending secret proposal with its name, origin task and expiry, and never its value", async () => {
    const s = await seed("SPA");
    const id = await insertSecretProposal(s, { name: "infrastructure/korath/readonly-token" });

    const feed = await list(s.companyId);
    const items = proposalItems(feed);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({
      sourceKind: "secret_proposal",
      severity: "medium",
      inlineResolvable: false,
      dedupKey: `secret_proposal:${id}`,
      subject: {
        kind: "secret_proposal",
        id,
        title: "Secret proposal: infrastructure/korath/readonly-token",
        status: "pending",
        href: "/SPA/company/settings/secrets?tab=proposals",
        metadata: { kind: "secret", proposerAgentId: s.proposerId, proposerAgentName: "PlatformEng", originIssueId: s.issueId },
      },
      relatedIssue: { kind: "issue", id: s.issueId, identifier: "SPA-1" },
    });
    expect(item.whyNow).toContain("Expires in 10d");
    expect(feed.countsBySourceKind.secret_proposal).toBe(1);
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain("SECRET-CIPHERTEXT-MUST-NOT-LEAK");
    expect(serialized).not.toContain(fingerprint);
    expect(serialized).not.toMatch(/valueLength|valueCiphertext|valueFingerprint/);
  });

  it("raises severity in the last 48 hours and says hours", async () => {
    const s = await seed("SPB");
    await insertSecretProposal(s, { name: "app/soon", expiresAt: new Date(NOW + 5 * 3_600_000) });
    const [item] = proposalItems(await list(s.companyId));
    expect(item.severity).toBe("high");
    expect(item.whyNow).toContain("Expires in 5h");
  });

  it("leaves out approved, rejected, withdrawn and past-expiry proposals", async () => {
    const s = await seed("SPC");
    await insertSecretProposal(s, { name: "app/approved", status: "approved" });
    await insertSecretProposal(s, { name: "app/rejected", status: "rejected" });
    await insertSecretProposal(s, { name: "app/withdrawn", status: "withdrawn" });
    await insertSecretProposal(s, { name: "app/lapsed", expiresAt: new Date(NOW - 1000) });
    expect(proposalItems(await list(s.companyId))).toHaveLength(0);
  });

  it("shows a binding without a live card, and leaves a binding with a pending card to that card", async () => {
    const s = await seed("SPD");
    const secretId = await insertSecretProposal(s, { name: "app/token" });
    const orphan = await insertBindingProposal(s, { secretProposalId: secretId, configPath: "env.APP_TOKEN", cardStatus: "expired" });
    const carded = await insertBindingProposal(s, { secretProposalId: secretId, configPath: "env.APP_TOKEN_TWO", cardStatus: "pending" });

    const items = proposalItems(await list(s.companyId));
    const ids = items.map((item) => item.subject.id);
    expect(ids).toContain(secretId);
    expect(ids).toContain(orphan);
    expect(ids).not.toContain(carded);
    expect(items.find((item) => item.subject.id === orphan)).toMatchObject({
      subject: {
        title: "Binding proposal: env.APP_TOKEN on QA",
        metadata: { kind: "binding", configPath: "env.APP_TOKEN", targetId: s.targetId, secretProposalId: secretId },
      },
    });
  });

  it("keeps each company's proposals to that company", async () => {
    const a = await seed("SPE");
    const b = await seed("SPF");
    const aId = await insertSecretProposal(a, { name: "app/a" });
    await insertSecretProposal(b, { name: "app/b" });
    expect(proposalItems(await list(a.companyId)).map((item) => item.subject.id)).toEqual([aId]);
  });

  it("respects excludeSources", async () => {
    const s = await seed("SPG");
    await insertSecretProposal(s, { name: "app/x" });
    const feed = await attentionService(db, { now: () => NOW }).list(s.companyId, { userId: "board-user", excludeSources: ["secret_proposal"] });
    expect(proposalItems(feed)).toHaveLength(0);
  });

  it("keeps a proposal board-only as a decision source, even for an agent that can read its origin task", async () => {
    const s = await seed("SPH");
    const id = await insertSecretProposal(s, { name: "app/y" });
    const agentActor = { type: "agent" as const, agentId: s.proposerId, companyId: s.companyId, runId: s.runId, source: "agent_key" as const };
    expect(await canReadDecisionSource(db, agentActor as never, s.companyId, "secret_proposal", id)).toBe(false);
    expect(await canReadDecisionSource(db, agentActor as never, s.companyId, "secret_proposal", randomUUID())).toBe(false);
  });
});
