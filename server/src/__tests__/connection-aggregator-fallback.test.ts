import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  goals,
  heartbeatRuns,
  issueThreadInteractions,
  issueComments,
  issues,
  createDb,
  toolApplications,
  toolConnections,
  connectionGrants,
  toolCatalogEntries,
  toolProfiles,
  toolProfileBindings,
  toolConnectionInstalls,
} from "@paperclipai/db";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "aggregator connection fallback",
  () => {
    let db!: ReturnType<typeof createDb>;
    let connectionString!: string;
    let cleanup: (() => Promise<void>) | undefined;
    let claims!: RuntimeToolsTokenClaims;
    let runId!: string;
    beforeAll(async () => {
      const tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-connection-intents-",
      );
      cleanup = tempDb.cleanup;
      connectionString = tempDb.connectionString;
      db = createDb(connectionString);
      const companyId = randomUUID();
      const agentId = randomUUID();
      const goalId = randomUUID();
      const issueId = randomUUID();
      runId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Connection tests",
        issuePrefix: "AGG",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "responsible-user",
        status: "active",
        membershipRole: "member",
      });
      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Connect a service",
        level: "task",
        status: "active",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Researcher",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        goalId,
        title: "Read Notion",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        responsibleUserId: "responsible-user",
        contextSnapshot: { issueId },
      });
      claims = {
        sub: agentId,
        company_id: companyId,
        run_id: runId,
        responsible_user_id: "responsible-user",
        scope: "connection_intents",
        iat: 1,
        exp: 2,
        instance_id: "test",
      };
    }, 60_000);

    afterAll(async () => {
      await cleanup?.();
    });

    async function userRequest(body: string, userId = "responsible-user") {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      await db
        .insert(issueComments)
        .values({
          companyId: claims.company_id,
          issueId: run!.contextSnapshot!.issueId as string,
          authorUserId: userId,
          body,
        });
    }
    async function resetQuestions() {
      await db
        .delete(issueComments)
        .where(eq(issueComments.companyId, claims.company_id));
      await db
        .delete(issueThreadInteractions)
        .where(eq(issueThreadInteractions.companyId, claims.company_id));
      await db
        .delete(toolConnections)
        .where(eq(toolConnections.companyId, claims.company_id));
      await db
        .delete(toolProfiles)
        .where(eq(toolProfiles.companyId, claims.company_id));
      await db
        .delete(toolApplications)
        .where(eq(toolApplications.companyId, claims.company_id));
    }
    async function selectProvider(
      option: string,
      userId = "responsible-user",
      query = "hubspot",
    ) {
      const result = await connectionIntentService(db).search(claims, query);
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      const issue = {
        id: run!.contextSnapshot!.issueId as string,
        companyId: claims.company_id,
      };
      const interaction = await issueThreadInteractionService(db).create(
        issue,
        {
          kind: "ask_user_questions",
          payload: { version: 1, questions: [result.providerQuestion!] },
          sourceRunId: runId,
          addresseeUserId: "responsible-user",
        },
        { agentId: claims.sub, runId },
      );
      // Public resolution service enforces human answer semantics; company membership
      // and wrong-identity request checks are also exercised below.
      await issueThreadInteractionService(db).answerQuestions(
        issue,
        interaction.id,
        {
          answers: [
            { questionId: result.providerQuestion!.id, optionIds: [option] },
          ],
        },
        { userId },
      );
      return interaction;
    }
    async function seedProvider(
      provider: string,
      toolName: string,
      userId = "responsible-user",
      allowed = true,
    ) {
      const [app] = await db
        .insert(toolApplications)
        .values({
          companyId: claims.company_id,
          applicationKey: randomUUID(),
          name: provider,
          type: "mcp_http",
          status: "active",
          metadata: { sourceTemplateKey: provider },
        })
        .returning();
      const [connection] = await db
        .insert(toolConnections)
        .values({
          companyId: claims.company_id,
          applicationId: app!.id,
          uid: randomUUID(),
          name: provider,
          transport: "mcp_remote",
          authKind: "none",
          credentialPolicy: "per_user",
          status: "active",
          enabled: true,
          healthStatus: "ok",
          config: { sourceTemplateKey: provider },
        })
        .returning();
      await db.insert(connectionGrants).values({
        companyId: claims.company_id,
        connectionId: connection!.id,
        kind: "user",
        subjectUserId: userId,
        status: "active",
      });
      await db.insert(toolCatalogEntries).values({
        companyId: claims.company_id,
        connectionId: connection!.id,
        toolName,
        name: toolName,
        versionHash: "fixture",
        status: "active",
        entryKind: "tool",
        lastSeenAt: new Date("2026-09-20T00:00:00Z"),
      });
      await db.insert(toolConnectionInstalls).values({
        companyId: claims.company_id,
        connectionId: connection!.id,
        targetType: "agent",
        targetId: claims.sub,
      });
      if (allowed) {
        const [profile] = await db
          .insert(toolProfiles)
          .values({
            companyId: claims.company_id,
            profileKey: randomUUID(),
            name: "Fixture reads",
            defaultAction: "allow",
            status: "active",
          })
          .returning();
        await db.insert(toolProfileBindings).values({
          companyId: claims.company_id,
          profileId: profile!.id,
          targetType: "agent",
          targetId: claims.sub,
        });
      }
      return connection!;
    }
    it.each([
      ["AgentMail create an email address and manage an agent mailbox", "agentmail"],
      ["Please acquire an email address through agent mail and remember it", "agentmail"],
      ["I need an Agentmial inbox for receiving mail from customers", "agentmail"],
      ["Please connect my Linear workspace so I can triage the team's backlog", "linear"],
      ["Find a Notion connection to search our engineering documentation", "notion"],
      ["Can you find the OpenRouter connection for the model I want to use?", "openrouter"],
      ["Please help me connect to Git Hub to look at my pull requests", "github"],
    ])("finds native connections in natural-language queries: %s", async (query, service) => {
      await resetQuestions();
      await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
      try {
        const result = await connectionIntentService(db).search(claims, query);
        expect(result.results[0]).toMatchObject({ service, state: "available" });
        expect(result.providerQuestion).toBeUndefined();
      } finally {
        await instanceSettingsService(db).updateExperimental({ enableChatConnectors: false });
      }
    });
    it("discovers all purposes with truthful setup actions and the chat feature gate", async () => {
      await resetQuestions();
      const service = connectionIntentService(db);
      expect((await service.search(claims, "agentmail")).results.some(item => item.service === "agentmail")).toBe(false);
      await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
      try {
        const result = await service.search(claims, "agentmail");
        expect(result.results[0]?.methods).toEqual([expect.objectContaining({
          key: "email-agent", purpose: "channel", setupPath: `/AGG/apps/chat/connect?provider=agentmail&purpose=chat&agentId=${claims.sub}`,
        })]);
        expect(result.instruction).toContain("setupPath");
        const browse = await service.search(claims, "");
        expect(browse.results.some(item => item.service === "agentmail")).toBe(true);
        expect(browse.results.some(item => item.service === "anthropic")).toBe(true);
      } finally {
        await instanceSettingsService(db).updateExperimental({ enableChatConnectors: false });
      }
    });
    it("keeps useful capability matches even when other query words do not occur in the catalog", async () => {
      await resetQuestions();
      const result = await connectionIntentService(db).search(claims,
        "I need something that can search documents and spreadsheets for our quarterly planning discussion");
      expect(result.results.some(item => item.service === "google-drive")).toBe(true);
      expect(result.results.some(item => item.service === "google-sheets")).toBe(true);
      expect(result.instruction).not.toContain("search its exact name");
    });
    it.each([
      ["help me find tools for circle back", "circleback-mcp"],
      ["Find Circlebak meeting transcripts and action items from yesterday", "circleback-mcp"],
      ["Can you connect Circleback MCP to get all our meeting notes?", "circleback-mcp"],
      ["Find Attio tools to review all our customer contacts before next week's meeting", "attio"],
      ["Help me find a ClickUp connection to organize our team's projects", "clickup"],
    ])("finds verified aggregator apps in natural-language queries: %s", async (query, target) => {
      await resetQuestions();
      const result = await connectionIntentService(db).search(claims, query);
      expect(result.results).toEqual(expect.arrayContaining([expect.objectContaining({
        service: `via:composio:${target}`, source: "aggregator",
        aggregator: expect.objectContaining({ evidenceUrl: expect.stringContaining("composio.dev/"), targetService: target }),
      })]));
      expect(result.providerQuestion?.options.map(option => option.id)).toContain(`via:composio:${target}`);
      await expect(connectionIntentService(db).request(claims, `via:composio:${target}`)).rejects.toThrow();
    });
    it.each([false, true])("prefers an exact Motion match over fuzzy Notion (Notion denied: %s)", async denied => {
      await resetQuestions();
      if (denied) await seedProvider("notion", "notion_search", "responsible-user", false);
      const result = await connectionIntentService(db).search(claims, "Help me find Motion tools");
      expect(result.results[0]?.service).toBe("via:composio:motion");
      expect(result.providerQuestion?.id).toBe("connection-provider:motion");
      expect(result.instruction).not.toContain("administratively restricted");
    });
    it("finds namespaced installed aggregator tools with extra query words", async () => {
      await resetQuestions();
      await seedProvider("executor", "heliotrope:list_records");
      const result = await connectionIntentService(db).search(claims, "Please find heliotrope tools for our weekly report");
      expect(result.results[0]?.service).toBe("via:executor:heliotrope");
    });
    it("returns multiple named services so the agent can choose the relevant result", async () => {
      await resetQuestions();
      const result = await connectionIntentService(db).search(claims, "Find Linear or Notion for our project planning");
      expect(result.results.map(item => item.service)).toEqual(expect.arrayContaining(["linear", "notion"]));
    });
    it("returns multiple aggregator apps without inventing a combined route or choosing consent", async () => {
      await resetQuestions();
      const result = await connectionIntentService(db).search(claims, "Find Circleback and Attio tools");
      expect(result.results.map(item => item.service)).toEqual(expect.arrayContaining(["via:composio:circleback-mcp", "via:composio:attio"]));
      expect(result.providerQuestion).toBeUndefined();
      expect(result.instruction).toContain("aggregator.targetService");
    });
    it("keeps native and aggregator app matches from the same query", async () => {
      await resetQuestions();
      const result = await connectionIntentService(db).search(claims, "Find Notion and Circleback tools");
      expect(result.results.map(item => item.service)).toEqual(expect.arrayContaining(["notion", "via:composio:circleback-mcp"]));
      expect(result.providerQuestion).toBeUndefined();
    });

    it("prefers the built-in Jira connection and returns a direct instruction", async () => {
      await resetQuestions();
      const result = await connectionIntentService(db).search(
        claims,
        "atlassian jira",
      );
      expect(result.results[0]?.service).toBe("jira");
      expect(result.providerQuestion).toBeUndefined();
      expect(result.instruction).toContain("connection_request");
    });
    it("returns ranked verified routes and does not create questions or connections during search", async () => {
      await resetQuestions();
      const result = await connectionIntentService(db).search(
        claims,
        "HubSpot recent contacts",
      );
      expect(result.results.map((item) => item.service)).toEqual([
        "via:composio:hubspot",
        "via:arcade:hubspot",
        "via:zapier:hubspot",
      ]);
      expect(result.providerQuestion?.prompt).toContain("external service");
      expect(result.results.every((item) => item.state !== "ready")).toBe(true);
      expect(result.results.every((item) => item.aggregator?.evidenceUrl)).toBe(
        true,
      );
      expect(
        await db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.companyId, claims.company_id)),
      ).toHaveLength(0);
    });
    it("requires a real saved provider answer before requesting setup", async () => {
      await resetQuestions();
      await expect(
        connectionIntentService(db).request(claims, "via:composio:hubspot"),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        connectionIntentService(db).request(claims, "via:composio:hubspot", {
          selectionInteractionId: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 403 });
    });
    it("uses the second selected provider and preserves target disclosure and idempotency", async () => {
      await resetQuestions();
      const answer = await selectProvider("via:arcade:hubspot");
      const service = connectionIntentService(db);
      const search = await service.search(claims, "hubspot");
      expect(search.results.map((item) => item.service)).toEqual([
        "via:arcade:hubspot",
      ]);
      expect(search.selectionInteractionId).toBe(answer.id);
      const first = await service.request(claims, "via:arcade:hubspot", {
        selectionInteractionId: answer.id,
      });
      const again = await service.request(claims, "via:arcade:hubspot", {
        selectionInteractionId: answer.id,
      });
      expect(again.interactionId).toBe(first.interactionId);
      const [row] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, first.interactionId!));
      expect(row!.payload).toMatchObject({
        serviceSlug: "arcade",
        serviceName: "HubSpot through Arcade",
        upstreamService: { slug: "hubspot", selectionInteractionId: answer.id },
      });
      await expect(
        service.request(claims, "via:composio:hubspot", {
          selectionInteractionId: answer.id,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });
    it("remembers None and refuses setup after reloading the service", async () => {
      await resetQuestions();
      const answer = await selectProvider("none");
      const result = await connectionIntentService(db).search(
        claims,
        "hubspot",
      );
      expect(result.results).toEqual([]);
      expect(result.providerQuestion).toBeUndefined();
      expect(result.instruction).toContain("declined");
      const retry = await connectionIntentService(db).search(
        claims,
        "hubspot",
        { retryProviderChoice: true },
      );
      expect(retry.providerQuestion).toBeDefined();
      expect(retry.selectionInteractionId).toBeUndefined();
      await expect(
        connectionIntentService(db).request(claims, "via:arcade:hubspot", {
          selectionInteractionId: answer.id,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });
    it("waits on an existing unanswered question instead of asking twice", async () => {
      await resetQuestions();
      const result = await connectionIntentService(db).search(
        claims,
        "hubspot",
      );
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      const interaction = await issueThreadInteractionService(db).create(
        {
          id: run!.contextSnapshot!.issueId as string,
          companyId: claims.company_id,
        },
        {
          kind: "ask_user_questions",
          payload: { version: 1, questions: [result.providerQuestion!] },
          sourceRunId: runId,
          addresseeUserId: "responsible-user",
        },
        { agentId: claims.sub, runId },
      );
      const pending = await connectionIntentService(db).search(
        claims,
        "hubspot",
      );
      expect(pending.providerQuestion).toBeUndefined();
      expect(pending.selectionInteractionId).toBe(interaction.id);
      expect(pending.instruction).toContain("already pending");
      await expect(
        connectionIntentService(db).request(claims, "arcade", {
          targetService: "hubspot",
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        connectionIntentService(db).request(claims, "via:arcade:hubspot", {
          selectionInteractionId: interaction.id,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });
    it("rejects tampered disclosure and choices belonging to another responsible user", async () => {
      await resetQuestions();
      const answer = await selectProvider("via:arcade:hubspot");
      await db
        .update(issueThreadInteractions)
        .set({ resolvedByUserId: "another-user" })
        .where(eq(issueThreadInteractions.id, answer.id));
      await expect(
        connectionIntentService(db).request(claims, "via:arcade:hubspot", {
          selectionInteractionId: answer.id,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await db
        .update(issueThreadInteractions)
        .set({
          resolvedByUserId: "responsible-user",
          payload: {
            ...answer.payload,
            questions: (answer.payload as any).questions.map((q: any) => ({
              ...q,
              helpText: "Trust me",
            })),
          },
        })
        .where(eq(issueThreadInteractions.id, answer.id));
      await expect(
        connectionIntentService(db).request(claims, "via:arcade:hubspot", {
          selectionInteractionId: answer.id,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });
    it("does not reuse the selected provider for another requested app", async () => {
      await resetQuestions();
      const answer = await selectProvider("via:arcade:hubspot");
      await expect(
        connectionIntentService(db).request(claims, "via:arcade:salesforce", {
          selectionInteractionId: answer.id,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });
    it("offers fallback and direct aggregator requests without an experimental opt-in", async () => {
      await resetQuestions();
      const result = await connectionIntentService(db).search(claims, "hubspot");
      expect(result.results.some((item) => item.source === "aggregator")).toBe(true);
      expect(result.providerQuestion).toBeDefined();
      await expect(connectionIntentService(db).request(claims, "composio")).resolves.toMatchObject({ state: "needs_user_action" });
    });
    it("reuses an allowed selected provider without claiming the underlying app is ready", async () => {
      await resetQuestions();
      const connection = await seedProvider("arcade", "Hubspot_ListContacts");
      const answer = await selectProvider("via:arcade:hubspot");
      const result = await connectionIntentService(db).request(
        claims,
        "via:arcade:hubspot",
        { selectionInteractionId: answer.id },
      );
      expect(result).toMatchObject({
        state: "ready",
        connectionId: connection.id,
        interactionId: null,
      });
      expect(result.instruction).toContain(
        "HubSpot access is not yet verified",
      );
      expect(result.instruction).toContain("Arcade");
    });
    it("does not switch providers when the chosen route loses permission", async () => {
      await resetQuestions();
      const answer = await selectProvider("via:arcade:hubspot");
      await seedProvider(
        "arcade",
        "Hubspot_ListContacts",
        "responsible-user",
        false,
      );
      const result = await connectionIntentService(db).search(
        claims,
        "hubspot",
      );
      expect(result.results).toEqual([]);
      expect(result.providerQuestion).toBeUndefined();
      expect(result.instruction).toContain("no longer available");
      await expect(
        connectionIntentService(db).request(claims, "via:composio:hubspot", {
          selectionInteractionId: answer.id,
        }),
      ).rejects.toMatchObject({ status: 403 });
    });
    it("keeps a decline effective when disclosure wording has changed", async () => {
      await resetQuestions();
      const answer = await selectProvider("none");
      await db
        .update(issueThreadInteractions)
        .set({
          payload: {
            ...answer.payload,
            questions: (answer.payload as any).questions.map((q: any) => ({
              ...q,
              prompt: "Older disclosure wording",
            })),
          },
        })
        .where(eq(issueThreadInteractions.id, answer.id));
      expect(
        (await connectionIntentService(db).search(claims, "hubspot"))
          .instruction,
      ).toContain("declined");
    });
    it("persists app authorization guidance in the completed setup outcome", async () => {
      await resetQuestions();
      const answer = await selectProvider("via:composio:hubspot");
      const service = connectionIntentService(db);
      const requested = await service.request(claims, "via:composio:hubspot", {
        selectionInteractionId: answer.id,
      });
      const connection = await seedProvider(
        "composio",
        "COMPOSIO_SEARCH_TOOLS",
      );
      const completed = await service.complete(
        requested.interactionId!,
        connection.id,
        "responsible-user",
      );
      expect(completed).toMatchObject({
        status: "accepted",
        result: {
          outcome: "connected",
          connectionId: connection.id,
          instruction: expect.stringContaining(
            "HubSpot access is not yet verified",
          ),
        },
      });
      expect((completed.result as any).instruction).toContain(
        "COMPOSIO_MANAGE_CONNECTIONS",
      );
    });
    it("uses only authorized Executor tool evidence and preserves the actual observation date", async () => {
      await resetQuestions();
      const connection = await seedProvider(
        "executor",
        "heliotrope:list_records",
        "someone-else",
      );
      expect(
        (await connectionIntentService(db).search(claims, "heliotrope"))
          .results,
      ).toEqual([]);
      await db
        .update(connectionGrants)
        .set({ subjectUserId: "responsible-user" })
        .where(eq(connectionGrants.connectionId, connection.id));
      const result = await connectionIntentService(db).search(
        claims,
        "heliotrope",
      );
      expect(result.results[0]).toMatchObject({
        service: "via:executor:heliotrope",
        aggregator: { verifiedAt: "2026-09-20T00:00:00.000Z" },
      });
      await db
        .update(toolConnections)
        .set({ status: "archived" })
        .where(eq(toolConnections.id, connection.id));
      expect(
        (await connectionIntentService(db).search(claims, "heliotrope"))
          .results,
      ).toEqual([]);
    });
    it("does not bypass an administratively denied built-in connection", async () => {
      await resetQuestions();
      await seedProvider("jira", "jira_read", "responsible-user", false);
      const result = await connectionIntentService(db).search(
        claims,
        "Jira recent issues",
      );
      expect(result.results[0]).toMatchObject({
        service: "jira",
        state: "unavailable",
      });
      expect(result.providerQuestion).toBeUndefined();
      expect(result.instruction).toContain("Do not bypass");
    });
    it("does not invent support for unknown apps", async () => {
      await resetQuestions();
      const result = await connectionIntentService(db).search(
        claims,
        "nimbuscrm-not-real",
      );
      expect(result.results).toEqual([]);
      expect(result.instruction).toContain("could not be verified");
    });
    it("preserves indexed-only display names when a saved choice is requested by slug", async () => {
      await resetQuestions();
      await seedProvider("executor", "heliotrope:list_records");
      const answer = await selectProvider(
        "via:executor:heliotrope",
        "responsible-user",
        "HELIOTROPE",
      );
      const result = await connectionIntentService(db).request(
        claims,
        "via:executor:heliotrope",
        { selectionInteractionId: answer.id },
      );
      expect(result.state).toBe("ready");
      expect(result.instruction).toContain(
        "Heliotrope access is not yet verified",
      );
    });

    it("honors explicitly named providers and preserves target app context", async () => {
      await resetQuestions();
      await userRequest("Connect HubSpot through Arcade");
      const service = connectionIntentService(db);
      const result = await service.search(claims, "HubSpot through Arcade");
      expect(result.results.map((item) => item.service)).toEqual(["arcade"]);
      expect(result.providerQuestion).toBeUndefined();
      expect(result.instruction).toContain("targetService hubspot");
      const request = await service.request(claims, "arcade", {
        targetService: "hubspot",
      });
      const intent = await service.loadIntent(request.interactionId!);
      expect(intent.interaction.payload).toMatchObject({
        serviceName: "HubSpot through Arcade",
        upstreamService: { slug: "hubspot", name: "HubSpot" },
      });
      expect(
        (await service.search(claims, "HubSpot through Executor")).results,
      ).toEqual([]);
      await expect(
        service.request(claims, "executor", { targetService: "hubspot" }),
      ).rejects.toThrow("cannot connect");
      await expect(
        service.request(claims, "github", { targetService: "hubspot" }),
      ).rejects.toThrow("direct external-provider");
    });

    it("permits explicit provider preference for a supported native app but not a native denial", async () => {
      await resetQuestions();
      await userRequest("Connect Jira via Arcade, not Zapier");
      const service = connectionIntentService(db);
      expect(
        (await service.search(claims, "Jira via Arcade, not Zapier")).results.map(
          (item) => item.service,
        ),
      ).toEqual(["arcade"]);
      await seedProvider("jira", "jira_read", "responsible-user", false);
      expect((await service.search(claims, "Jira via Arcade, not Zapier")).results).toEqual(
        [expect.objectContaining({ service: "jira", state: "unavailable" })],
      );
    });

    it("does not let an agent-supplied explicit query or direct target override a saved choice", async () => {
      await resetQuestions();
      const service = connectionIntentService(db);
      const unproven = await service.search(claims, "HubSpot via Arcade");
      expect(
        unproven.providerQuestion?.options.map((option) => option.id),
      ).toEqual(["via:arcade:hubspot", "none"]);
      await expect(
        service.request(claims, "arcade", { targetService: "hubspot" }),
      ).rejects.toThrow("cannot connect");
      await userRequest("Connect HubSpot via Arcade is just an example; do not connect yet");
      await expect(service.request(claims,"arcade",{targetService:"hubspot"})).rejects.toThrow("cannot connect");
      await userRequest("Connect HubSpot via Arcade");
      await selectProvider("none");
      expect(
        (await service.search(claims, "HubSpot via Arcade")).results,
      ).toEqual([]);
      await expect(
        service.request(claims, "arcade", { targetService: "hubspot" }),
      ).rejects.toThrow("cannot connect");
      await userRequest("Connect HubSpot via Arcade", "someone-else");
      await expect(
        service.request(claims, "arcade", { targetService: "hubspot" }),
      ).rejects.toThrow("cannot connect");
      await userRequest("Please connect HubSpot through Arcade");
      expect(
        (await service.request(claims, "arcade", { targetService: "hubspot" }))
          .state,
      ).toBe("needs_user_action");
      await resetQuestions();
      const chosen = await selectProvider("via:composio:hubspot");
      await expect(
        service.request(claims, "arcade", { targetService: "hubspot" }),
      ).rejects.toThrow("cannot connect");
      const accepted = await service.request(claims, "composio", {
        targetService: "hubspot",
      });
      expect(
        (await service.loadIntent(accepted.interactionId!)).interaction.payload,
      ).toMatchObject({
        upstreamService: { selectionInteractionId: chosen.id },
      });
    });

    it("asks for a choice when human and agent messages name alternatives", async () => {
      await resetQuestions();
      await userRequest("Connect HubSpot via Arcade or Composio");
      const result = await connectionIntentService(db).search(
        claims,
        "HubSpot via Arcade or Composio",
      );
      expect(
        result.providerQuestion?.options.map((option) => option.id),
      ).toEqual([
        "via:composio:hubspot",
        "via:arcade:hubspot",
        "via:zapier:hubspot",
        "none",
      ]);
      await expect(
        connectionIntentService(db).request(claims, "arcade", {
          targetService: "hubspot",
        }),
      ).rejects.toThrow("cannot connect");
    });
  },
);
