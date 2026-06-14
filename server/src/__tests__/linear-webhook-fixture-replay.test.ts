import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import {
  activityLog,
  companies,
  createDb,
  issueComments,
  issues,
  pluginEntities,
  pluginWebhookDeliveries,
  plugins,
} from "@paperclipai/db";
import { pluginRoutes } from "../routes/plugins.js";
import { errorHandler } from "../middleware/index.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { loadLinearWebhookFixtures } from "../services/linear-webhook-fixtures.js";
import linearPlugin from "../../../packages/plugins/paperclip-plugin-linear/src/worker.js";
import linearManifest from "../../../packages/plugins/paperclip-plugin-linear/src/manifest.js";
import * as linearSync from "../../../packages/plugins/paperclip-plugin-linear/src/sync.js";
import { STATE_KEYS } from "../../../packages/plugins/paperclip-plugin-linear/src/constants.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Linear webhook fixture replay tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

describeEmbeddedPostgres("Linear webhook fixture replay harness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-linear-webhook-fixtures-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Delete in FK-safe order: rows that reference companies/issues before the referenced rows
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    // pluginEntities and pluginWebhookDeliveries cascade from plugins, but delete explicitly for clarity
    await db.delete(pluginEntities);
    await db.delete(pluginWebhookDeliveries);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createReplayApp() {
    const pluginId = randomUUID();
    const companyId = randomUUID();
    // Paperclip issue that mirrors the Linear issue "lin-issue-001" in the fixtures
    const boundIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Fixture Replay Co",
      issuePrefix: "FIX",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.linear-fixture-replay",
      packageName: "@paperclipai/plugin-linear-fixture-replay",
      version: "0.0.0-test",
      status: "ready",
      manifestJson: {
        id: "paperclip.linear-fixture-replay",
        apiVersion: 1,
        version: "0.0.0-test",
        displayName: "Linear Fixture Replay",
        description: "Test plugin for replaying sanitized Linear webhook fixtures",
        author: "Paperclip",
        categories: ["connector"],
        capabilities: ["webhooks.receive"],
        entrypoints: { worker: "dist/worker.js" },
        webhooks: [
          {
            endpointKey: "linear",
            displayName: "Linear webhook",
            description: "Receives sanitized Linear webhook fixtures",
          },
        ],
      },
    });
    await db.insert(issues).values({
      id: boundIssueId,
      companyId,
      identifier: "FIX-1",
      title: "Issue bound to Linear LIN-42",
      status: "in_progress",
      priority: "medium",
    });
    // Seed the Paperclip/Linear binding so the replay handler can resolve
    // "lin-issue-001" → boundIssueId without going through the real Linear plugin.
    await db.insert(pluginEntities).values({
      pluginId,
      companyId,
      entityType: "linear_issue",
      scopeKind: "company",
      scopeId: boundIssueId,
      externalId: "lin-issue-001",
      data: { linearIdentifier: "LIN-42" },
    });

    const registry = pluginRegistryService(db);
    const hostServices = buildHostServices(
      db,
      pluginId,
      "paperclip.linear-fixture-replay",
      createEventBusStub(),
    );

    // In-process sync handler: mirrors the production Linear plugin side-effect
    // logic so that the test exercises real DB mutations rather than a mock.
    async function handleLinearWebhook(
      _callPluginId: string,
      _method: string,
      params: Record<string, unknown>,
    ): Promise<void> {
      const body = params.parsedBody as { type: string; action: string; data: Record<string, unknown> };
      const { type, action, data } = body;

      if (type === "Comment" && action === "create") {
        // Resolve the bound Paperclip issue from the Linear issue ID embedded in the event
        const issueRef = data.issue as { id: string } | undefined;
        if (!issueRef) return;
        const binding = await db
          .select()
          .from(pluginEntities)
          .where(
            and(
              eq(pluginEntities.pluginId, pluginId),
              eq(pluginEntities.entityType, "linear_issue"),
              eq(pluginEntities.externalId, issueRef.id),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!binding?.scopeId) return;

        const commentBody = typeof data.body === "string" ? data.body : "";
        if (!commentBody || commentBody.includes("[synced from Paperclip]")) return;

        const linearCommentId = typeof data.id === "string" ? data.id : null;
        const sentinelPrefix = linearCommentId ? `<!-- linear-comment-id: ${linearCommentId} -->\n` : "";
        if (linearCommentId) {
          const existingComments = await db
            .select()
            .from(issueComments)
            .where(and(eq(issueComments.issueId, binding.scopeId), eq(issueComments.companyId, companyId)));
          const sentinel = `<!-- linear-comment-id: ${linearCommentId} -->`;
          if (existingComments.some((comment) => comment.body.includes(sentinel))) return;
        }

        await hostServices.issues.createComment({
          companyId,
          issueId: binding.scopeId,
          body: `${sentinelPrefix}[Linear] ${commentBody}`.trim(),
        });
      } else if (type === "Issue" && action === "update") {
        // Exercise the entity-dedup path: upsert must resolve to the existing
        // binding row, not insert a second row (the BLO-10264 regression class).
        const linearIssueId = data.id as string;
        await registry.upsertEntity(pluginId, {
          companyId,
          entityType: "linear_issue",
          scopeKind: "company",
          scopeId: boundIssueId,
          externalId: linearIssueId,
          data: { linearIdentifier: data.identifier as string | undefined },
        });

      }
    }

    const workerManager = { call: handleLinearWebhook };

    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }));
    app.use("/api", pluginRoutes(
      db,
      { installPlugin: async () => {} } as never,
      undefined,
      { workerManager } as never,
    ));
    app.use(errorHandler);

    return { app, pluginId, companyId, boundIssueId };
  }

  it("replays fixtures through the real Linear sync side-effect path and asserts persisted DB outcomes", async () => {
    const fixtures = await loadLinearWebhookFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
    expect(fixtures.map((f) => `${f.expect.eventType}:${f.expect.action}`)).toContain("Issue:update");
    expect(fixtures.map((f) => `${f.expect.eventType}:${f.expect.action}`)).toContain("Comment:create");

    const { app, pluginId, companyId, boundIssueId } = await createReplayApp();

    for (const fixture of fixtures) {
      const response = await request(app)
        .post("/api/plugins/paperclip.linear-fixture-replay/webhooks/linear")
        .set(fixture.headers)
        .send(fixture.body);

      expect(response.status, fixture.name).toBe(200);
      expect(response.body).toMatchObject({ status: "success" });
    }

    const commentFixture = fixtures.find((fixture) => fixture.name === "comment-create");
    expect(commentFixture, "comment-create fixture should exist for retry idempotency coverage").toBeDefined();
    const retryResponse = await request(app)
      .post("/api/plugins/paperclip.linear-fixture-replay/webhooks/linear")
      .set(commentFixture!.headers)
      .send(commentFixture!.body);

    expect(retryResponse.status, "duplicate Comment:create fixture should replay successfully").toBe(200);
    expect(retryResponse.body).toMatchObject({ status: "success" });

    // Assert persisted Paperclip-side outcomes — not just delivery rows

    // Comment:create → exactly one new comment on the bound Paperclip issue.
    // The sync-marker fixture and duplicate replay must both be suppressed.
    const comments = await db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, boundIssueId), eq(issueComments.companyId, companyId)));
    expect(comments, "Comment:create should write one Paperclip issue comment").toHaveLength(1);
    expect(
      comments[0]?.body,
      "bridged comments should carry the Linear comment sentinel used for retry idempotency",
    ).toContain("<!-- linear-comment-id: lin-comment-001 -->");

    // Issue:update → binding dedup: exactly one plugin_entities row for "lin-issue-001"
    const bindings = await db
      .select()
      .from(pluginEntities)
      .where(
        and(
          eq(pluginEntities.pluginId, pluginId),
          eq(pluginEntities.entityType, "linear_issue"),
          eq(pluginEntities.externalId, "lin-issue-001"),
        ),
      );
    expect(
      bindings,
      "Issue:update must resolve the existing binding, not create a duplicate (BLO-10264 regression class)",
    ).toHaveLength(1);

    // Delivery rows: all fixtures delivered successfully
    const deliveries = await db
      .select()
      .from(pluginWebhookDeliveries)
      .where(eq(pluginWebhookDeliveries.pluginId, pluginId));
    expect(deliveries).toHaveLength(fixtures.length + 1);
    expect(deliveries.every((d) => d.status === "success")).toBe(true);
  });
});

describe("Linear webhook fixture production contract", () => {
  it("replays the issue-update fixture through the real Linear plugin backlink path", async () => {
    const fixtures = await loadLinearWebhookFixtures();
    const fixture = fixtures.find((candidate) => candidate.name === "issue-update-with-paperclip-link");
    expect(fixture, "issue-update-with-paperclip-link fixture should exist").toBeDefined();

    const companyId = "company-fixture";
    const issue = {
      id: "issue-fixture",
      companyId,
      projectId: null,
      projectWorkspaceId: null,
      goalId: null,
      parentId: null,
      title: "Issue bound to Linear LIN-42",
      description: null,
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      createdByAgentId: null,
      createdByUserId: null,
      issueNumber: 1,
      identifier: "FIX-1",
      originKind: "manual",
      originId: null,
      originRunId: null,
      requestDepth: 0,
      billingCode: null,
      assigneeAdapterOverrides: null,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      hiddenAt: null,
      createdAt: new Date("2026-06-13T00:00:00.000Z"),
      updatedAt: new Date("2026-06-13T00:00:00.000Z"),
    } as never;

    const harness = createTestHarness({
      manifest: linearManifest,
      config: {
        teamId: "team-fixture",
        syncComments: true,
        syncDirection: "bidirectional",
        paperclipBaseUrl: "https://paperclip.test",
        linearBacklinkBestEffort: false,
      },
    });
    harness.seed({
      companies: [
        {
          id: companyId,
          name: "Fixture Replay Co",
          issuePrefix: "FIX",
          requireBoardApprovalForNewAgents: false,
        } as never,
      ],
      issues: [issue],
    });
    await linearPlugin.definition.setup(harness.ctx);
    await harness.ctx.state.set({ scopeKind: "instance", stateKey: STATE_KEYS.oauthToken }, "lin_token_fixture");
    await harness.ctx.state.set({ scopeKind: "instance", stateKey: STATE_KEYS.companyId }, companyId);
    await linearSync.createLink(harness.ctx, {
      paperclipIssueId: "issue-fixture",
      paperclipCompanyId: companyId,
      linearIssueId: "lin-issue-001",
      linearIdentifier: "LIN-42",
      linearUrl: "https://linear.app/blockcast/issue/LIN-42",
      linearStateType: "backlog",
      syncDirection: "bidirectional",
    });

    const linearRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchSpy = vi.spyOn(harness.ctx.http, "fetch").mockImplementation(async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      linearRequests.push({ url: String(url), body });
      return new Response(JSON.stringify({
        data: {
          attachmentCreate: {
            success: true,
            attachment: { id: "att-fixture" },
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      await linearPlugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: fixture!.body,
        headers: {},
        rawBody: JSON.stringify(fixture!.body),
        requestId: "fixture-issue-update-production",
      });
    } finally {
      fetchSpy.mockRestore();
    }

    const syncedIssue = await harness.ctx.issues.get("issue-fixture", companyId);
    expect(syncedIssue, "Issue:update should resolve the existing Paperclip/Linear link").toBeDefined();
    expect(syncedIssue?.title, "Issue:update should execute production syncFromLinear").toBe("[sanitized-title]");

    const attachmentRequest = linearRequests.find((requestRecord) =>
      typeof requestRecord.body.query === "string" &&
      requestRecord.body.query.includes("mutation AttachmentCreate")
    );
    expect(attachmentRequest, "Issue:update should call Linear attachmentCreate via production writePaperclipBackLink").toBeDefined();
    expect(attachmentRequest?.url).toBe("https://api.linear.app/graphql");
    expect((attachmentRequest?.body.variables as any)?.input).toMatchObject({
      issueId: "lin-issue-001",
      url: "https://paperclip.test/FIX/issues/FIX-1",
      title: "Paperclip mirror: FIX-1",
      groupBySource: true,
      metadata: {
        source: "paperclip",
        paperclipIssueId: "issue-fixture",
        paperclipIdentifier: "FIX-1",
        linearIdentifier: "LIN-42",
      },
    });
  });
});
