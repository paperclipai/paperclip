import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  chatActions,
  chatConversations,
  chatEndpoints,
  chatPublications,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { enqueueTerminalIssueInteractionChatPublications } from "../services/chat-interaction-publications.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres(
  "terminal native chat interaction publications",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;
    const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;

    beforeAll(async () => {
      process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example";
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-terminal-chat-interaction-",
      );
      db = createDb(tempDb.connectionString);
    }, 20_000);

    afterAll(async () => {
      if (previousPublicUrl === undefined)
        delete process.env.PAPERCLIP_PUBLIC_URL;
      else process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
      await tempDb?.cleanup();
    });

    async function seedBoundIssue(
      providers: ChatProvider[] = ["slack", "telegram"],
    ) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `Terminal chat ${companyId}`,
        issuePrefix: `TC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Native chat agent",
        role: "operator",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Resolve the native provider card",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      });

      const endpointIds: Record<string, string> = {};
      for (const provider of providers) {
        const applicationId = randomUUID();
        const connectionId = randomUUID();
        const endpointId = randomUUID();
        endpointIds[provider] = endpointId;
        await db.insert(toolApplications).values({
          id: applicationId,
          companyId,
          applicationKey: `chat:${provider}:${endpointId}`,
          name: `${provider} ${endpointId}`,
          type: "chat",
          status: "active",
        });
        await db.insert(toolConnections).values({
          id: connectionId,
          companyId,
          applicationId,
          name: `${provider} channel`,
          uid: `chat-${provider}-${endpointId}`,
          connectionPurpose: "channel",
          transport: "chat_sdk",
          status: "active",
          enabled: true,
        });
        await db.insert(chatEndpoints).values({
          id: endpointId,
          companyId,
          connectionId,
          provider,
          publicId: randomUUID(),
          assignedAgentId: agentId,
          status: "active",
          capabilities: {
            threads: true,
            directMessages: true,
            nativeStreaming: false,
            messageEdits: true,
            messageDeletes: false,
            reactions: true,
            files: true,
            cards: true,
            actions: true,
            modals: provider !== "telegram",
            slashCommands: true,
            ephemeralMessages: provider === "slack",
            proactiveDirectMessages: true,
          },
        });
        await db.insert(chatConversations).values({
          companyId,
          endpointId,
          issueId,
          externalConversationId: `${provider}-conversation`,
          externalThreadId: `${provider}:thread:${issueId}`,
          externalLabel: `${provider} thread`,
          state: "active",
        });
      }
      return { agentId, companyId, endpointIds, issueId };
    }

    async function markInteractionCardsPublished(
      companyId: string,
      interactionId: string,
    ) {
      const originals = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, companyId),
            eq(
              sql<string>`${chatPublications.payload}->>'interactionId'`,
              interactionId,
            ),
          ),
        );
      for (const original of originals) {
        await db
          .update(chatPublications)
          .set({
            state: "published",
            providerMessageId: `provider-${original.endpointId}`,
          })
          .where(eq(chatPublications.id, original.id));
      }
      return originals;
    }

    async function publicationsForInteraction(
      companyId: string,
      interactionId: string,
    ) {
      return db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, companyId),
            eq(
              sql<string>`${chatPublications.payload}->>'interactionId'`,
              interactionId,
            ),
          ),
        );
    }

    function interceptAfterFirstSelect(
      afterSelect: () => Promise<void>,
    ): Parameters<typeof enqueueTerminalIssueInteractionChatPublications>[0] {
      let intercepted = false;
      const wrapQuery = (query: any): any =>
        new Proxy(query, {
          get(target, property) {
            if (property === "then") {
              return (onFulfilled: unknown, onRejected: unknown) =>
                Promise.resolve(target)
                  .then(async (value) => {
                    if (!intercepted) {
                      intercepted = true;
                      await afterSelect();
                    }
                    return value;
                  })
                  .then(onFulfilled as never, onRejected as never);
            }
            const member = Reflect.get(target, property, target);
            return typeof member === "function"
              ? (...args: unknown[]) =>
                  wrapQuery(Reflect.apply(member, target, args))
              : member;
          },
        });
      return {
        select: ((...args: unknown[]) =>
          wrapQuery(Reflect.apply(db.select, db, args))) as typeof db.select,
        insert: db.insert.bind(db),
        update: db.update.bind(db),
      };
    }

    it("publishes prompts only for the endpoint's verified immutable agent", async () => {
      const fixture = await seedBoundIssue();
      const service = issueThreadInteractionService(db);
      const foreignAgentId = randomUUID();
      await db.insert(agents).values({
        id: foreignAgentId,
        companyId: fixture.companyId,
        name: "Foreign agent",
        role: "operator",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      const foreignRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: foreignRunId,
        companyId: fixture.companyId,
        agentId: foreignAgentId,
        status: "succeeded",
      });
      const question = {
        kind: "ask_user_questions" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "priority",
              prompt: "Which priority?",
              selectionMode: "single" as const,
              allowOther: false,
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      };

      const userAuthored = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        question,
        { userId: "board-user" },
      );
      const foreignAuthored = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        question,
        { agentId: foreignAgentId },
      );
      const mismatchedRun = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        { ...question, sourceRunId: foreignRunId },
        { agentId: fixture.agentId },
      );

      await expect(
        publicationsForInteraction(fixture.companyId, userAuthored.id),
      ).resolves.toEqual([]);
      await expect(
        publicationsForInteraction(fixture.companyId, foreignAuthored.id),
      ).resolves.toEqual([]);
      await expect(
        publicationsForInteraction(fixture.companyId, mismatchedRun.id),
      ).resolves.toEqual([]);

      const assignedAgent = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        question,
        { agentId: fixture.agentId },
      );
      const publications = await publicationsForInteraction(
        fixture.companyId,
        assignedAgent.id,
      );
      expect(publications).toHaveLength(2);
      expect(
        publications.every(
          (row) =>
            row.idempotencyKey ===
            `interaction:${assignedAgent.id}:${row.endpointId}`,
        ),
      ).toBe(true);
    });

    it("keeps unsupported governance interactions authoritative in Paperclip", async () => {
      const fixture = await seedBoundIssue();
      const interaction = await issueThreadInteractionService(db).create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "request_checkbox_confirmation",
          payload: {
            version: 1,
            prompt: "Choose deployment regions",
            options: [{ id: "us", label: "US" }],
          },
        },
        { agentId: fixture.agentId },
      );

      await expect(
        publicationsForInteraction(fixture.companyId, interaction.id),
      ).resolves.toEqual([]);
    });

    it("settles a card when the dispatcher claims it between the read and cancellation CAS", async () => {
      const fixture = await seedBoundIssue(["slack"]);
      const service = issueThreadInteractionService(db);
      const interaction = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          payload: {
            version: 1,
            questions: [
              {
                id: "priority",
                prompt: "Which priority?",
                selectionMode: "single",
                allowOther: false,
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
        { agentId: fixture.agentId },
      );
      const [original] = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      if (!original) throw new Error("Expected an original publication");
      await db
        .update(issueThreadInteractions)
        .set({
          status: "answered",
          result: {
            version: 1,
            answers: [{ questionId: "priority", optionIds: ["high"] }],
            summaryMarkdown: null,
          },
          resolvedByUserId: "board-user",
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issueThreadInteractions.id, interaction.id));
      const answered = await service.getById(interaction.id);
      if (!answered) throw new Error("Expected an answered interaction");

      const raceDb = interceptAfterFirstSelect(async () => {
        const claimed = await db
          .update(chatPublications)
          .set({ state: "streaming", updatedAt: new Date() })
          .where(
            and(
              eq(chatPublications.id, original.id),
              eq(chatPublications.state, "pending"),
            ),
          )
          .returning({ id: chatPublications.id });
        expect(claimed).toEqual([{ id: original.id }]);
      });
      await enqueueTerminalIssueInteractionChatPublications(raceDb, answered);

      await expect(
        db
          .select({ state: chatPublications.state })
          .from(chatPublications)
          .where(eq(chatPublications.id, original.id)),
      ).resolves.toEqual([{ state: "streaming" }]);
      const publications = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      expect(publications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            idempotencyKey: `interaction-resolution:${interaction.id}:${fixture.endpointIds.slack}`,
            state: "pending",
            payload: expect.objectContaining({ text: "Answered: High." }),
          }),
        ]),
      );
    });

    it("settles an ambiguously delivered link-only card after an operator marks it delivered", async () => {
      const fixture = await seedBoundIssue(["github"]);
      const service = issueThreadInteractionService(db);
      const interaction = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "request_confirmation",
          continuationPolicy: "wake_assignee",
          payload: { version: 1, prompt: "Ship the GitHub release?" },
        },
        { agentId: fixture.agentId },
      );
      const [original] = await publicationsForInteraction(
        fixture.companyId,
        interaction.id,
      );
      if (!original) throw new Error("Expected a GitHub link-only card");
      await db
        .update(chatPublications)
        .set({ state: "published", providerMessageId: null })
        .where(eq(chatPublications.id, original.id));

      await service.acceptInteraction(
        {
          id: fixture.issueId,
          companyId: fixture.companyId,
          projectId: null,
          goalId: null,
        },
        interaction.id,
        {},
        { userId: "board-user" },
      );

      await expect(
        db
          .select({
            idempotencyKey: chatPublications.idempotencyKey,
            payload: chatPublications.payload,
            state: chatPublications.state,
          })
          .from(chatPublications)
          .where(
            eq(
              chatPublications.idempotencyKey,
              `interaction-resolution:${interaction.id}:${fixture.endpointIds.github}`,
            ),
          ),
      ).resolves.toEqual([
        {
          idempotencyKey: `interaction-resolution:${interaction.id}:${fixture.endpointIds.github}`,
          payload: expect.objectContaining({
            interactionId: interaction.id,
            text: "Accepted.",
          }),
          state: "pending",
        },
      ]);
    });

    it("settles UI answers and skips on every provider-native card with no live actions", async () => {
      const fixture = await seedBoundIssue();
      const service = issueThreadInteractionService(db);
      const questionInput = {
        kind: "ask_user_questions" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "priority",
              prompt: "Which priority?",
              selectionMode: "single" as const,
              allowOther: false,
              options: [
                { id: "high", label: "High" },
                { id: "normal", label: "Normal" },
              ],
            },
          ],
        },
      };
      const answeredQuestion = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        questionInput,
        { agentId: fixture.agentId },
      );
      expect(
        await markInteractionCardsPublished(
          fixture.companyId,
          answeredQuestion.id,
        ),
      ).toHaveLength(2);

      const answered = await service.answerQuestions(
        { id: fixture.issueId, companyId: fixture.companyId },
        answeredQuestion.id,
        { answers: [{ questionId: "priority", optionIds: ["high"] }] },
        { userId: "board-user" },
      );
      const answeredSettlements = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, fixture.companyId),
            eq(
              sql<string>`${chatPublications.payload}->>'interactionId'`,
              answeredQuestion.id,
            ),
            eq(chatPublications.state, "pending"),
          ),
        );
      expect(answeredSettlements).toHaveLength(2);
      expect(answeredSettlements).toEqual(
        expect.arrayContaining(
          Object.values(fixture.endpointIds).map((endpointId) =>
            expect.objectContaining({
              endpointId,
              idempotencyKey: `interaction-resolution:${answeredQuestion.id}:${endpointId}`,
              payload: expect.objectContaining({
                text: "Answered: High.",
                card: expect.objectContaining({
                  kind: "question",
                  title: "Which priority?",
                  body: "Answered: High.",
                }),
              }),
            }),
          ),
        ),
      );
      expect(
        answeredSettlements.every(
          (row) => (row.payload.card?.actions ?? []).length === 0,
        ),
      ).toBe(true);
      await expect(
        enqueueTerminalIssueInteractionChatPublications(db, answered),
      ).resolves.toEqual([]);
      await expect(
        db
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(
            eq(
              sql<string>`${chatActions.payload}->>'interactionId'`,
              answeredQuestion.id,
            ),
          ),
      ).resolves.toEqual([
        { status: "expired" },
        { status: "expired" },
        { status: "expired" },
        { status: "expired" },
      ]);

      const skippedQuestion = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        questionInput,
        { agentId: fixture.agentId },
      );
      await markInteractionCardsPublished(
        fixture.companyId,
        skippedQuestion.id,
      );
      await service.skipInteraction(
        {
          id: fixture.issueId,
          companyId: fixture.companyId,
          status: "in_progress",
        },
        skippedQuestion.id,
        {},
        { userId: "board-user" },
      );
      const skippedSettlements = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, fixture.companyId),
            eq(
              sql<string>`${chatPublications.payload}->>'interactionId'`,
              skippedQuestion.id,
            ),
            eq(chatPublications.state, "pending"),
          ),
        );
      expect(skippedSettlements).toHaveLength(2);
      expect(
        skippedSettlements.every(
          (row) => row.payload.card?.body === "Skipped in Paperclip.",
        ),
      ).toBe(true);
      expect(
        skippedSettlements.every(
          (row) => (row.payload.card?.actions ?? []).length === 0,
        ),
      ).toBe(true);
      await expect(
        db
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.kind, "interaction_wakeup"),
              eq(
                sql<string>`${chatActions.payload}->>'interactionId'`,
                skippedQuestion.id,
              ),
            ),
          ),
      ).resolves.toEqual([]);
    });

    it("settles native and link-only confirmation cards without inventing controls", async () => {
      const fixture = await seedBoundIssue();
      const service = issueThreadInteractionService(db);
      for (const outcome of ["accept", "reject"] as const) {
        const interaction = await service.create(
          { id: fixture.issueId, companyId: fixture.companyId },
          {
            kind: "request_confirmation",
            continuationPolicy: "wake_assignee",
            payload: { version: 1, prompt: `Should we ${outcome}?` },
          },
          { agentId: fixture.agentId },
        );
        const originals = await markInteractionCardsPublished(
          fixture.companyId,
          interaction.id,
        );
        expect(originals).toHaveLength(2);
        expect(
          originals.find((row) => row.endpointId === fixture.endpointIds.slack)
            ?.payload.card?.actions,
        ).toEqual([
          expect.objectContaining({ type: "link", label: "Open in Paperclip" }),
        ]);
        expect(
          originals.find(
            (row) => row.endpointId === fixture.endpointIds.telegram,
          )?.payload.card?.actions,
        ).toEqual([
          expect.objectContaining({ type: "callback" }),
          expect.objectContaining({ type: "callback" }),
        ]);

        if (outcome === "accept") {
          await service.acceptInteraction(
            {
              id: fixture.issueId,
              companyId: fixture.companyId,
              projectId: null,
              goalId: null,
            },
            interaction.id,
            {},
            { userId: "board-user" },
          );
        } else {
          await service.rejectInteraction(
            { id: fixture.issueId, companyId: fixture.companyId },
            interaction.id,
            {},
            { userId: "board-user" },
          );
        }

        const settlements = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.companyId, fixture.companyId),
              eq(
                sql<string>`${chatPublications.payload}->>'interactionId'`,
                interaction.id,
              ),
              eq(chatPublications.state, "pending"),
            ),
          );
        expect(settlements).toHaveLength(2);
        expect(settlements).toEqual(
          expect.arrayContaining(
            Object.values(fixture.endpointIds).map((endpointId) =>
              expect.objectContaining({
                endpointId,
                idempotencyKey: `interaction-resolution:${interaction.id}:${endpointId}`,
                payload: expect.objectContaining({
                  text: outcome === "accept" ? "Accepted." : "Rejected.",
                  card: expect.objectContaining({
                    kind: "confirmation",
                    title: `Should we ${outcome}?`,
                    body: outcome === "accept" ? "Accepted" : "Rejected",
                  }),
                }),
              }),
            ),
          ),
        );
        expect(
          settlements.every(
            (settlement) =>
              (settlement.payload.card?.actions ?? []).length === 0,
          ),
        ).toBe(true);
        await expect(
          db
            .select({
              kind: chatActions.kind,
              payload: chatActions.payload,
              status: chatActions.status,
            })
            .from(chatActions)
            .where(
              and(
                eq(chatActions.kind, "interaction_wakeup"),
                eq(
                  sql<string>`${chatActions.payload}->>'interactionId'`,
                  interaction.id,
                ),
              ),
            ),
        ).resolves.toEqual([
          {
            kind: "interaction_wakeup",
            payload: expect.objectContaining({
              agentId: fixture.agentId,
              interactionId: interaction.id,
              interactionStatus: outcome === "accept" ? "accepted" : "rejected",
              issueId: fixture.issueId,
              requestedByActorId: "board-user",
              requestedByActorType: "user",
            }),
            status: "issued",
          },
        ]);
      }
    });

    it("expires both modal action tokens when a form-backed question is answered", async () => {
      const fixture = await seedBoundIssue(["slack"]);
      const service = issueThreadInteractionService(db);
      const interaction = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          continuationPolicy: "wake_assignee",
          payload: {
            version: 1,
            questions: [
              {
                id: "priority",
                prompt: "Which priority?",
                selectionMode: "single",
                allowOther: false,
                options: [{ id: "high", label: "High" }],
              },
              {
                id: "owner",
                prompt: "Who owns it?",
                selectionMode: "single",
                allowOther: false,
                options: [{ id: "agent", label: "Agent" }],
              },
            ],
          },
        },
        { agentId: fixture.agentId },
      );
      await markInteractionCardsPublished(fixture.companyId, interaction.id);
      await service.answerQuestions(
        { id: fixture.issueId, companyId: fixture.companyId },
        interaction.id,
        {
          answers: [
            { questionId: "priority", optionIds: ["high"] },
            { questionId: "owner", optionIds: ["agent"] },
          ],
        },
        { userId: "board-user" },
      );

      const actions = await db
        .select({ kind: chatActions.kind, status: chatActions.status })
        .from(chatActions)
        .where(
          eq(
            sql<string>`${chatActions.payload}->>'interactionId'`,
            interaction.id,
          ),
        );
      expect(actions).toEqual(
        expect.arrayContaining([
          { kind: "question_form_open", status: "expired" },
          { kind: "question_form_submit", status: "expired" },
        ]),
      );
      expect(actions).toHaveLength(2);
    });

    it("cancels unsent native and link-only cards instead of publishing stale prompts", async () => {
      const fixture = await seedBoundIssue();
      const service = issueThreadInteractionService(db);
      const interaction = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "request_confirmation",
          payload: { version: 1, prompt: "Proceed?" },
        },
        { agentId: fixture.agentId },
      );
      await service.acceptInteraction(
        {
          id: fixture.issueId,
          companyId: fixture.companyId,
          projectId: null,
          goalId: null,
        },
        interaction.id,
        {},
        { userId: "board-user" },
      );

      const publications = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, fixture.companyId),
            eq(
              sql<string>`${chatPublications.payload}->>'interactionId'`,
              interaction.id,
            ),
          ),
        );
      expect(publications).toHaveLength(2);
      expect(publications).toEqual(
        expect.arrayContaining(
          Object.values(fixture.endpointIds).map((endpointId) =>
            expect.objectContaining({
              endpointId,
              idempotencyKey: `interaction:${interaction.id}:${endpointId}`,
              state: "cancelled",
              redactedError:
                "Interaction was resolved before provider publication",
            }),
          ),
        ),
      );
      expect(
        publications.some((row) =>
          row.payload.card?.actions?.some((action) => action.type === "link"),
        ),
      ).toBe(true);
    });

    it("settles visible question cards when a newer interaction supersedes them", async () => {
      const fixture = await seedBoundIssue();
      const service = issueThreadInteractionService(db);
      const input = {
        kind: "ask_user_questions" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "priority",
              prompt: "Which priority?",
              selectionMode: "single" as const,
              allowOther: false,
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      };
      const original = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        input,
        { agentId: fixture.agentId },
      );
      await markInteractionCardsPublished(fixture.companyId, original.id);

      const replacement = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        input,
        { agentId: fixture.agentId },
      );

      await expect(service.getById(original.id)).resolves.toMatchObject({
        status: "expired",
        result: {
          expirationReason: "superseded_by_newer_interaction",
          supersededByInteractionId: replacement.id,
        },
      });
      const publications = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, fixture.companyId),
            eq(
              sql<string>`${chatPublications.payload}->>'interactionId'`,
              original.id,
            ),
          ),
        );
      const settlements = publications.filter((row) =>
        row.idempotencyKey.startsWith("interaction-resolution:"),
      );
      expect(settlements).toHaveLength(2);
      expect(
        settlements.every(
          (row) =>
            row.state === "pending" &&
            row.payload.text === "Expired: replaced by a newer request." &&
            row.payload.card?.body === "Expired: replaced by a newer request" &&
            (row.payload.card.actions ?? []).length === 0,
        ),
      ).toBe(true);
    });

    it("settles live and historical human-comment supersessions", async () => {
      const fixture = await seedBoundIssue();
      const service = issueThreadInteractionService(db);
      const confirmation = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "request_confirmation",
          payload: { version: 1, prompt: "Proceed with the release?" },
        },
        { agentId: fixture.agentId },
      );
      await markInteractionCardsPublished(fixture.companyId, confirmation.id);
      const liveCommentId = randomUUID();
      await service.expireRequestConfirmationsSupersededByComment(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          id: liveCommentId,
          authorUserId: "board-user",
          createdByRunId: null,
          createdAt: new Date(Date.now() + 1_000),
        },
        { userId: "board-user" },
      );

      const liveSettlements = await db
        .select()
        .from(chatPublications)
        .where(
          eq(
            chatPublications.idempotencyKey,
            `interaction-resolution:${confirmation.id}:${fixture.endpointIds.telegram}`,
          ),
        );
      expect(liveSettlements).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            text: "Expired: superseded by a newer reply.",
            card: expect.objectContaining({
              body: "Expired: superseded by a newer reply",
            }),
          }),
        }),
      ]);
      expect(liveSettlements[0]?.payload.card?.actions ?? []).toHaveLength(0);

      const question = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          payload: {
            version: 1,
            questions: [
              {
                id: "priority",
                prompt: "Which priority?",
                selectionMode: "single",
                allowOther: false,
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
        { agentId: fixture.agentId },
      );
      await markInteractionCardsPublished(fixture.companyId, question.id);
      const questionCreatedAt = new Date("2026-09-05T12:00:00.000Z");
      await db
        .update(issueThreadInteractions)
        .set({ createdAt: questionCreatedAt, updatedAt: questionCreatedAt })
        .where(eq(issueThreadInteractions.id, question.id));
      await db.insert(issueComments).values({
        id: randomUUID(),
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        authorUserId: "board-user",
        authorType: "user",
        body: "Use the high-priority path.",
        createdAt: new Date("2026-09-05T12:01:00.000Z"),
        updatedAt: new Date("2026-09-05T12:01:00.000Z"),
      });
      await service.expireRequestConfirmationsSupersededByHistoricalComments({
        id: fixture.issueId,
        companyId: fixture.companyId,
      });

      const historicalSettlements = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, fixture.companyId),
            eq(
              sql<string>`${chatPublications.payload}->>'interactionId'`,
              question.id,
            ),
            eq(chatPublications.state, "pending"),
          ),
        );
      expect(historicalSettlements).toHaveLength(2);
      expect(
        historicalSettlements.every(
          (row) =>
            row.payload.card?.body === "Expired: superseded by a newer reply" &&
            (row.payload.card.actions ?? []).length === 0,
        ),
      ).toBe(true);
    });

    it("cancels stale-target prompts and settles terminal-issue expirations", async () => {
      const fixture = await seedBoundIssue();
      const service = issueThreadInteractionService(db);
      const documentId = randomUUID();
      const revisionId = randomUUID();
      const nextRevisionId = randomUUID();
      await db.insert(documents).values({
        id: documentId,
        companyId: fixture.companyId,
        title: "Plan",
        format: "markdown",
        latestBody: "v1",
        latestRevisionId: revisionId,
        latestRevisionNumber: 1,
      });
      await db.insert(issueDocuments).values({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        documentId,
        key: "plan",
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId: fixture.companyId,
        documentId,
        revisionNumber: 1,
        title: "Plan",
        format: "markdown",
        body: "v1",
      });

      const confirmation = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "request_confirmation",
          payload: {
            version: 1,
            prompt: "Apply this plan?",
            target: {
              type: "issue_document",
              issueId: fixture.issueId,
              documentId,
              key: "plan",
              revisionId,
              revisionNumber: 1,
            },
          },
        },
        { agentId: fixture.agentId },
      );
      await service.expireStaleRequestConfirmationsForIssueDocument(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          id: documentId,
          key: "plan",
          latestRevisionId: nextRevisionId,
          latestRevisionNumber: 2,
        },
        { userId: "board-user" },
      );
      const stalePublications = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, fixture.companyId),
            eq(
              sql<string>`${chatPublications.payload}->>'interactionId'`,
              confirmation.id,
            ),
          ),
        );
      expect(stalePublications).toHaveLength(2);
      expect(
        stalePublications.every(
          (row) =>
            row.state === "cancelled" &&
            row.redactedError ===
              "Interaction was resolved before provider publication",
        ),
      ).toBe(true);

      const question = await service.create(
        { id: fixture.issueId, companyId: fixture.companyId },
        {
          kind: "ask_user_questions",
          payload: {
            version: 1,
            questions: [
              {
                id: "priority",
                prompt: "Which priority?",
                selectionMode: "single",
                allowOther: false,
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
        { agentId: fixture.agentId },
      );
      await markInteractionCardsPublished(fixture.companyId, question.id);
      await service.expirePendingInteractionsForTerminalIssue(
        {
          id: fixture.issueId,
          companyId: fixture.companyId,
          status: "done",
        },
        { userId: "board-user" },
      );
      const closedSettlements = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, fixture.companyId),
            eq(
              sql<string>`${chatPublications.payload}->>'interactionId'`,
              question.id,
            ),
            eq(chatPublications.state, "pending"),
          ),
        );
      expect(closedSettlements).toHaveLength(2);
      expect(
        closedSettlements.every(
          (row) =>
            row.payload.text === "Expired: task is closed." &&
            row.payload.card?.body === "Expired: task is closed" &&
            (row.payload.card.actions ?? []).length === 0,
        ),
      ).toBe(true);
    });
  },
);
