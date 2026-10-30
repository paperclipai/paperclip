import { budgetService, computeObservedSpend } from "../services/budgets.js";
import { buildPaperclipRuntimeMcpServers } from "../services/heartbeat.js";
import { resolveNativeRuntimeMcpSnapshot } from "../services/native-runtime/runtime-context.js";
import express from "express";
import http from "supertest";
import { browserUseRoutes } from "../routes/browser-use.js";
import { errorHandler } from "../middleware/index.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  toolActionRequests,
  toolInvocations,
  toolPolicies,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  toolConnections,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolProfiles,
  toolProfileBindings,
  toolProfileEntries,
  browserUseSessions,
  browserUseRuns,
  browserUseBrowsers,
  costEvents,
  financeEvents,
  budgetPolicies,
  budgetReservations,
} from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { browserUseViewports } from "../services/browser-use-viewport.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerBrowserUseCleanup } from "../services/browser-use-work.js";
import { browserUseService } from "../services/browser-use.js";
import { applyConnectorSkills, prepareConnectorSkillDelivery, resolveConnectorAssignments } from "../services/connector-runtime.js";
import { registerAssignedMcpGateway } from "../services/native-runtime/assigned-mcp-tools.js";
import { listPaperclipSkillEntries } from "@paperclipai/adapter-utils/server-utils";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
const actor = { actorType: "user" as const, actorId: "browser-reviewer" };
(support.supported ? describe : describe.skip)(
  "Browser Use connection and lifecycle",
  () => {
    let db: ReturnType<typeof createDb>;
    let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    const originalApiUrl = process.env.PAPERCLIP_API_URL;
    beforeAll(async () => {
      process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100";
      temp = await startEmbeddedPostgresTestDatabase("paperclip-browser-use-");
      db = createDb(temp.connectionString);
    }, 30000);
    afterAll(async () => {
      await temp?.cleanup();
      if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
      else process.env.PAPERCLIP_API_URL = originalApiUrl;
    });
    async function fixture(personal = false) {
      const [company] = await db
        .insert(companies)
        .values({
          name: "Browser fixture",
          issuePrefix: `BU${randomUUID().slice(0, 6)}`,
        })
        .returning();
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: actor.actorId,
        membershipRole: "admin",
        status: "active",
      });
      const providerSession = randomUUID(),
        providerBrowser = randomUUID();
      let providerRun = randomUUID();
      let acceptedTask = "", loseReply = false, rejectCode = 0, recoveryPages = 0;
      let createGate: (() => Promise<void>) | undefined;
      let totalCostUsd = "0.15";
      let status = "running",
        stopped = false,
        browserReady = false,
        invalidKey = false,
        failCreate = false,
        paginatedEvents = false;
      const request = vi.fn(async (url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get("X-Browser-Use-API-Key")).toBe(
          "bu_fixture_secret",
        );
        if (invalidKey)
          return new Response("bu_fixture_secret private-error", {
            status: 401,
          });
        const path = new URL(url).pathname.replace("/api/v4", "");
        if (path === "/profiles")
          return Response.json({ items: [], totalItems: 0 });
        if (path === "/runs" && init.method === "GET") {
          const cursor = Number(new URL(url).searchParams.get("cursor") ?? 0);
          return Response.json(cursor < recoveryPages
            ? { runs: [], hasMore: true, nextCursor: String(cursor + 1) }
            : { runs: acceptedTask ? [{ id: providerRun, sessionId: providerSession, task: acceptedTask, status }] : [], hasMore: false });
        }
        if (path === "/runs" && init.method === "POST" && rejectCode)
          return new Response("Rejected", { status: rejectCode, headers: { "Retry-After": "1" } });
        if (path === "/runs" && init.method === "POST" && failCreate)
          throw new Error("lost create response");
        if (path === "/runs" && init.method === "POST") {
          await createGate?.();
          providerRun = randomUUID();
          status = "running";
          acceptedTask = JSON.parse(String(init.body)).task;
          if (loseReply) { browserReady = true; throw new Error("lost accepted create response"); }
          return Response.json({
            id: providerRun,
            sessionId: providerSession,
            status,
            model: "fixture",
          });
        }
        if (path.endsWith("/cancel")) {
          status = "cancelled";
          return Response.json({});
        }
        if (path.endsWith("/status")) return Response.json({ status });
        if (path.endsWith("/events") && paginatedEvents) {
          const next = Number(new URL(url).searchParams.get("after")) + 1;
          return Response.json({
            events: [{ id: next, type: "agent.step", data: {} }],
            nextAfter: next,
            hasMore: next < 9,
          });
        }
        if (path.endsWith("/events"))
          return Response.json({
            events: browserReady
              ? [
                  {
                    id: 1,
                    type: "browser.ready",
                    data: {
                      live_view_url: "https://live.browser-use.com/canary",
                    },
                  },
                ]
              : [],
            nextAfter: browserReady ? 1 : 0,
            hasMore: false,
          });
        if (path === `/runs/${providerRun}`)
          return Response.json({
            status,
            result: "Finished https://live.browser-use.com/canary",
            totalCostUsd,
            model: "fixture",
          });
        if (path === "/browsers")
          return Response.json({
            items: browserReady
              ? [
                  {
                    id: providerBrowser,
                    status: stopped ? "stopped" : "active",
                  },
                ]
              : [],
            totalItems: browserReady ? 1 : 0,
          });
        if (path === `/browsers/${providerBrowser}`) {
          if (init.method === "PATCH") stopped = true;
          return Response.json({
            id: providerBrowser,
            agentSessionId: providerSession,
            status: stopped ? "stopped" : "active",
            liveUrl: "https://live.browser-use.com/canary",
            cdpUrl: `https://${providerBrowser}.cdp.browser-use.com`,
            timeoutAt: new Date(Date.now() + 3600000).toISOString(),
          });
        }
        throw new Error(`Unexpected fixture path ${path}`);
      });
      const access = toolAccessService(db, {
        remoteHttpRequest: request,
        remoteHttpEndpointLookup: async () => [
          { address: "8.8.8.8", family: 4 },
        ],
      });
      const connection = await access.connectGalleryApp(
        company.id,
        {
          galleryKey: "browser-use-cloud",
          ...(personal ? { grantKind: "user" as const } : {}),
          connectionMethodKey: "cloud-v4",
          credentialValues: { "credentials.apiKey": "bu_fixture_secret" },
        },
        actor,
      );
      const [grant] = await db
        .select()
        .from(connectionGrants)
        .where(eq(connectionGrants.connectionId, connection.connectionId));
      const [agent] = await db
        .insert(agents)
        .values({
          companyId: company.id,
          name: "Browser agent",
          role: "engineer",
          adapterType: "process",
          adapterConfig: {},
        })
        .returning();
      await access.finishGalleryAppConnection(
        company.id,
        connection.connectionId,
        {
          enabledCatalogEntryIds: connection.catalog.map((t) => t.id),
          askFirstCatalogEntryIds: [],
          access: { agentIds: [agent.id] },
        },
        actor,
      );
      const [issue] = await db
        .insert(issues)
        .values({
          companyId: company.id,
          title: "Browser task",
          assigneeAgentId: agent.id,
        })
        .returning();
      const [run] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: company.id,
          agentId: agent.id,
          invocationSource: "on_demand",
          status: "running",
          responsibleUserId: actor.actorId,
          contextSnapshot: { issueId: issue.id },
        })
        .returning();
      const [profile] = await db
        .insert(toolProfiles)
        .values({
          companyId: company.id,
          name: "Browser tools",
          profileKey: randomUUID(),
          defaultAction: "allow",
        })
        .returning();
      await db.insert(toolProfileBindings).values({
        companyId: company.id,
        profileId: profile.id,
        targetType: "agent",
        targetId: agent.id,
      });
      const gateway = createToolGatewayService(db, {
        remoteHttpRequest: request,
        toolActionSigningSecret: "browser-fixture-signing-secret",
      });
      registerAssignedMcpGateway(db, gateway);
      const gatewaySession = await gateway.createSession({
        companyId: company.id,
        agentId: agent.id,
        runId: run.id,
      });
      const service = browserUseService(db, request);
      const binding = {
        companyId: company.id,
        agentId: agent.id,
        issueId: issue.id,
        runId: run.id,
      };
      const tick = async () => {
        await db
          .update(browserUseSessions)
          .set({ nextPollAt: new Date(0) })
          .where(eq(browserUseSessions.companyId, company.id));
        await service.sweep(connection.connectionId);
      };
      return {
        company,
        connection,
        access,
        grant,
        agent,
        issue,
        run,
        service,
        binding,
        gateway,
        gatewaySession,
        request,
        tick,
        ready: () => {
          browserReady = true;
        },
        complete: () => {
          status = "completed";
        },
        invalidate: () => {
          invalidKey = true;
        },
        failCreate: () => {
          failCreate = true;
        },
        loseReply: () => { loseReply = true; },
        reject: (code: number) => { rejectCode = code; },
        recoveryPages: (count: number) => { recoveryPages = count; },
        delayCreate: (gate: () => Promise<void>) => { createGate = gate; },
        usage: (value: string) => { totalCostUsd = value; },
        paginate: () => {
          paginatedEvents = true;
        },
      };
    }
    it("wakes the app worker from request-service commits and restores durable poll and lease deadlines", async () => {
      const f = await fixture();
      const background = browserUseService(db, f.request);
      const sweep = vi.spyOn(background, "sweep");
      const onError = vi.fn();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
      try {
        await registerBrowserUseCleanup(coordinator, background, () => true).ready;
        expect(coordinator.nextWakeAt()).toBeNull();
        expect(await background.nextSweepAt()).toBeNull();
        const started = await f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", { task: "Read example.com" }) as { sessionId: string };
        await vi.waitFor(() => expect(sweep.mock.calls.length).toBeGreaterThan(1));
        await coordinator.stop();
        expect(onError).not.toHaveBeenCalled();

        const poll = new Date(Date.now() + 60_000);
        const lease = new Date(Date.now() + 180_000);
        await db.update(browserUseSessions).set({ nextPollAt: poll, leaseUntil: lease })
          .where(eq(browserUseSessions.id, started.sessionId));
        expect(await background.nextSweepAt()).toBe(lease.getTime());
        const restarted = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
        try {
          await registerBrowserUseCleanup(restarted, browserUseService(db, f.request), () => true).ready;
          expect(restarted.nextWakeAt()).toBe(lease.getTime());
        } finally { await restarted.stop(); }
        await db.update(browserUseSessions).set({ leaseUntil: new Date(0) })
          .where(eq(browserUseSessions.id, started.sessionId));
        expect(await background.nextSweepAt()).toBe(poll.getTime());
        await db.update(browserUseSessions).set({ leaseUntil: null })
          .where(eq(browserUseSessions.id, started.sessionId));
        expect(await background.nextSweepAt()).toBe(poll.getTime());
        const [session] = await db.select().from(browserUseSessions).where(eq(browserUseSessions.id, started.sessionId));
        await f.service.control(session, "end");
        expect(await background.nextSweepAt()).toBeLessThan(poll.getTime());
        await db.update(browserUseSessions).set({ status: "closed" }).where(eq(browserUseSessions.id, started.sessionId));
        expect(await background.nextSweepAt()).toBeNull();
      } finally {
        await coordinator.stop();
        await db.update(browserUseSessions).set({ status: "closed" }).where(eq(browserUseSessions.companyId, f.company.id));
      }
    });
    it("keeps Cloud instructions out of universal skills and unassigned runtime overlays", async () => {
      const skills = await listPaperclipSkillEntries(fileURLToPath(new URL("../", import.meta.url)), [fileURLToPath(new URL("../../../skills", import.meta.url))]);
      expect(skills.some(skill => skill.runtimeName === "paperclip")).toBe(true);
      expect(skills.some(skill => ["browser-use", "browser-use-cloud"].includes(skill.runtimeName))).toBe(false);
      const base = { paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/browser-use", "paperclipai/paperclip/browser-use-cloud"] } };
      const unassigned = await applyConnectorSkills(base, [
        { key: "paperclipai/paperclip/browser-use", runtimeName: "browser-use", source: "/retired-browser-skill" },
        { key: "paperclipai/paperclip/browser-use-cloud", runtimeName: "browser-use-cloud", source: "/unassigned-cloud-skill" },
        { key: "custom/browser-use", runtimeName: "browser-use", source: "/another-browser-skill" },
      ], []);
      expect(unassigned.paperclipRuntimeSkills).toEqual([{ key: "custom/browser-use", runtimeName: "browser-use", source: "/another-browser-skill" }]);
      expect(unassigned.paperclipConnectorSkillDigest).toBeNull();
      expect(base.paperclipSkillSync.desiredSkills).toHaveLength(2);
    });
    it("delivers the Cloud skill only with authorized connection tools in a task run", async () => {
      const f = await fixture();
      const [unassignedAgent] = await db.insert(agents).values({
        companyId: f.company.id,
        name: "Agent without the Cloud connection",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      }).returning();
      expect(await f.gateway.browserUseResources({ companyId: f.company.id, agentId: f.agent.id })).toEqual([]);
      expect(await resolveConnectorAssignments(db, { ...f.binding, agentId: unassignedAgent.id })).toEqual([]);
      expect(await resolveConnectorAssignments(db, { ...f.binding, companyId: randomUUID() })).toEqual([]);
      const assignments = await resolveConnectorAssignments(db, f.binding);
      expect(assignments).toMatchObject([{ key: "browser-use-cloud", skillKey: "paperclipai/paperclip/browser-use-cloud", resources: [{ connectionId: f.connection.connectionId }] }]);
      const config = await applyConnectorSkills({}, [], assignments);
      const skill = config.paperclipRuntimeSkills[0];
      expect(skill.runtimeName).toBe("browser-use-cloud");
      const markdown = await readFile(path.join(skill.source, "SKILL.md"), "utf8");
      expect(markdown).toContain("name: browser-use-cloud");
      expect(markdown).toContain("browser_start");
      expect(markdown).toContain(f.connection.connectionId);
      expect(markdown).not.toContain("bu_fixture_secret");
      for (const adapterType of ["paperclip_runner", "codex_local", "claude_local", "kimi_local"]) {
        const delivery = await prepareConnectorSkillDelivery({ ...config, engine: "cli" }, adapterType);
        expect(delivery.config.paperclipRuntimeSkills).toEqual([skill]);
      }
      const sharedHome = await prepareConnectorSkillDelivery(config, "cursor_local");
      expect(sharedHome.config.paperclipRuntimeSkills).toEqual([]);
      expect(sharedHome.instructions).toContain("name: browser-use-cloud");
      expect(sharedHome.config.paperclipConnectorSkillDigest).toBe(config.paperclipConnectorSkillDigest);
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.grant.id));
      expect(await resolveConnectorAssignments(db, f.binding)).toEqual([]);
      const revoked = await applyConnectorSkills(config, config.paperclipRuntimeSkills, []);
      expect(revoked.paperclipRuntimeSkills).toEqual([]);
      expect(revoked.paperclipConnectorSkillDigest).toBeNull();
      expect((await prepareConnectorSkillDelivery(revoked, "cursor_local")).instructions).toBe("");
    });
    it.each([false, true])("skips tool discovery without an active company Browser Use connection (foreign: %s)", async foreign => {
      const f = await fixture();
      await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.connection.connectionId));
      if (foreign) await fixture();
      f.request.mockClear();
      const discovery = vi.spyOn(db, "transaction");
      try {
        expect(await f.gateway.browserUseResources(f.binding)).toEqual([]);
        expect(discovery).not.toHaveBeenCalled();
        expect(f.request).not.toHaveBeenCalled();
      } finally { discovery.mockRestore(); }
    });
    it("resolves only the Browser Use catalog even while full discovery is saturated", async () => {
      const f = await fixture();
      const [application] = await db.insert(toolApplications).values({
        companyId: f.company.id, name: "Unrelated MCP", type: "mcp_http", status: "active",
      }).returning();
      const [connection] = await db.insert(toolConnections).values({
        companyId: f.company.id, applicationId: application.id, name: "Unrelated MCP",
        uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok",
      }).returning();
      await db.insert(toolCatalogEntries).values(Array.from({ length: 500 }, (_, i) => ({
        companyId: f.company.id, applicationId: application.id, connectionId: connection.id,
        entryKind: "tool" as const, name: `unrelated_${i}`, toolName: `unrelated_${i}`,
        inputSchema: { type: "object" }, riskLevel: "read" as const, status: "active" as const,
        versionHash: "fixture", schemaHash: "fixture",
      })));
      const { recordingDb } = await import("./helpers/tool-gateway-listing-fixture.js");
      const { toolDiscoveryScheduler } = await import("../services/tool-discovery-scheduler.js");
      const releases: Array<() => void> = [];
      const blockers = [0, 1].map(() => toolDiscoveryScheduler.run(() => new Promise<void>(resolve => releases.push(resolve))));
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      const recorded = recordingDb(db);
      const gateway = createToolGatewayService(recorded.db);
      const pending = gateway.browserUseResources(f.binding);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const resources = await Promise.race([pending, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Assignment waited for unrelated discovery")), 5_000);
        })]);
        expect(resources).toEqual([{ id: f.connection.connectionId, connectionId: f.connection.connectionId, label: "Browser Use Cloud" }]);
        const catalogReads = recorded.statements.flatMap((query, index) =>
          query.includes('from "tool_catalog_entries"') && query.includes('inner join "tool_connections"') ? [recorded.statementParams[index]] : []);
        expect(catalogReads).toHaveLength(1);
        expect(catalogReads[0]).toContain(f.connection.connectionId);
        expect(catalogReads[0]).not.toContain(connection.id);
        expect(recorded.statements.some(query => query.includes('from "chat_endpoints"'))).toBe(false);
      } finally {
        clearTimeout(timeout);
        releases.forEach(release => release());
        await Promise.all(blockers);
        await pending;
      }
    });
    it.each(["policy", "catalog", "grant"])("rechecks Browser Use %s revocation without a cached assignment", async kind => {
      const f = await fixture();
      expect(await f.gateway.browserUseResources(f.binding)).toHaveLength(1);
      if (kind === "policy") await db.insert(toolPolicies).values({
        companyId: f.company.id, name: "Revoke Browser Use", policyType: "block",
        selectors: { connectionId: f.connection.connectionId }, priority: 100,
      });
      if (kind === "catalog") await db.update(toolCatalogEntries).set({ quarantinedAt: new Date() }).where(eq(toolCatalogEntries.connectionId, f.connection.connectionId));
      if (kind === "grant") await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.grant.id));
      expect(await f.gateway.browserUseResources(f.binding)).toEqual([]);
    });
    it("withholds Cloud instructions when connection tools are disabled", async () => {
      const f = await fixture();
      await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.connection.connectionId));
      expect(await resolveConnectorAssignments(db, f.binding)).toEqual([]);
    });
    it("reapplies the renumbered migration without losing existing browser work", async () => {
      const f = await fixture();
      await f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", {
        task: "Read example.com",
        maxCostUsd: 0.5,
      });
      f.ready(); f.complete(); await f.tick();
      const previous = await db.select().from(browserUseRuns)
        .where(eq(browserUseRuns.companyId, f.company.id));
      expect(previous).toHaveLength(1);
      const [original] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.connectionId));
      await db.update(toolConnections).set({
        config: { ...original.config, sourceTemplateKey: "browser-use" },
        transportConfig: { ...original.transportConfig, sourceTemplateKey: "browser-use" },
      }).where(eq(toolConnections.id, original.id));
      await db.update(toolApplications).set({
        applicationKey: `app-gallery:browser-use:${original.id}`,
        metadata: { sourceTemplateKey: "browser-use", galleryKey: "browser-use" },
      }).where(eq(toolApplications.id, original.applicationId));
      const legacyCost = { provider: "browser-use", biller: "browser-use", billingCode: `browser-use:${previous[0].id}` };
      await db.update(costEvents).set(legacyCost).where(eq(costEvents.companyId, f.company.id));
      await db.update(financeEvents).set(legacyCost).where(eq(financeEvents.companyId, f.company.id));
      const migration = await readFile(new URL(
        "../../../packages/db/src/migrations/0290_browser_use_cloud.sql", import.meta.url,
      ), "utf8");
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await db.execute(sql.raw(statement));
        }
      }
      expect(await db.select().from(browserUseRuns)
        .where(eq(browserUseRuns.companyId, f.company.id))).toEqual(previous);
      const [migrated] = await db.select().from(toolConnections).where(eq(toolConnections.id, original.id));
      expect(migrated).toMatchObject({ config: { sourceTemplateKey: "browser-use-cloud" }, transportConfig: { sourceTemplateKey: "browser-use-cloud" }, credentialSecretRefs: original.credentialSecretRefs });
      expect(await db.select().from(toolApplications).where(eq(toolApplications.id, original.applicationId))).toMatchObject([{ applicationKey: `app-gallery:browser-use-cloud:${original.id}`, metadata: { sourceTemplateKey: "browser-use-cloud", galleryKey: "browser-use-cloud" } }]);
      expect(await resolveConnectorAssignments(db, f.binding)).toMatchObject([{ key: "browser-use-cloud" }]);
      await f.tick();
      expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toMatchObject([{ provider: "browser-use-cloud", biller: "browser-use-cloud", billingCode: `browser-use-cloud:${previous[0].id}`, costCents: 15 }]);
      expect(await db.select().from(financeEvents).where(eq(financeEvents.companyId, f.company.id))).toMatchObject([{ provider: "browser-use-cloud", amountCents: 15 }]);
    });
    it("delivers Browser Use through the pinned native and CLI runtime gateway", async () => {
      const f = await fixture();
      await db.insert(toolConnectionInstalls).values({
        companyId: f.company.id,
        connectionId: f.connection.connectionId,
        targetType: "agent",
        targetId: f.agent.id,
      });
      const snapshot = await resolveNativeRuntimeMcpSnapshot({
        db,
        agent: f.agent,
        runId: f.run.id,
      });
      expect(snapshot.bindingId).not.toBeNull();
      const servers = await buildPaperclipRuntimeMcpServers({
        db,
        agent: f.agent,
        runId: f.run.id,
        expectedAssignmentDigest: snapshot.digest,
      });
      expect(servers).toHaveLength(1);
      const gatewayPublicId = new URL(servers[0]!.url).pathname
        .split("/")
        .at(-1)!;
      const tools = await f.gateway.listToolsForNamedGateway({
        gatewayPublicId,
        bearerToken: servers[0]!.token!,
      });
      expect(tools).toHaveLength(7);
      expect(tools.some((tool) => tool.name.endsWith(":browser-start"))).toBe(
        true,
      );
    });

    it("verifies credentials without paid work, exposes REST tools and rejects invalid keys", async () => {
      const f = await fixture();
      expect(f.connection.catalog).toHaveLength(7);
      expect(
        f.request.mock.calls.every(([url]) => url.includes("/profiles")),
      ).toBe(true);
      expect(JSON.stringify(f.connection)).not.toContain("bu_fixture_secret");
      const tools = await f.gateway.listToolsForSession(f.gatewaySession.token);
      expect(
        tools.find((t) => t.upstreamToolName === "browser_start"),
      ).toMatchObject({ providerType: "provider_rest", risk: "destructive" });
      const start = tools.find((t) => t.upstreamToolName === "browser_start")!;
      const idempotencyKey = randomUUID();
      const result = await f.gateway.executeTool({
        sessionToken: f.gatewaySession.token,
        tool: start.name,
        parameters: { task: "Read example.com" },
        idempotencyKey,
      });
      expect(result.status).toBe("completed");
      expect(JSON.stringify(result)).not.toContain("bu_fixture_secret");
      await f.gateway.executeTool({
        sessionToken: f.gatewaySession.token,
        tool: start.name,
        parameters: { task: "Read example.com" },
        idempotencyKey,
      });
      expect(
        f.request.mock.calls.filter(
          ([url, init]) => url.endsWith("/runs") && init.method === "POST",
        ),
      ).toHaveLength(1);
      f.invalidate();
      await expect(
        f.access.refreshCatalog(f.connection.connectionId, actor),
      ).rejects.toThrow();
    });
    it("observes delayed browser.ready, hides viewer credentials, accounts once and cleans up", async () => {
      const f = await fixture();
      const invocation = randomUUID();
      const started = (await f.service.execute(
        f.binding,
        f.grant,
        invocation,
        "browser_start",
        { task: "Read example.com", maxCostUsd: 0.5 },
      )) as { sessionId: string };
      expect(started.sessionId).toBeTruthy();
      const createCall = f.request.mock.calls.find(
        ([url, init]) => url.endsWith("/runs") && init.method === "POST",
      );
      expect(
        JSON.parse(String(createCall?.[1].body)).browserSettings.allowResizing,
      ).toBe(true);
      await f.tick();
      expect(
        await db
          .select()
          .from(browserUseBrowsers)
          .where(eq(browserUseBrowsers.companyId, f.company.id)),
      ).toHaveLength(0);
      f.ready();
      await f.tick();
      const list = await f.service.list(
        f.company.id,
        f.issue.id,
        actor.actorId,
      );
      expect(list).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain("canary");
      expect(
        await f.service.viewer(
          f.company.id,
          f.issue.id,
          list[0].id,
          actor.actorId,
        ),
      ).toEqual({
        url: "https://live.browser-use.com/canary",
        viewport: "fit",
        viewportState: { preset: "fit" },
      });
      await expect(
        f.service.viewer(f.company.id, randomUUID(), list[0].id, actor.actorId),
      ).rejects.toThrow("not found");
      f.complete();
      await f.tick();
      await f.tick();
      const [s] = await db
        .select()
        .from(browserUseSessions)
        .where(eq(browserUseSessions.id, started.sessionId));
      expect(s.status).toBe("idle");
      expect(s.idleDeadline).toBeTruthy();
      expect(
        await db
          .select()
          .from(costEvents)
          .where(eq(costEvents.companyId, f.company.id)),
      ).toHaveLength(1);
      const ledger = await db
        .select()
        .from(financeEvents)
        .where(eq(financeEvents.companyId, f.company.id));
      const [cost] = await db
        .select()
        .from(costEvents)
        .where(eq(costEvents.companyId, f.company.id));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        issueId: f.issue.id,
        agentId: f.agent.id,
        costEventId: cost.id,
        amountCents: 15,
        biller: "browser-use-cloud",
        direction: "debit",
        currency: "USD",
      });
      expect(
        JSON.stringify(
          await f.service.execute(
            f.binding,
            f.grant,
            randomUUID(),
            "browser_status",
            { sessionId: s.id },
          ),
        ),
      ).not.toContain("canary");
      await f.service.control(s, "end");
      await f.tick();
      expect(
        (
          await db
            .select()
            .from(browserUseSessions)
            .where(eq(browserUseSessions.id, s.id))
        )[0].status,
      ).toBe("closed");
      expect(
        (
          await db
            .select()
            .from(browserUseBrowsers)
            .where(eq(browserUseBrowsers.sessionId, s.id))
        )[0].status,
      ).toBe("stopped");
    });
    it("keeps a viewed idle browser alive but still honors expiry, stop and authorization", async () => {
      const f = await fixture();
      const started = (await f.service.execute(
        f.binding,
        f.grant,
        randomUUID(),
        "browser_start",
        { task: "Read" },
      )) as { sessionId: string };
      f.ready();
      f.complete();
      await f.tick();
      const [browser] = await f.service.list(
        f.company.id,
        f.issue.id,
        actor.actorId,
      );
      const read = async () =>
        (
          await db
            .select()
            .from(browserUseSessions)
            .where(eq(browserUseSessions.id, started.sessionId))
        )[0];
      const original = new Date(Date.now() + 1_000);
      await db
        .update(browserUseSessions)
        .set({ idleDeadline: original })
        .where(eq(browserUseSessions.id, started.sessionId));
      await expect(
        f.service.presence(
          f.company.id,
          randomUUID(),
          browser.id,
          actor.actorId,
        ),
      ).rejects.toThrow();
      expect((await read()).idleDeadline?.getTime()).toBe(original.getTime());
      expect(
        await f.service.presence(
          f.company.id,
          f.issue.id,
          browser.id,
          actor.actorId,
        ),
      ).toEqual({ accepted: true });
      expect((await read()).idleDeadline!.getTime()).toBeGreaterThan(
        Date.now() + 9 * 60_000,
      );
      await f.tick();
      expect((await read()).status).toBe("idle");
      // Provider lifetime wins over viewer presence.
      const expiry = new Date(Date.now() + 3 * 60_000);
      await db
        .update(browserUseBrowsers)
        .set({ expiresAt: expiry })
        .where(eq(browserUseBrowsers.id, browser.id));
      await db
        .update(browserUseSessions)
        .set({ idleDeadline: original })
        .where(eq(browserUseSessions.id, started.sessionId));
      await f.service.presence(
        f.company.id,
        f.issue.id,
        browser.id,
        actor.actorId,
      );
      expect((await read()).idleDeadline?.getTime()).toBe(expiry.getTime());
      await f.service.control(await read(), "end");
      await expect(
        f.service.presence(f.company.id, f.issue.id, browser.id, actor.actorId),
      ).rejects.toThrow();
      await f.tick();
      expect((await read()).status).toBe("closed");
    });
    it("executes an approved start once after the original turn ends and attaches the resumed run", async () => {
      const f = await fixture();
      await db.insert(toolPolicies).values({
        companyId: f.company.id,
        name: "Review browser writes",
        policyType: "require_approval",
        selectors: { connectionId: f.connection.connectionId },
        priority: 10,
      });
      const start = (
        await f.gateway.listToolsForSession(f.gatewaySession.token)
      ).find((t) => t.upstreamToolName === "browser_start")!;
      await expect(
        f.gateway.executeTool({
          sessionToken: f.gatewaySession.token,
          tool: start.name,
          parameters: { task: "Read example.com" },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ reasonCode: "approval_required" });
      const [pending] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, f.company.id));
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded" })
        .where(eq(heartbeatRuns.id, f.run.id));
      if (pending.approvalId)
        await db
          .update(approvals)
          .set({
            status: "approved",
            decidedByUserId: actor.actorId,
            decidedAt: new Date(),
          })
          .where(eq(approvals.id, pending.approvalId));
      await f.gateway.approveActionRequest({
        companyId: f.company.id,
        actionRequestId: pending.id,
        actor: { userId: actor.actorId },
      });
      const [record] = await db
        .select()
        .from(browserUseRuns)
        .where(eq(browserUseRuns.companyId, f.company.id));
      expect(record?.providerRunId).toBeTruthy();
      expect(record.detachedUntil).toBeTruthy();
      f.ready();
      await f.tick();
      expect(
        (
          await db
            .select()
            .from(browserUseSessions)
            .where(eq(browserUseSessions.id, record.sessionId))
        )[0].status,
      ).toBe("running");
      const [resumed] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: f.company.id,
          agentId: f.agent.id,
          invocationSource: "on_demand",
          status: "running",
          responsibleUserId: actor.actorId,
          contextSnapshot: { issueId: f.issue.id },
        })
        .returning();
      await f.service.execute(
        { ...f.binding, runId: resumed.id },
        f.grant,
        randomUUID(),
        "browser_status",
        { sessionId: record.sessionId },
      );
      const [attached] = await db
        .select()
        .from(browserUseRuns)
        .where(eq(browserUseRuns.id, record.id));
      expect(attached.detachedUntil).toBeNull();
      expect(attached.heartbeatRunId).toBe(resumed.id);
      await f.gateway.approveActionRequest({
        companyId: f.company.id,
        actionRequestId: pending.id,
        actor: { userId: actor.actorId },
      });
      expect(
        f.request.mock.calls.filter(
          ([url, init]) => url.endsWith("/runs") && init.method === "POST",
        ),
      ).toHaveLength(1);
    });

    it("enforces task, agent, grant and profile ownership and never replays a create", async () => {
      const f = await fixture();
      const invocation = randomUUID();
      await expect(
        f.service.execute(f.binding, f.grant, invocation, "browser_start", {
          task: "Read",
          profileId: randomUUID(),
        }),
      ).rejects.toThrow("profile");
      const start = (await f.service.execute(
        f.binding,
        f.grant,
        invocation,
        "browser_start",
        { task: "Read" },
      )) as { sessionId: string };
      await f.service.execute(f.binding, f.grant, invocation, "browser_start", {
        task: "Read",
      });
      expect(
        f.request.mock.calls.filter(
          ([url, init]) => url.endsWith("/runs") && init.method === "POST",
        ),
      ).toHaveLength(1);
      await expect(
        f.service.execute(
          { ...f.binding, issueId: randomUUID() },
          f.grant,
          randomUUID(),
          "browser_status",
          { sessionId: start.sessionId },
        ),
      ).rejects.toThrow();
      await expect(
        f.service.execute(
          f.binding,
          { ...f.grant, id: randomUUID() },
          randomUUID(),
          "browser_status",
          { sessionId: start.sessionId },
        ),
      ).rejects.toThrow();
      await expect(
        f.service.execute(
          f.binding,
          f.grant,
          randomUUID(),
          "browser_continue",
          { sessionId: start.sessionId, task: "Again" },
        ),
      ).rejects.toThrow("busy");
      f.ready();
      await f.tick();
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, f.grant.id));
      expect(
        await f.service.list(f.company.id, f.issue.id, actor.actorId),
      ).toEqual([]);
      await f.tick();
      expect(
        (
          await db
            .select()
            .from(browserUseSessions)
            .where(eq(browserUseSessions.id, start.sessionId))
        )[0].status,
      ).toBe("closed");
    });
    it("does not replay an uncertain paid create", async () => {
      const f = await fixture();
      f.failCreate();
      const invocationId = randomUUID();
      await expect(
        f.service.execute(f.binding, f.grant, invocationId, "browser_start", {
          task: "Read",
        }),
      ).rejects.toThrow("could not be confirmed");
      const result = await f.service.execute(
        f.binding,
        f.grant,
        invocationId,
        "browser_start",
        { task: "Read" },
      );
      expect(result).toMatchObject({ status: "stopping", runStatus: "unknown" });
      expect(
        f.request.mock.calls.filter(
          ([url, init]) => url.endsWith("/runs") && init.method === "POST",
        ),
      ).toHaveLength(1);
    });
    it.each([409, 429])("keeps a browser visible and closable after a rejected continuation (%s)", async (code) => {
      const f = await fixture();
      const start = await f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", { task: "Read" }) as { sessionId: string };
      f.ready(); f.complete(); await f.tick();
      f.reject(code);
      await expect(f.service.execute(f.binding, f.grant, randomUUID(), "browser_continue", { task: "Read again", sessionId: start.sessionId })).rejects.toThrow();
      expect(await f.service.list(f.company.id, f.issue.id, actor.actorId)).toMatchObject([{ status: "idle" }]);
      const [session] = await db.select().from(browserUseSessions).where(eq(browserUseSessions.id, start.sessionId));
      await f.service.control(session, "end", actor.actorId);
      // The 429 response delays the whole credential's provider requests.
      if (code === 429) await new Promise(resolve => setTimeout(resolve, 1050));
      await f.tick();
      expect(await f.service.list(f.company.id, f.issue.id, actor.actorId)).toMatchObject([{ status: "closed" }]);
    });
    it("rolls back an interrupted rejection and closes the existing browser after restart", async () => {
      const f = await fixture();
      const start = await f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", { task: "Read" }) as { sessionId: string };
      f.ready(); f.complete(); await f.tick();
      f.reject(409);
      const invocationId = randomUUID();
      const transaction = db.transaction.bind(db);
      const interrupted = vi.spyOn(db, "transaction").mockImplementation((callback, config) =>
        transaction(async tx => {
          const result = await callback(tx);
          const [run] = await tx.select().from(browserUseRuns).where(eq(browserUseRuns.invocationId, invocationId));
          if (run?.status === "failed") throw new Error("process interrupted before commit");
          return result;
        }, config));
      try {
        await expect(f.service.execute(f.binding, f.grant, invocationId, "browser_continue", { task: "Read again", sessionId: start.sessionId })).rejects.toThrow("process interrupted");
      } finally {
        interrupted.mockRestore();
      }
      const [pending] = await db.select().from(browserUseRuns).where(eq(browserUseRuns.invocationId, invocationId));
      expect(pending).toMatchObject({ status: "creating", eventsDrained: 0, providerRunId: null });
      await db.update(browserUseRuns).set({ createdAt: new Date(Date.now() - 61_000) }).where(eq(browserUseRuns.id, pending.id));
      await db.update(browserUseSessions).set({ nextPollAt: new Date(0) }).where(eq(browserUseSessions.id, start.sessionId));
      await browserUseService(db, f.request).sweep();
      expect(await db.select().from(browserUseBrowsers).where(eq(browserUseBrowsers.sessionId, start.sessionId))).toMatchObject([{ status: "stopped" }]);
      expect(f.request.mock.calls.filter(([url, init]) => url.endsWith("/runs") && init.method === "POST")).toHaveLength(2);
    });
    it("recovers an accepted start after a lost response and restart, then stops and accounts without replay", async () => {
      const f = await fixture();
      f.loseReply(); f.recoveryPages(6);
      await expect(f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", { task: "Read" })).rejects.toThrow("could not be confirmed");
      await f.tick();
      const [pending] = await db.select().from(browserUseRuns).where(eq(browserUseRuns.companyId, f.company.id));
      expect(pending.recoveryCursor).toBe("5");
      await db.update(browserUseSessions).set({ nextPollAt: new Date(0) }).where(eq(browserUseSessions.companyId, f.company.id));
      await browserUseService(db, f.request).sweep();
      expect(await f.service.list(f.company.id, f.issue.id, actor.actorId)).toMatchObject([{ status: "closed" }]);
      expect(await db.select().from(financeEvents).where(eq(financeEvents.companyId, f.company.id))).toMatchObject([{ amountCents: 15 }]);
      expect(f.request.mock.calls.filter(([url, init]) => url.endsWith("/runs") && init.method === "POST")).toHaveLength(1);
    });
    it("recovers a continuation's lost reply within its existing provider session", async () => {
      const f = await fixture();
      const start = await f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", { task: "Read" }) as { sessionId: string };
      f.ready(); f.complete(); await f.tick();
      f.loseReply();
      await expect(f.service.execute(f.binding, f.grant, randomUUID(), "browser_continue", { task: "Read again", sessionId: start.sessionId })).rejects.toThrow("could not be confirmed");
      await f.tick();
      expect(await f.service.list(f.company.id, f.issue.id, actor.actorId)).toMatchObject([{ status: "closed" }]);
      expect(f.request.mock.calls.some(([url]) => new URL(url).searchParams.has("sessionId"))).toBe(true);
      expect(f.request.mock.calls.filter(([url, init]) => url.endsWith("/runs") && init.method === "POST")).toHaveLength(2);
    });
    it("recovers a process crash before provider identifiers were saved", async () => {
      const f = await fixture();
      const start = await f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", { task: "Read" }) as { sessionId: string };
      f.ready();
      await db.update(browserUseRuns).set({ providerRunId: null, status: "creating", createdAt: new Date(Date.now() - 61_000) }).where(eq(browserUseRuns.sessionId, start.sessionId));
      await db.update(browserUseSessions).set({ providerSessionId: null, status: "starting" }).where(eq(browserUseSessions.id, start.sessionId));
      await f.tick();
      expect(await f.service.list(f.company.id, f.issue.id, actor.actorId)).toMatchObject([{ status: "closed" }]);
      expect(f.request.mock.calls.filter(([url, init]) => url.endsWith("/runs") && init.method === "POST")).toHaveLength(1);
    });
    it("drains bounded event pages after restart before closing and accounting", async () => {
      const f = await fixture();
      const start = (await f.service.execute(
        f.binding,
        f.grant,
        randomUUID(),
        "browser_start",
        { task: "Read" },
      )) as { sessionId: string };
      f.ready();
      await f.tick();
      f.paginate();
      f.complete();
      const [session] = await db
        .select()
        .from(browserUseSessions)
        .where(eq(browserUseSessions.id, start.sessionId));
      await f.service.control(session, "end");
      await f.tick();
      expect(
        (
          await db
            .select()
            .from(browserUseSessions)
            .where(eq(browserUseSessions.id, start.sessionId))
        )[0].status,
      ).toBe("stopping");
      expect(
        await db
          .select()
          .from(costEvents)
          .where(eq(costEvents.companyId, f.company.id)),
      ).toHaveLength(0);
      await db
        .update(browserUseSessions)
        .set({ nextPollAt: new Date(0) })
        .where(eq(browserUseSessions.id, start.sessionId));
      await browserUseService(db, f.request).sweep();
      expect(
        (
          await db
            .select()
            .from(browserUseSessions)
            .where(eq(browserUseSessions.id, start.sessionId))
        )[0].status,
      ).toBe("closed");
      expect(
        (
          await db
            .select()
            .from(browserUseRuns)
            .where(eq(browserUseRuns.sessionId, start.sessionId))
        )[0],
      ).toMatchObject({ eventCursor: 9, eventsDrained: 1, accountedCents: 15 });
    });
    it.each(["task", "saved chat"])("protects %s browser routes from agent, other-company and read-only access", async (kind) => {
      const f = await fixture();
      if (kind === "saved chat") {
        await db.update(issues).set({
          conversationAgentId: f.agent.id,
          conversationUserId: actor.actorId,
          conversationState: "active",
        }).where(eq(issues.id, f.issue.id));
      }
      await f.service.execute(
        f.binding,
        f.grant,
        randomUUID(),
        "browser_start",
        { task: "Read" },
      );
      f.ready();
      await f.tick();
      const [browser] = await f.service.list(
        f.company.id,
        f.issue.id,
        actor.actorId,
      );
      let mode = "board";
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor =
          mode === "agent"
            ? {
                type: "agent",
                companyId: f.company.id,
                agentId: f.agent.id,
                source: "agent_key",
              }
            : {
                type: "board",
                userId: actor.actorId,
                source: "session",
                companyIds: mode === "other-company" ? [] : [f.company.id],
              };
        next();
      });
      app.use(browserUseRoutes(db, f.service));
      app.use(errorHandler);
      const listPath = `/issues/${f.issue.id}/browsers`;
      const listed = await http(app).get(listPath);
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject([{ id: browser.id, issueId: f.issue.id }]);
      const missing = await http(app).get(`/issues/${randomUUID()}/browsers`);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: "Task not found" });
      const path = `/issues/${f.issue.id}/browsers/${browser.id}/viewer`;
      const ok = await http(app).get(path);
      expect(ok.status).toBe(200);
      expect(ok.headers["cache-control"]).toBe("no-store");
      expect(ok.headers["referrer-policy"]).toBe("no-referrer");
      const controlPath = path.replace("/viewer", "/control");
      const presencePath = path.replace("/viewer", "/presence");
      expect((await http(app).post(presencePath)).status).toBe(200);
      const resizePath = path.replace("/viewer", "/viewport");
      const resizeSpy = vi
        .spyOn(browserUseViewports, "resize")
        .mockResolvedValue({ preset: "phone" });
      expect(
        (await http(app).post(resizePath).send({ preset: "phone" })).body,
      ).toEqual({ preset: "phone" });
      expect(resizeSpy).toHaveBeenCalledTimes(1);
      const viewerId = randomUUID();
      resizeSpy.mockResolvedValueOnce({
        preset: "fit",
        width: 531,
        height: 712,
        applied: true,
      });
      expect(
        (
          await http(app)
            .post(resizePath)
            .send({ preset: "fit", width: 531, height: 712, viewerId })
        ).body,
      ).toMatchObject({ preset: "fit", width: 531 });
      expect(resizeSpy).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.any(String),
        { preset: "fit", width: 531, height: 712, viewerId },
        expect.any(String),
        `${actor.actorId}:${viewerId}`,
      );
      expect(
        (await http(app).post(`${resizePath}/release`).send({ viewerId }))
          .status,
      ).toBe(200);
      expect(
        (await http(app).post(resizePath).send({ preset: "custom", width: 1 }))
          .status,
      ).toBe(400);
      expect((await http(app).post(controlPath).send({ action: "cancel" })).status).toBe(200);
      mode = "agent";
      expect((await http(app).get(listPath)).status).toBe(403);
      expect((await http(app).post(controlPath).send({ action: "keep_open" })).status).toBe(403);
      expect((await http(app).post(presencePath)).status).toBe(403);
      expect(
        (await http(app).post(`${resizePath}/release`).send({ viewerId }))
          .status,
      ).toBe(403);
      expect(
        (await http(app).post(resizePath).send({ preset: "phone" })).status,
      ).toBe(403);
      expect((await http(app).get(path)).status).toBe(403);
      mode = "other-company";
      const inaccessible = await http(app).get(listPath);
      expect(inaccessible.status).toBe(missing.status);
      expect(inaccessible.body).toEqual(missing.body);
      expect((await http(app).post(controlPath).send({ action: "keep_open" })).status).toBe(404);
      expect((await http(app).post(presencePath)).status).toBe(404);
      expect(
        (await http(app).post(`${resizePath}/release`).send({ viewerId }))
          .status,
      ).toBe(404);
      expect(
        (await http(app).post(resizePath).send({ preset: "phone" })).status,
      ).toBe(404);
      expect((await http(app).get(path)).status).toBe(404);
      mode = "board";
      await db
        .update(companyMemberships)
        .set({ membershipRole: "viewer" })
        .where(eq(companyMemberships.companyId, f.company.id));
      expect((await http(app).get(path)).status).toBe(403);
      expect((await http(app).get(listPath)).body).toEqual([]);
      expect((await http(app).post(controlPath).send({ action: "keep_open" })).status).toBe(403);
      expect((await http(app).post(presencePath)).status).toBe(403);
      expect(
        (await http(app).post(resizePath).send({ preset: "phone" })).status,
      ).toBe(403);
      expect(resizeSpy).toHaveBeenCalledTimes(2);
      resizeSpy.mockRestore();
    });
    it("rechecks current gateway access and closes browsers when it is removed", async () => {
      const f = await fixture();
      const start = (
        await f.gateway.listToolsForSession(f.gatewaySession.token)
      ).find((t) => t.upstreamToolName === "browser_start")!;
      await f.gateway.executeTool({
        sessionToken: f.gatewaySession.token,
        tool: start.name,
        parameters: { task: "Read" },
        idempotencyKey: randomUUID(),
      });
      f.ready();
      await f.tick();
      const [run] = await db
        .select()
        .from(browserUseRuns)
        .where(eq(browserUseRuns.companyId, f.company.id));
      const scope = {
        ...f.binding,
        runId: run.heartbeatRunId,
        connectionId: f.grant.connectionId,
        grantId: f.grant.id,
        invocationId: run.invocationId,
      };
      expect(await f.gateway.browserUseSessionAuthorized(scope)).toBe(true);
      await db.insert(toolPolicies).values({
        companyId: f.company.id,
        name: "Disable browser access",
        policyType: "block",
        selectors: { connectionId: f.connection.connectionId },
        priority: 100,
      });
      expect(await f.gateway.browserUseSessionAuthorized(scope)).toBe(false);
      await db
        .update(browserUseSessions)
        .set({ nextPollAt: new Date(0) })
        .where(eq(browserUseSessions.companyId, f.company.id));
      await browserUseService(db, f.request, {}, () =>
        f.gateway.browserUseSessionAuthorized(scope),
      ).sweep();
      expect(
        (
          await db
            .select()
            .from(browserUseSessions)
            .where(eq(browserUseSessions.id, run.sessionId))
        )[0].status,
      ).toBe("closed");
    });

    it("resolves only the selected personal credential and denies another member's viewer", async () => {
      const f = await fixture(true);
      expect(f.grant.kind).toBe("user");
      const tool = (
        await f.gateway.listToolsForSession(f.gatewaySession.token)
      ).find((t) => t.upstreamToolName === "browser_start")!;
      await f.gateway.executeTool({
        sessionToken: f.gatewaySession.token,
        tool: tool.name,
        parameters: { task: "Read" },
        idempotencyKey: randomUUID(),
      });
      f.ready();
      await f.tick();
      const [browser] = await f.service.list(
        f.company.id,
        f.issue.id,
        actor.actorId,
      );
      expect(
        await f.service.viewer(
          f.company.id,
          f.issue.id,
          browser.id,
          actor.actorId,
        ),
      ).toHaveProperty("url");
      await db.insert(companyMemberships).values({
        companyId: f.company.id,
        principalType: "user",
        principalId: "other-reviewer",
        membershipRole: "admin",
        status: "active",
      });
      await expect(
        f.service.viewer(
          f.company.id,
          f.issue.id,
          browser.id,
          "other-reviewer",
        ),
      ).rejects.toThrow("another credential");
      await f.access.archiveConnection(
        f.connection.connectionId,
        f.company.id,
        actor,
      );
      expect(
        (
          await db
            .select()
            .from(browserUseSessions)
            .where(eq(browserUseSessions.companyId, f.company.id))
        )[0].status,
      ).toBe("closed");
    });
    it("continues an idle conversation and bounds Keep open with idle cleanup", async () => {
      const f = await fixture();
      const start = (await f.service.execute(
        f.binding,
        f.grant,
        randomUUID(),
        "browser_start",
        { task: "Read" },
      )) as { sessionId: string };
      f.ready();
      f.complete();
      await f.tick();
      const [idle] = await db
        .select()
        .from(browserUseSessions)
        .where(eq(browserUseSessions.id, start.sessionId));
      await f.service.control(idle, "keep_open");
      await f.service.execute(
        f.binding,
        f.grant,
        randomUUID(),
        "browser_continue",
        { sessionId: start.sessionId, task: "Follow up" },
      );
      expect(
        await db
          .select()
          .from(browserUseRuns)
          .where(eq(browserUseRuns.sessionId, start.sessionId)),
      ).toHaveLength(2);
      const calls = f.request.mock.calls.filter(
        ([url, init]) => url.endsWith("/runs") && init.method === "POST",
      );
      expect(JSON.parse(String(calls[1][1].body)).sessionId).toBe(
        idle.providerSessionId,
      );
      f.complete();
      await f.tick();
      await db
        .update(browserUseSessions)
        .set({ idleDeadline: new Date(0) })
        .where(eq(browserUseSessions.id, start.sessionId));
      await f.tick();
      expect(
        (
          await db
            .select()
            .from(browserUseSessions)
            .where(eq(browserUseSessions.id, start.sessionId))
        )[0].status,
      ).toBe("closed");
    });
    it("serializes browser holds with parent reservations while provider work is delayed", async () => {
      const f = await fixture();
      const policy = await budgetService(db).upsertPolicy(f.company.id,
        { scopeType: "company", scopeId: f.company.id, amount: 100, hardStopEnabled: true }, actor.actorId);
      await db.insert(budgetReservations).values({ companyId: f.company.id, runId: f.run.id, agentId: f.agent.id, amountCents: "40" });
      let release!: () => void, started!: () => void;
      const providerEntered = new Promise<void>(resolve => { started = resolve; });
      const providerRelease = new Promise<void>(resolve => { release = resolve; });
      f.delayCreate(async () => { started(); await providerRelease; });
      const first = f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", { task: "Read", maxCostUsd: 0.8 });
      // Attach the rejection handler before waiting for the controlled POST.
      await Promise.race([providerEntered, first.then(() => undefined)]);
      try {
        await expect(f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", { task: "Concurrent" })).rejects.toThrow("reserved");
        const [row] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.policyId));
        expect(await computeObservedSpend(db, row)).toMatchObject({ ledgerCents: "0.0000000", effectiveHeldCents: "100.0000000" });
        expect(f.request.mock.calls.filter(([url, init]) => url.endsWith("/runs") && init.method === "POST")).toHaveLength(1);
        const call = f.request.mock.calls.find(([url, init]) => url.endsWith("/runs") && init.method === "POST")!;
        expect(JSON.parse(String(call[1].body)).maxCostUsd).toBe(0.6);
        // Accounting lock is not held while the hosted browser is waiting.
        expect(await db.select({ id: companies.id }).from(companies).where(eq(companies.id, f.company.id))).toHaveLength(1);
      } finally { release(); await first; }
    });
    it.each(["reduction", "new_policy", "config", "charge", "cancel", "session_end", "policy_deny"])("rechecks %s at the actual provider handoff", async race => {
      const f = await fixture();
      if (race === "reduction" || race === "charge") await budgetService(db).upsertPolicy(f.company.id,
        { scopeType: "company", scopeId: f.company.id, amount: 100, hardStopEnabled: true }, actor.actorId);
      const invocationId = randomUUID();
      const transaction = db.transaction.bind(db);
      let injected = false;
      const barrier = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
        const result = await transaction(callback, config);
        const [run] = await db.select().from(browserUseRuns).where(eq(browserUseRuns.invocationId, invocationId));
        if (!injected && run?.status === "creating" && !(run.result as { paperclipBudgetHold?: { dispatchCommittedAt?: string } })?.paperclipBudgetHold?.dispatchCommittedAt) {
          injected = true;
          if (race === "reduction" || race === "new_policy") await budgetService(db).upsertPolicy(f.company.id,
            { scopeType: "company", scopeId: f.company.id, amount: race === "new_policy" ? 100 : 10, hardStopEnabled: true }, actor.actorId);
          else if (race === "config") await f.service.saveSettings(f.company.id, f.grant.id, actor.actorId, { allowedProfileIds: [], maxCostUsd: 0.1 });
          else if (race === "charge") {
            const { costService } = await import("../services/costs.js");
            await costService(db).createEvent(f.company.id, { agentId: f.agent.id, provider: "fixture", model: "fixture", costCents: 20, occurredAt: new Date() });
          } else if (race === "policy_deny") await db.insert(toolPolicies).values({ companyId: f.company.id,
            name: "Deny before browser handoff", policyType: "block", selectors: { connectionId: f.connection.connectionId }, priority: 0 });
          else if (race === "session_end") await db.update(browserUseSessions).set({ status: "stopping", stopRequested: "end" }).where(eq(browserUseSessions.id, run.sessionId));
          else await db.update(heartbeatRuns).set({ resultJson: { startupCancellation: { requestedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, f.run.id));
        }
        return result;
      });
      try {
        await expect(f.service.execute(f.binding, f.grant, invocationId, "browser_start", { task: "Must not start" })).rejects.toThrow();
      } finally { barrier.mockRestore(); }
      expect(injected).toBe(true);
      expect(f.request.mock.calls.filter(([url, init]) => url.endsWith("/runs") && init.method === "POST")).toHaveLength(0);
      const [run] = await db.select().from(browserUseRuns).where(eq(browserUseRuns.invocationId, invocationId));
      expect(run).toMatchObject({ status: "failed", eventsDrained: 1, result: { paperclipBudgetHold: { state: "released" } } });
    });
    it.each(["default_allow", "tool_name"])("retains valid %s profile authorization at browser admission", async selector => {
      const f = await fixture();
      await db.update(toolProfiles).set({ status: "inactive" }).where(eq(toolProfiles.companyId, f.company.id));
      const [profile] = await db.insert(toolProfiles).values({ companyId: f.company.id, name: "Scoped browser access",
        profileKey: randomUUID(), defaultAction: selector === "default_allow" ? "allow" : "deny" }).returning();
      await db.insert(toolProfileBindings).values({ companyId: f.company.id, profileId: profile.id, targetType: "agent", targetId: f.agent.id });
      if (selector === "tool_name") await db.insert(toolProfileEntries).values({ companyId: f.company.id, profileId: profile.id,
        selectorType: "tool_name", toolName: "browser_start", effect: "include" });
      await expect(f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", { task: "Allowed by profile" })).resolves.toMatchObject({ status: "running" });
      expect(f.request.mock.calls.filter(([url, init]) => url.endsWith("/runs") && init.method === "POST")).toHaveLength(1);
    });
    it("checks the gateway invocation's namespaced tool identity for explicit denial", async () => {
      const f = await fixture();
      const invocationId = randomUUID(), toolName = "app.browser-fixture:browser-start";
      const [entry] = await db.select().from(toolCatalogEntries).where(and(eq(toolCatalogEntries.connectionId, f.connection.connectionId), eq(toolCatalogEntries.toolName, "browser_start")));
      await db.insert(toolInvocations).values({ id: invocationId, companyId: f.company.id, agentId: f.agent.id,
        runId: f.run.id, issueId: f.issue.id, actorType: "agent", actorId: f.agent.id,
        connectionId: f.connection.connectionId, applicationId: entry.applicationId, catalogEntryId: entry.id,
        toolName, upstreamToolName: "browser_start", policyDecision: "allow", status: "executing" });
      await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Block namespaced invocation",
        policyType: "block", selectors: { toolName }, priority: 0 });
      await expect(f.service.execute(f.binding, f.grant, invocationId, "browser_start", { task: "Denied" })).rejects.toThrow("blocked");
      expect(f.request.mock.calls.filter(([url, init]) => url.endsWith("/runs") && init.method === "POST")).toHaveLength(0);
    });
    it("releases a crashed reservation that never reached provider dispatch authority", async () => {
      const f = await fixture();
      const policy = await budgetService(db).upsertPolicy(f.company.id,
        { scopeType: "agent", scopeId: f.agent.id, amount: 100, hardStopEnabled: true }, actor.actorId);
      const [session] = await db.insert(browserUseSessions).values({ companyId: f.company.id, issueId: f.issue.id,
        agentId: f.agent.id, connectionId: f.connection.connectionId, grantId: f.grant.id, status: "starting" }).returning();
      const invocationId = randomUUID();
      const [run] = await db.insert(browserUseRuns).values({ companyId: f.company.id, sessionId: session.id,
        heartbeatRunId: f.run.id, invocationId, createdAt: new Date(Date.now() - 61_000),
        result: { paperclipBudgetHold: { invocationId, amountCents: "50.0000000", state: "held", projectId: null } } }).returning();
      f.request.mockClear();
      await f.tick();
      const [policyRow] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.policyId));
      expect((await computeObservedSpend(db, policyRow)).effectiveHeldCents).toBe("0.0000000");
      expect((await db.select().from(browserUseRuns).where(eq(browserUseRuns.id, run.id)))[0]).toMatchObject({ status: "failed", eventsDrained: 1, result: { paperclipBudgetHold: { state: "released" } } });
      expect((await db.select().from(browserUseSessions).where(eq(browserUseSessions.id, session.id)))[0].status).toBe("failed");
      expect(f.request.mock.calls.some(([url]) => new URL(url).pathname === "/api/v4/runs")).toBe(false);
    });
    it("releases a definitively rejected browser hold without inventing a charge", async () => {
      const f = await fixture();
      const policy = await budgetService(db).upsertPolicy(f.company.id,
        { scopeType: "agent", scopeId: f.agent.id, amount: 100, hardStopEnabled: true }, actor.actorId);
      f.reject(409);
      await expect(f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", { task: "Rejected", maxCostUsd: 0.5 })).rejects.toThrow("busy");
      const [row] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.policyId));
      expect(await computeObservedSpend(db, row)).toMatchObject({ ledgerCents: "0.0000000", effectiveHeldCents: "0.0000000" });
      expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toHaveLength(0);
      await db.update(browserUseRuns).set({ result: null }).where(eq(browserUseRuns.companyId, f.company.id));
      expect((await computeObservedSpend(db, row)).unknownBrowserRunCount).toBe(0);
    });
    it.each(["company", "agent", "project"] as const)("treats a running uncapped browser as unknown when a %s budget is introduced", async scopeType => {
      for (const legacy of [false, true]) {
        const f = await fixture();
        const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Browser project" }).returning();
        const [otherProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Unrelated project" }).returning();
        await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issue.id));
        const invocation = randomUUID();
        await expect(f.service.execute(f.binding, f.grant, invocation, "browser_start", { task: "Uncapped running work" })).resolves.toMatchObject({ status: "running" });
        const [run] = await db.select().from(browserUseRuns).where(eq(browserUseRuns.invocationId, invocation));
        expect(run.result).toMatchObject({ paperclipBudgetHold: { amountCents: "0.0000000", uncapped: true } });
        expect(JSON.parse(String(f.request.mock.calls.find(([url, init]) => url.endsWith("/runs") && init.method === "POST")![1].body))).not.toHaveProperty("maxCostUsd");
        if (legacy) await db.update(browserUseRuns).set({ result: null }).where(eq(browserUseRuns.id, run.id));
        const scopeId = scopeType === "company" ? f.company.id : scopeType === "agent" ? f.agent.id : project.id;
        const policy = await budgetService(db).upsertPolicy(f.company.id,
          { scopeType, scopeId, amount: 100, hardStopEnabled: true }, actor.actorId);
        const [row] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.policyId));
        expect(await computeObservedSpend(db, row)).toMatchObject({ ledgerCents: "0.0000000", effectiveHeldCents: "0.0000000", unknownBrowserRunCount: 1 });
        expect((await computeObservedSpend(db, { ...row, scopeType: "project", scopeId: otherProject.id })).unknownBrowserRunCount).toBe(0);
        expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id, { projectId: project.id })).not.toBeNull();
        f.request.mockClear();
        await expect(f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", { task: "Must wait for priced work" })).rejects.toThrow();
        expect(f.request.mock.calls.filter(([url, init]) => url.endsWith("/runs") && init.method === "POST")).toHaveLength(0);
        await budgetService(db).upsertPolicy(f.company.id,
          { scopeType, scopeId, amount: 100, hardStopEnabled: true, unpricedUsagePolicy: "allow" }, actor.actorId);
        expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id, { projectId: project.id })).toBeNull();
        f.complete(); await f.tick();
        expect(await computeObservedSpend(db, row)).toMatchObject({ ledgerCents: "15.0000000", effectiveHeldCents: "0.0000000", unknownBrowserRunCount: 0 });
      }
    });
    it.each([
      { label: "explicit capped zero", uncapped: false, state: "held", dispatched: true, status: "running", expected: 0 },
      { label: "legacy zero cap without a flag", uncapped: undefined, state: "held", dispatched: true, status: "running", expected: 1 },
      { label: "uncapped before dispatch", uncapped: true, state: "held", dispatched: false, status: "creating", expected: 0 },
      { label: "failed before dispatch", uncapped: true, state: "released", dispatched: false, status: "failed", expected: 0 },
    ])("distinguishes $label from unfinished uncapped spending", async item => {
      const f = await fixture();
      const [session] = await db.insert(browserUseSessions).values({ companyId: f.company.id, issueId: f.issue.id,
        agentId: f.agent.id, connectionId: f.connection.connectionId, grantId: f.grant.id, status: "running" }).returning();
      const invocationId = randomUUID();
      await db.insert(browserUseRuns).values({ companyId: f.company.id, sessionId: session.id, heartbeatRunId: f.run.id,
        invocationId, status: item.status, providerRunId: item.dispatched ? randomUUID() : null, eventsDrained: item.status === "failed" ? 1 : 0,
        result: { paperclipBudgetHold: { invocationId, amountCents: "0.0000000", projectId: null, state: item.state,
          ...(item.uncapped === undefined ? {} : { uncapped: item.uncapped }),
          ...(item.dispatched ? { dispatchCommittedAt: new Date().toISOString() } : {}) } } });
      const policy = await budgetService(db).upsertPolicy(f.company.id,
        { scopeType: "company", scopeId: f.company.id, amount: 100, hardStopEnabled: true }, actor.actorId);
      const [row] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.policyId));
      expect(await computeObservedSpend(db, row)).toMatchObject({ ledgerCents: "0.0000000", effectiveHeldCents: "0.0000000", unknownBrowserRunCount: item.expected });
      const block = await budgetService(db).getInvocationBlock(f.company.id, f.agent.id);
      expect(Boolean(block)).toBe(item.expected > 0);
    });
    it("blocks new budgeted work after an uncapped browser POST becomes uncertain", async () => {
      const f = await fixture();
      f.loseReply();
      const uncertain = randomUUID();
      await expect(f.service.execute(f.binding, f.grant, uncertain, "browser_start", { task: "Uncapped" })).rejects.toThrow("could not be confirmed");
      const policy = await budgetService(db).upsertPolicy(f.company.id,
        { scopeType: "company", scopeId: f.company.id, amount: 100, hardStopEnabled: true }, actor.actorId);
      const [row] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.policyId));
      expect(await computeObservedSpend(db, row)).toMatchObject({ ledgerCents: "0.0000000", effectiveHeldCents: "0.0000000", unknownBrowserRunCount: 1 });
      f.request.mockClear();
      await expect(f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", { task: "Must wait" })).rejects.toThrow();
      expect(f.request.mock.calls.filter(([url, init]) => url.endsWith("/runs") && init.method === "POST")).toHaveLength(0);
      // The existing unpriced-usage policy remains the explicit operator override.
      await budgetService(db).upsertPolicy(f.company.id,
        { scopeType: "company", scopeId: f.company.id, amount: 100, hardStopEnabled: true, unpricedUsagePolicy: "allow" }, actor.actorId);
      expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
      f.usage("0.15");
      await f.tick();
      expect(await computeObservedSpend(db, row)).toMatchObject({ ledgerCents: "15.0000000", unknownBrowserRunCount: 0 });
    });
    it("retains unknown browser holds and settles exact terminal usage without exposing internal metadata", async () => {
      const f = await fixture();
      const policy = await budgetService(db).upsertPolicy(f.company.id,
        { scopeType: "company", scopeId: f.company.id, amount: 100, hardStopEnabled: true }, actor.actorId);
      f.loseReply();
      const invocation = randomUUID();
      await expect(f.service.execute(f.binding, f.grant, invocation, "browser_start", { task: "Read", maxCostUsd: 0.5 })).rejects.toThrow("could not be confirmed");
      const [row] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.policyId));
      expect((await computeObservedSpend(db, row)).effectiveHeldCents).toBe("50.0000000");
      f.usage("0.150000001");
      await f.tick();
      expect(await computeObservedSpend(db, row)).toMatchObject({ ledgerCents: "15.0000001", effectiveHeldCents: "0.0000000" });
      const [run] = await db.select().from(browserUseRuns).where(eq(browserUseRuns.invocationId, invocation));
      expect(run.result).toMatchObject({ paperclipBudgetHold: { state: "settled", accountedCentsExact: "15.0000001" } });
      const replay = await f.service.execute(f.binding, f.grant, invocation, "browser_start", { task: "Read" });
      expect(JSON.stringify(replay)).not.toContain("paperclipBudgetHold");
      expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toHaveLength(1);
    });
    it("retains exact cumulative accounting when an older browser row has no hold projection", async () => {
      const f = await fixture();
      const invocation = randomUUID();
      await f.service.execute(f.binding, f.grant, invocation, "browser_start", { task: "Legacy result" });
      const [run] = await db.select().from(browserUseRuns).where(eq(browserUseRuns.invocationId, invocation));
      await db.update(browserUseRuns).set({ result: null }).where(eq(browserUseRuns.id, run.id));
      f.usage("0.150000001"); f.complete(); await f.tick();
      await db.update(browserUseRuns).set({ eventsDrained: 0 }).where(eq(browserUseRuns.id, run.id));
      f.usage("0.150000002"); await f.tick();
      const [total] = await db.select({ cents: sql<string>`sum(${costEvents.costCents})::text` }).from(costEvents).where(eq(costEvents.companyId, f.company.id));
      expect(total.cents).toBe("15.0000002");
      expect((await db.select().from(browserUseRuns).where(eq(browserUseRuns.id, run.id)))[0].result)
        .toMatchObject({ paperclipBudgetHold: { state: "settled", accountedCentsExact: "15.0000002" } });
    });
    it("forwards an optional proxy exit country and rejects an invalid code", async () => {
      const f = await fixture();
      // "CH" has the wrong case and "zz" is unassigned; both stop here.
      for (const proxyCountryCode of ["CH", "zz"])
        await expect(
          f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", {
            task: "Read",
            proxyCountryCode,
          }),
        ).rejects.toThrow();
      const start = (await f.service.execute(
        f.binding,
        f.grant,
        randomUUID(),
        "browser_start",
        { task: "Read", proxyCountryCode: "ch" },
      )) as { sessionId: string };
      f.ready();
      f.complete();
      await f.tick();
      await f.service.execute(
        f.binding,
        f.grant,
        randomUUID(),
        "browser_continue",
        {
          sessionId: start.sessionId,
          task: "Follow up",
          proxyCountryCode: null,
        },
      );
      const settings = f.request.mock.calls
        .filter(([url, init]) => url.endsWith("/runs") && init.method === "POST")
        .map(([, init]) => JSON.parse(String(init.body)).browserSettings);
      expect(settings).toHaveLength(2);
      expect(settings[0].proxyCountryCode).toBe("ch");
      // null is the provider's documented way to disable the default proxy.
      expect(settings[1].proxyCountryCode).toBeNull();
      // A start without the field keeps the request body of earlier releases.
      const plain = await fixture();
      await plain.service.execute(
        plain.binding,
        plain.grant,
        randomUUID(),
        "browser_start",
        { task: "Read" },
      );
      const [, init] = plain.request.mock.calls.find(
        ([url, call]) => url.endsWith("/runs") && call.method === "POST",
      )!;
      expect(JSON.parse(String(init.body)).browserSettings).not.toHaveProperty(
        "proxyCountryCode",
      );
    });
    it("caps paid work at the remaining hard budget and enforces reported spend", async () => {
      const f = await fixture();
      await budgetService(db).upsertPolicy(
        f.company.id,
        {
          scopeType: "agent",
          scopeId: f.agent.id,
          amount: 15,
          hardStopEnabled: true,
        },
        actor.actorId,
      );
      await f.service.saveSettings(f.company.id, f.grant.id, actor.actorId, {
        allowedProfileIds: [],
        maxCostUsd: 0.5,
      });
      await f.service.execute(
        f.binding,
        f.grant,
        randomUUID(),
        "browser_start",
        { task: "Read", maxCostUsd: 1 },
      );
      const call = f.request.mock.calls.find(
        ([url, init]) => url.endsWith("/runs") && init.method === "POST",
      )!;
      expect(JSON.parse(String(call[1].body))).toMatchObject({
        maxCostUsd: 0.15,
        browserSettings: { record: false },
      });
      f.ready();
      f.complete();
      await f.tick();
      await f.tick();
      expect(
        (await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0],
      ).toMatchObject({ status: "paused", spentMonthlyCents: 15 });
      expect(
        (
          await db
            .select()
            .from(browserUseSessions)
            .where(eq(browserUseSessions.companyId, f.company.id))
        )[0].status,
      ).toBe("closed");
      await expect(
        f.service.execute(f.binding, f.grant, randomUUID(), "browser_start", {
          task: "Read again",
        }),
      ).rejects.toThrow();
    });
    it("preserves the idle grace period when the task and parent finish before the last poll", async () => {
      const f = await fixture();
      await f.service.execute(
        f.binding,
        f.grant,
        randomUUID(),
        "browser_start",
        { task: "Read" },
      );
      f.ready();
      f.complete();
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded" })
        .where(eq(heartbeatRuns.id, f.run.id));
      await db
        .update(issues)
        .set({ status: "done" })
        .where(eq(issues.id, f.issue.id));
      await f.tick();
      expect(
        (
          await db
            .select()
            .from(browserUseSessions)
            .where(eq(browserUseSessions.companyId, f.company.id))
        )[0].status,
      ).toBe("idle");
      expect(
        f.request.mock.calls.some(([url]) => url.endsWith("/cancel")),
      ).toBe(false);
    });
    it("confirms hosted shutdown before removing the connection credential", async () => {
      const f = await fixture();
      await f.service.execute(
        f.binding,
        f.grant,
        randomUUID(),
        "browser_start",
        { task: "Read" },
      );
      f.ready();
      await f.tick();
      await f.access.archiveConnection(
        f.connection.connectionId,
        f.company.id,
        actor,
      );
      const [session] = await db
        .select()
        .from(browserUseSessions)
        .where(eq(browserUseSessions.companyId, f.company.id));
      expect(session.status).toBe("closed");
      const [grant] = await db
        .select()
        .from(connectionGrants)
        .where(eq(connectionGrants.id, f.grant.id));
      expect(grant.status).toBe("revoked");
      expect(grant.credentialSecretRefs).toEqual([]);
    });
  },
);
