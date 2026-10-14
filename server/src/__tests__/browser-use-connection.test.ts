import { budgetService } from "../services/budgets.js";
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
  toolPolicies,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  toolConnections,
  toolApplications,
  toolConnectionInstalls,
  toolProfiles,
  toolProfileBindings,
  browserUseSessions,
  browserUseRuns,
  browserUseBrowsers,
  costEvents,
  financeEvents,
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
            totalCostUsd: "0.15",
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
        await service.sweep();
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
