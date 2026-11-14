import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueThreadInteractions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildPaperclipWakePayload, readAddressedInteractionWake } from "../services/heartbeat/run-preparation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("addressed interaction wake context", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-addressed-interaction-wake-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(card: { kind?: string; status?: string; addressee?: "manager" | "owner" | "other" | null } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Addressed Co",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agent = async (name: string) => (await db.insert(agents).values({
      companyId, name, role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: {}, permissions: {},
    }).returning())[0]!;
    const owner = await agent("Engineer");
    const manager = await agent("Manager");
    const other = await agent("Bystander");
    const [issue] = await db.insert(issues).values({
      companyId, title: "Build the core", status: "in_progress", priority: "medium", assigneeAgentId: owner.id,
    }).returning();
    const addresseeId = card.addressee === undefined || card.addressee === "manager"
      ? manager.id
      : card.addressee === "owner" ? owner.id : card.addressee === "other" ? other.id : null;
    const kind = card.kind ?? "ask_user_questions";
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: issue!.id,
      kind,
      status: card.status ?? "pending",
      continuationPolicy: "wake_assignee",
      payload: kind === "ask_user_questions"
        ? { version: 1, questions: [{ id: "q1", prompt: "Which secret scanner?", selectionMode: "single",
            options: [{ id: "a", label: "Gitleaks" }] }] }
        : { version: 1, prompt: "Approve the scanner change?" },
      createdByAgentId: owner.id,
      addresseeAgentId: addresseeId,
      ...(card.status && card.status !== "pending" ? { resolvedAt: new Date() } : {}),
    }).returning();
    const context = {
      issueId: issue!.id,
      wakeReason: "interaction_pending",
      interactionId: interaction!.id,
      interactionKind: kind,
      mutation: "interaction",
    };
    return { companyId, owner, manager, issueId: issue!.id, interactionId: interaction!.id, context };
  }

  it("describes a pending card addressed to a non-owner, with its answer route", async () => {
    const { companyId, manager, issueId, interactionId, context } = await seed();
    const addressed = await readAddressedInteractionWake({ db, companyId, agentId: manager.id, issueId, contextSnapshot: context });
    expect(addressed).toEqual({
      id: interactionId,
      kind: "ask_user_questions",
      prompt: "Which secret scanner?",
      promptTruncated: false,
      readPath: `/api/issues/${issueId}/interactions`,
      answerPaths: [`/api/issues/${issueId}/interactions/${interactionId}/respond`],
    });

    const payload = await buildPaperclipWakePayload({ db, companyId, agentId: manager.id, contextSnapshot: context });
    expect(payload?.addressedInteraction).toEqual(addressed);
  });

  it("offers accept and reject for a confirmation card", async () => {
    const { companyId, manager, issueId, interactionId, context } = await seed({ kind: "request_confirmation" });
    const addressed = await readAddressedInteractionWake({ db, companyId, agentId: manager.id, issueId, contextSnapshot: context });
    expect(addressed?.prompt).toBe("Approve the scanner change?");
    expect(addressed?.answerPaths).toEqual([
      `/api/issues/${issueId}/interactions/${interactionId}/accept`,
      `/api/issues/${issueId}/interactions/${interactionId}/reject`,
    ]);
  });

  it.each([
    { name: "the card is answered", card: { status: "answered" }, agent: "manager" },
    { name: "the card is addressed to someone else", card: { addressee: "other" as const }, agent: "manager" },
    { name: "the card has no addressee", card: { addressee: null }, agent: "manager" },
    { name: "the addressee owns the issue", card: { addressee: "owner" as const }, agent: "owner" },
  ])("adds nothing when $name", async ({ card, agent }) => {
    const seeded = await seed(card);
    const agentId = agent === "owner" ? seeded.owner.id : seeded.manager.id;
    expect(await readAddressedInteractionWake({
      db, companyId: seeded.companyId, agentId, issueId: seeded.issueId, contextSnapshot: seeded.context,
    })).toBeNull();
  });

  it("adds nothing for other wake reasons or another company", async () => {
    const { companyId, manager, issueId, context } = await seed();
    expect(await readAddressedInteractionWake({
      db, companyId, agentId: manager.id, issueId, contextSnapshot: { ...context, wakeReason: "issue_commented" },
    })).toBeNull();
    expect(await readAddressedInteractionWake({
      db, companyId: randomUUID(), agentId: manager.id, issueId, contextSnapshot: context,
    })).toBeNull();
  });
});
