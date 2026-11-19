import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  agents,
  chatEndpoints,
  chatSlackRegistrations,
  companies,
  createDb,
  toolApplications,
  toolConnections,
  toolCatalogEntries,
} from "@paperclipai/db";
import { buildSlackAppManifest, SLACK_DEFAULT_BOT_SCOPES, SLACK_OPT_IN_SCOPE_GROUPS } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../../__tests__/helpers/embedded-postgres.js";
import { applySlackOptInManifestChange, canonicalJson, ensureSlackManifestScopesCurrent, recordInstalledSlackOptIns, slackInstallManifestHash } from "./opt-in-manifest.js";
import { instanceSettingsService } from "../../../instance-settings.js";
import { slackBotCatalogIsCurrent, syncSlackBotTools } from "../../slack-catalog.js";

const support = await getEmbeddedPostgresTestSupport();

/** TECH-7988: manifest/pending/hash/atomic-write and catalog status invariants. */
describe("Slack opt-in manifest machinery", () => {
  it("hashes key-reordered manifests identically", () => {
    const manifest = {
      oauth_config: { scopes: { bot: ["chat:write", "commands"] } },
      settings: { interactivity: { request_url: "https://x/hook", is_enabled: true } },
    };
    const reordered = {
      settings: { interactivity: { is_enabled: true, request_url: "https://x/hook" } },
      oauth_config: { scopes: { bot: ["chat:write", "commands"] } },
    };
    expect(slackInstallManifestHash(manifest)).toBe(slackInstallManifestHash(reordered));
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(slackInstallManifestHash({ a: 1 })).not.toBe(slackInstallManifestHash({ a: 2 }));
  });

  const describeDb = support.supported ? describe : describe.skip;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;

  async function fixture() {
    database ??= await startEmbeddedPostgresTestDatabase("paperclip-slack-opt-in-");
    db ??= createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    const [company] = await db.insert(companies).values({ name: `Opt-in ${randomUUID()}`, issuePrefix: `SO${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Opt-in agent" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, name: "Slack", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, name: "Slack", uid: randomUUID(), transport: "mcp_remote" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({
      companyId: company.id, connectionId: connection.id, assignedAgentId: agent.id,
      provider: "slack", publicId: randomUUID(), status: "active",
      setup: {
        step: "complete" as const,
        slackSetupMethod: "managed" as const,
        slackApp: { appName: "maya-paperclip", botName: "maya", command: "/maya" },
        slackOptInScopeGroups: [],
        slackInstalledOptInScopeGroups: [],
        slackInstalledDefaultScopes: [...SLACK_DEFAULT_BOT_SCOPES],
      },
    }).returning();
    const manifest = buildSlackAppManifest({
      app: { appName: "maya-paperclip", botName: "maya", command: "/maya" },
      agentName: "Maya",
      webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
    });
    await db.insert(chatSlackRegistrations).values({
      endpointId: endpoint.id, companyId: company.id, requestId: randomUUID(), status: "configured",
      manifest, manifestHash: slackInstallManifestHash(manifest),
      callbackUri: "https://paperclip.example/api/chat-slack/oauth/callback",
      appId: "ATEST", botUserId: "UBOT", workspaceId: "T1", createdByUserId: "user",
    });
    return { company, agent, connection, endpoint };
  }

  describeDb("database", () => {
    afterAll(async () => { await database?.cleanup(); });

    it("treats missing permission setup as stale even when every definition hash matches", async () => {
      const f = await fixture();
      await db!.transaction(tx => syncSlackBotTools(tx, f.endpoint, "user", true));
      expect(await slackBotCatalogIsCurrent(db!, f.endpoint)).toBe(true);
      const { setup: _omitted, ...withoutSetup } = f.endpoint;
      expect(await slackBotCatalogIsCurrent(db!, withoutSetup)).toBe(false);
    });

    it.each(["disabled", "quarantined"] as const)("preserves %s across repeated syncs without perpetual permission staleness", async status => {
      const f = await fixture();
      await db!.transaction(tx => syncSlackBotTools(tx, f.endpoint, "user", true));
      const withUpload = { ...f.endpoint, setup: { ...f.endpoint.setup,
        slackOptInScopeGroups: ["file_upload" as const], slackInstalledOptInScopeGroups: ["file_upload" as const] } };
      expect(await slackBotCatalogIsCurrent(db!, withUpload)).toBe(false);
      await db!.transaction(tx => syncSlackBotTools(tx, withUpload, "user", true));
      expect(await slackBotCatalogIsCurrent(db!, withUpload)).toBe(true);
      await db!.update(toolCatalogEntries).set({ status }).where(and(
        eq(toolCatalogEntries.connectionId, f.connection.id), eq(toolCatalogEntries.toolName, "slack_upload_file"),
      ));
      expect(await slackBotCatalogIsCurrent(db!, withUpload)).toBe(true);
      await db!.transaction(tx => syncSlackBotTools(tx, withUpload, "user", true));
      await db!.transaction(tx => syncSlackBotTools(tx, f.endpoint, "user", true));
      await db!.transaction(tx => syncSlackBotTools(tx, withUpload, "user", true));
      const [entry] = await db!.select().from(toolCatalogEntries).where(and(
        eq(toolCatalogEntries.connectionId, f.connection.id), eq(toolCatalogEntries.toolName, "slack_upload_file"),
      ));
      expect(entry!.status).toBe(status);
      expect(await slackBotCatalogIsCurrent(db!, withUpload)).toBe(true);
    });

    it("does not reactivate a quarantined gated tool on a definition refresh", async () => {
      const f = await fixture();
      const enabled = { ...f.endpoint, setup: { ...f.endpoint.setup,
        slackOptInScopeGroups: ["file_upload" as const], slackInstalledOptInScopeGroups: ["file_upload" as const] } };
      await db!.transaction(tx => syncSlackBotTools(tx, enabled, "user", true));
      await db!.update(toolCatalogEntries).set({ status: "quarantined", versionHash: "old-definition" }).where(and(
        eq(toolCatalogEntries.connectionId, f.connection.id), eq(toolCatalogEntries.toolName, "slack_upload_file"),
      ));
      await db!.transaction(tx => syncSlackBotTools(tx, enabled, "user", true));
      const [entry] = await db!.select().from(toolCatalogEntries).where(and(
        eq(toolCatalogEntries.connectionId, f.connection.id), eq(toolCatalogEntries.toolName, "slack_upload_file"),
      ));
      expect(entry!.status).toBe("quarantined");
      expect(entry!.versionHash).not.toBe("old-definition");
      expect(await slackBotCatalogIsCurrent(db!, enabled)).toBe(true);
    });

    it("writes only its own key, so a concurrent runtimeGeneration bump survives", async () => {
      const f = await fixture();
      // Simulate a concurrent writer bumping runtimeGeneration between read and write.
      const pending = recordInstalledSlackOptIns(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        grantedScopes: ["files:write"],
      });
      await db!.update(chatEndpoints)
        .set({ setup: sql`jsonb_set(${chatEndpoints.setup}, '{runtimeGeneration}', '9'::jsonb)` })
        .where(eq(chatEndpoints.id, f.endpoint.id));
      await pending;
      const [saved] = await db!.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
      expect(saved!.setup.slackInstalledOptInScopeGroups).toEqual(["file_upload"]);
      expect(saved!.setup.slackInstalledDefaultScopes).toEqual([]);
      expect((saved!.setup as { runtimeGeneration?: number }).runtimeGeneration).toBe(9);
    });

    it("clears the pending marker when the request returns to the installed set", async () => {
      const f = await fixture();
      const app = f.endpoint.setup.slackApp;
      // Request file_upload: it becomes pending.
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: { ...f.endpoint.setup, slackOptInScopeGroups: ["file_upload"] },
      });
      let [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");
      // Toggling it back to the installed set clears the pending state.
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: { ...f.endpoint.setup, slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] },
      });
      [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBeNull();
      expect(row!.status).toBe("configured");

      // Repeat apply with identical [] remains null
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: { ...f.endpoint.setup, slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] },
      });
      [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBeNull();
      expect(row!.status).toBe("configured");
    });

    it("keeps the personal-search redirect URL and user scopes in a pushed manifest without forcing a reinstall", async () => {
      const f = await fixture();
      const app = f.endpoint.setup.slackApp;
      const [before] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      const searchUri = new URL("/api/slack/search/callback", new URL(before!.callbackUri).origin).toString();
      // The stored manifest predates the search additions, like every already-installed app.
      const legacy = buildSlackAppManifest({
        app: app!, agentName: "Maya", webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
        redirectUri: before!.callbackUri,
      });
      await db!.update(chatSlackRegistrations).set({
        manifest: legacy, manifestHash: slackInstallManifestHash(legacy), status: "install", errorCode: null,
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      // A no-op opt-in edit must not mark the app as needing a repush.
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: { ...f.endpoint.setup, slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] },
      });
      let [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBeNull();

      // A real opt-in change pushes a manifest that still declares the search redirect URL.
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: { ...f.endpoint.setup, slackOptInScopeGroups: ["file_upload"] },
      });
      [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      const oauth = (row!.manifest as any).oauth_config;
      expect(oauth.redirect_urls).toEqual([before!.callbackUri, searchUri]);
      expect(oauth.scopes.user).toEqual(["search:read.public", "search:read.private", "search:read.files"]);
    });

    it("ignores the personal-search additions when hashing the install manifest", () => {
      const base = buildSlackAppManifest({ app: { appName: "a", botName: "b", command: "/b" } as any, agentName: "Maya", webhookUrl: "https://p.example/w", redirectUri: "https://p.example/api/chat-slack/oauth/callback" });
      const withSearch = buildSlackAppManifest({ app: { appName: "a", botName: "b", command: "/b" } as any, agentName: "Maya", webhookUrl: "https://p.example/w", redirectUri: "https://p.example/api/chat-slack/oauth/callback", searchRedirectUri: "https://p.example/api/slack/search/callback" });
      expect(slackInstallManifestHash(withSearch)).toBe(slackInstallManifestHash(base));
      const otherBotScopes = JSON.parse(JSON.stringify(withSearch));
      otherBotScopes.oauth_config.scopes.bot.push("extra:scope");
      expect(slackInstallManifestHash(otherBotScopes)).not.toBe(slackInstallManifestHash(base));
    });

    it("keeps errorCode pending on withdrawal when legacy install lacks default scopes snapshot", async () => {
      const f = await fixture();
      const app = f.endpoint.setup.slackApp;
      const legacySetup = {
        ...f.endpoint.setup,
        slackInstalledDefaultScopes: undefined,
        slackOptInScopeGroups: [],
        slackInstalledOptInScopeGroups: [],
      };
      const oldManifest = buildSlackAppManifest({
        app: app!,
        agentName: "Maya",
        webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
      });
      (oldManifest as any).oauth_config.scopes.bot = ["chat:write", "commands"];
      await db!.update(chatSlackRegistrations).set({
        manifest: oldManifest,
        manifestHash: slackInstallManifestHash(oldManifest),
        status: "configured",
        errorCode: null,
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      // 1. Toggle file_upload ON: becomes pending
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: { ...legacySetup, slackOptInScopeGroups: ["file_upload"] },
      });
      let [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");

      // 2. Toggle file_upload OFF (back to installed): withdrawal on legacy without snapshot stays pending!
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: legacySetup,
      });
      [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");
      const botScopes = (row!.manifest as any).oauth_config.scopes.bot;
      expect(botScopes).toContain("im:write");
      expect(botScopes).not.toContain("files:write");

      // Repeat apply with same [] keeps pending
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: legacySetup,
      });
      [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");

      // 3. ensureSlackManifestScopesCurrent leaves it pending
      await ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: legacySetup,
      });
      [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");
    });

    it("keeps errorCode pending on withdrawal when install has partial snapshot lacking im:write", async () => {
      const f = await fixture();
      const app = f.endpoint.setup.slackApp;
      const partialSnapshotSetup = {
        ...f.endpoint.setup,
        slackInstalledDefaultScopes: ["chat:write", "commands"],
        slackOptInScopeGroups: [],
        slackInstalledOptInScopeGroups: [],
      };
      const oldManifest = buildSlackAppManifest({
        app: app!,
        agentName: "Maya",
        webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
      });
      (oldManifest as any).oauth_config.scopes.bot = ["chat:write", "commands"];
      await db!.update(chatSlackRegistrations).set({
        manifest: oldManifest,
        manifestHash: slackInstallManifestHash(oldManifest),
        status: "configured",
        errorCode: null,
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      // Toggle file_upload ON then OFF
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: { ...partialSnapshotSetup, slackOptInScopeGroups: ["file_upload"] },
      });
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: partialSnapshotSetup,
      });
      let [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");

      // Repeat apply with same [] keeps pending
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: partialSnapshotSetup,
      });
      [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");

      // ensureSlackManifestScopesCurrent also leaves it pending
      await ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: partialSnapshotSetup,
      });
      [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");
    });

    it("records both installed opt-in groups and installed default scopes from real granted scopes", async () => {
      const f = await fixture();
      await recordInstalledSlackOptIns(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        grantedScopes: ["files:write", "chat:write", "im:write"],
      });
      const [saved] = await db!.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
      expect(saved!.setup.slackInstalledOptInScopeGroups).toEqual(["file_upload"]);
      expect(saved!.setup.slackInstalledDefaultScopes).toEqual(["chat:write", "im:write"]);
    });

    it("scopes its registration writes by company", async () => {
      const f = await fixture();
      const [other] = await db!.insert(companies).values({ name: `Other ${randomUUID()}`, issuePrefix: `OT${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: other!.id, agentName: "Maya",
        app: f.endpoint.setup.slackApp,
        setup: { ...f.endpoint.setup, slackOptInScopeGroups: ["file_upload"] },
      });
      const [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBeNull();
    });

    it("flips a gated tool between removed and active as the install changes", async () => {
      const f = await fixture();
      const statuses = async () => Object.fromEntries(
        (await db!.select({ name: toolCatalogEntries.name, status: toolCatalogEntries.status })
          .from(toolCatalogEntries)
          .where(eq(toolCatalogEntries.connectionId, f.connection.id)))
          .map((entry) => [entry.name.replace("slack_bot:", ""), entry.status]),
      );
      const [noOptIns] = await db!.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
      await db!.transaction((tx) => syncSlackBotTools(tx, noOptIns!, "user", true));
      expect((await statuses()).slack_upload_file).toBe("removed");

      // Requesting AND installing file_upload: the same definition hash must
      // still flip the entry to active.
      await db!.update(chatEndpoints).set({
        setup: sql`${chatEndpoints.setup} || ${JSON.stringify({
          slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: ["file_upload"],
        })}::jsonb`,
      }).where(eq(chatEndpoints.id, f.endpoint.id));
      const [withUpload] = await db!.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
      await db!.transaction((tx) => syncSlackBotTools(tx, withUpload!, "user", true));
      expect((await statuses()).slack_upload_file).toBe("active");

      // Removing the request disables it, even though Slack may still report
      // the scope on the installation.
      await db!.update(chatEndpoints).set({
        setup: sql`${chatEndpoints.setup} || ${JSON.stringify({
          slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: ["file_upload"],
        })}::jsonb`,
      }).where(eq(chatEndpoints.id, f.endpoint.id));
      const [cleared] = await db!.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
      await db!.transaction((tx) => syncSlackBotTools(tx, cleared!, "user", true));
      expect((await statuses()).slack_upload_file).toBe("removed");
    });

    it("keeps a legacy fieldless installation's gated tools active", async () => {
      const f = await fixture();
      // A legacy install is a connected bot on a row with neither opt-in field;
      // the endpoint fixture omits botExternalId, so set it here. The fields
      // must be absent, not empty: an empty request means "nothing enabled".
      await db!.update(chatEndpoints)
        .set({
          botExternalId: "ULEGACY",
          setup: sql`(${chatEndpoints.setup} - 'slackOptInScopeGroups') - 'slackInstalledOptInScopeGroups'`,
        })
        .where(eq(chatEndpoints.id, f.endpoint.id));
      const [legacy] = await db!.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
      expect(SLACK_OPT_IN_SCOPE_GROUPS).toHaveLength(2);
      await db!.transaction((tx) => syncSlackBotTools(tx, legacy!, "user", true));
      const [upload] = await db!.select({ status: toolCatalogEntries.status })
        .from(toolCatalogEntries)
        .where(and(
          eq(toolCatalogEntries.connectionId, f.connection.id),
          eq(toolCatalogEntries.name, "slack_bot:slack_upload_file"),
        ));
      expect(upload?.status).toBe("active");
    });

    it("quietly returns without throwing or writing when app configuration is invalid or missing", async () => {
      const f = await fixture();
      const [before] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      await expect(ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        agentName: "Maya",
        app: null,
        setup: f.endpoint.setup,
      })).resolves.toBeUndefined();
      await expect(ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        agentName: "Maya",
        app: { not_an_app: true },
        setup: f.endpoint.setup,
      })).resolves.toBeUndefined();
      const [after] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(after!.updatedAt).toEqual(before!.updatedAt);
    });

    it("marks permissions update pending and updates manifest with im:write when scopes drifted", async () => {
      const f = await fixture();
      // Simulate old manifest lacking im:write
      const oldManifest = buildSlackAppManifest({
        app: f.endpoint.setup.slackApp!,
        agentName: "Maya",
        webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
      });
      (oldManifest as any).oauth_config.scopes.bot = ["chat:write", "commands"];
      await db!.update(chatSlackRegistrations).set({
        manifest: oldManifest,
        manifestHash: slackInstallManifestHash(oldManifest),
        errorCode: null,
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      await ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        agentName: "Maya",
        app: f.endpoint.setup.slackApp,
        setup: f.endpoint.setup,
      });

      const [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");
      const botScopes = (row!.manifest as any).oauth_config.scopes.bot;
      expect(botScopes).toContain("im:write");
    });

    it("is idempotent when called a second time with current scopes", async () => {
      const f = await fixture();
      await ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        agentName: "Maya",
        app: f.endpoint.setup.slackApp,
        setup: f.endpoint.setup,
      });
      const [first] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      await ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        agentName: "Maya",
        app: f.endpoint.setup.slackApp,
        setup: f.endpoint.setup,
      });
      const [second] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(second!.updatedAt).toEqual(first!.updatedAt);
      expect(second!.manifestHash).toEqual(first!.manifestHash);
    });

    it("preserves slack_manifest_update_pending errorCode when refreshing scopes", async () => {
      const f = await fixture();
      const oldManifest = buildSlackAppManifest({
        app: f.endpoint.setup.slackApp!,
        agentName: "Maya",
        webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
      });
      (oldManifest as any).oauth_config.scopes.bot = ["chat:write", "commands"];
      await db!.update(chatSlackRegistrations).set({
        manifest: oldManifest,
        manifestHash: slackInstallManifestHash(oldManifest),
        errorCode: "slack_manifest_update_pending",
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      await ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        agentName: "Maya",
        app: f.endpoint.setup.slackApp,
        setup: f.endpoint.setup,
      });

      const [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_manifest_update_pending");
      const botScopes = (row!.manifest as any).oauth_config.scopes.bot;
      expect(botScopes).toContain("im:write");
    });

    it("pushes manifest with im:write in the same call when existing app has drifted scopes", async () => {
      const f = await fixture();
      const webhookUrl = `https://paperclip.example/api/chat-webhooks/${f.endpoint.publicId}/slack`;
      // Old manifest lacking im:write
      const oldManifest = buildSlackAppManifest({
        app: f.endpoint.setup.slackApp!,
        agentName: "Maya",
        webhookUrl,
      });
      (oldManifest as any).oauth_config.scopes.bot = ["chat:write", "commands"];
      await db!.update(chatEndpoints).set({
        setup: sql`jsonb_set(${chatEndpoints.setup}, '{slackSetupMethod}', '"automatic"'::jsonb)`,
      }).where(eq(chatEndpoints.id, f.endpoint.id));
      await db!.update(chatSlackRegistrations).set({
        manifest: oldManifest,
        manifestHash: slackInstallManifestHash(oldManifest),
        status: "configured",
        errorCode: null,
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      const apiCalls: Array<{ method: string; args: any }> = [];
      const fakeApi = vi.fn(async (method: string, args: any) => {
        apiCalls.push({ method, args });
        return { ok: true };
      });

      const { createCustomerOwnedSetup } = await import("./customer-owned.js");
      const { createSlackRegistrationStore } = await import("./registration.js");

      const store = createSlackRegistrationStore(db!, {
        publicOrigin: () => "https://paperclip.example",
        webhookOrigin: () => "https://paperclip.example",
        withLock: async (_endpointId, work) => work({ assertOwned: async () => undefined } as any),
        runtimeSigningSecret: async () => "signing-secret",
        runtimeBotToken: async () => "xoxb-bot",
        canWelcome: async () => true,
        linkInstaller: async () => undefined,
        configure: async () => undefined,
        fetch: fakeApi as any,
      });
      (store as any).api = fakeApi;

      const credentials = {
        accessToken: async () => "xoxe-access-token",
      } as any;

      const setup = createCustomerOwnedSetup(store, credentials);
      const actor = { userId: "user-1", sessionId: null, bypassPermissionCheck: true };

      await setup.create(f.endpoint.id, actor, {
        requestId: randomUUID(),
        credentials: { configurationToken: "xoxe-test-token" },
      });

      const updateCall = apiCalls.find(c => c.method === "apps.manifest.update");
      expect(updateCall).toBeDefined();
      const pushedManifest = JSON.parse(updateCall!.args.manifest);
      expect(pushedManifest.oauth_config.scopes.bot).toContain("im:write");

      const [updatedRow] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(updatedRow!.status).toBe("install");
      expect(updatedRow!.errorCode).toBeNull();
    });

    it("aborts manifest scope refresh and rolls back when lease is lost during create", async () => {
      const f = await fixture();
      const webhookUrl = `https://paperclip.example/api/chat-webhooks/${f.endpoint.publicId}/slack`;
      // Old manifest lacking im:write
      const oldManifest = buildSlackAppManifest({
        app: f.endpoint.setup.slackApp!,
        agentName: "Maya",
        webhookUrl,
      });
      (oldManifest as any).oauth_config.scopes.bot = ["chat:write", "commands"];
      const originalHash = slackInstallManifestHash(oldManifest);
      await db!.update(chatEndpoints).set({
        setup: sql`jsonb_set(${chatEndpoints.setup}, '{slackSetupMethod}', '"automatic"'::jsonb)`,
      }).where(eq(chatEndpoints.id, f.endpoint.id));
      await db!.update(chatSlackRegistrations).set({
        manifest: oldManifest,
        manifestHash: originalHash,
        status: "configured",
        errorCode: null,
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      const { createCustomerOwnedSetup } = await import("./customer-owned.js");
      const { createSlackRegistrationStore } = await import("./registration.js");

      const store = createSlackRegistrationStore(db!, {
        publicOrigin: () => "https://paperclip.example",
        webhookOrigin: () => "https://paperclip.example",
        withLock: async (_endpointId, work) =>
          work({
            assertOwned: async () => {
              throw new Error("lease lost");
            },
          } as any),
        runtimeSigningSecret: async () => "signing-secret",
        runtimeBotToken: async () => "xoxb-bot",
        canWelcome: async () => true,
        linkInstaller: async () => undefined,
        configure: async () => undefined,
        fetch: vi.fn() as any,
      });

      const credentials = {
        accessToken: async () => "xoxe-access-token",
      } as any;

      const setup = createCustomerOwnedSetup(store, credentials);
      const actor = { userId: "user-1", sessionId: null, bypassPermissionCheck: true };

      await expect(
        setup.create(f.endpoint.id, actor, {
          requestId: randomUUID(),
          credentials: { configurationToken: "xoxe-test-token" },
        }),
      ).rejects.toThrow("lease lost");

      const [row] = await db!
        .select()
        .from(chatSlackRegistrations)
        .where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      const botScopes = (row!.manifest as any).oauth_config.scopes.bot;
      expect(botScopes).not.toContain("im:write");
      expect(row!.errorCode).toBeNull();
      expect(row!.manifestHash).toBe(originalHash);
    });

    it("preserves legacy manifest opt-in scopes when refreshing an untouched legacy install lacking im:write", async () => {
      const f = await fixture();
      // Untouched legacy install: neither opt-in field present
      const untouchedSetup = {
        step: "complete" as const,
        slackSetupMethod: "managed" as const,
        slackApp: f.endpoint.setup.slackApp,
        slackOptInScopeGroups: undefined,
        slackInstalledOptInScopeGroups: undefined,
      };
      await db!.update(chatEndpoints).set({
        setup: sql`(${chatEndpoints.setup} - 'slackOptInScopeGroups') - 'slackInstalledOptInScopeGroups'`,
      }).where(eq(chatEndpoints.id, f.endpoint.id));

      // Existing legacy manifest had full grant scopes but lacked im:write
      const legacyScopesWithoutImWrite = [
        "channels:history",
        "chat:write",
        "channels:manage",
        "groups:write",
        "files:write",
      ];
      const legacyManifest = buildSlackAppManifest({
        app: f.endpoint.setup.slackApp!,
        agentName: "Maya",
        webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
      });
      (legacyManifest as any).oauth_config.scopes.bot = legacyScopesWithoutImWrite;
      await db!.update(chatSlackRegistrations).set({
        manifest: legacyManifest,
        manifestHash: slackInstallManifestHash(legacyManifest),
        errorCode: null,
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      await ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        agentName: "Maya",
        app: f.endpoint.setup.slackApp,
        setup: untouchedSetup,
      });

      const [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");
      const botScopes = (row!.manifest as any).oauth_config.scopes.bot;
      expect(botScopes).toContain("im:write");
      // Retains channel and file opt-in scopes!
      expect(botScopes).toContain("channels:manage");
      expect(botScopes).toContain("groups:write");
      expect(botScopes).toContain("files:write");
    });

    it("marks pending when pre-PR configured install has a no-op opt-in edit that adds im:write", async () => {
      const f = await fixture();
      // Pre-PR configured install without im:write and with null errorCode
      const oldManifest = buildSlackAppManifest({
        app: f.endpoint.setup.slackApp!,
        agentName: "Maya",
        webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
      });
      (oldManifest as any).oauth_config.scopes.bot = ["chat:write", "commands"];
      await db!.update(chatSlackRegistrations).set({
        manifest: oldManifest,
        manifestHash: slackInstallManifestHash(oldManifest),
        status: "configured",
        errorCode: null,
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      // No-op opt-in edit (requested matches installed)
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        agentName: "Maya",
        app: f.endpoint.setup.slackApp,
        setup: { ...f.endpoint.setup, slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] },
      });

      const [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");
      const botScopes = (row!.manifest as any).oauth_config.scopes.bot;
      expect(botScopes).toContain("im:write");
    });

    it("throws conflict when eventUrl is missing in ensureSlackManifestScopesCurrent", async () => {
      const f = await fixture();
      const brokenManifest = buildSlackAppManifest({
        app: f.endpoint.setup.slackApp!,
        agentName: "Maya",
        webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
      });
      delete (brokenManifest.settings as any).event_subscriptions;
      await db!.update(chatSlackRegistrations).set({
        manifest: brokenManifest,
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      await expect(ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        agentName: "Maya",
        app: f.endpoint.setup.slackApp,
        setup: f.endpoint.setup,
      })).rejects.toThrow("The saved Slack app manifest is unavailable. Resume Slack setup to update its permissions.");
    });

    it("throws conflict and logs a warning when app configuration fails schema parsing in ensureSlackManifestScopesCurrent", async () => {
      const f = await fixture();
      const oldManifest = buildSlackAppManifest({
        app: f.endpoint.setup.slackApp!,
        agentName: "Maya",
        webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
      });
      (oldManifest as any).oauth_config.scopes.bot = ["chat:write", "commands"];
      await db!.update(chatSlackRegistrations).set({
        manifest: oldManifest,
        manifestHash: slackInstallManifestHash(oldManifest),
        errorCode: null,
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      // Invalid app config
      await expect(ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        agentName: "Maya",
        app: { invalid: true },
        setup: f.endpoint.setup,
      })).rejects.toThrow("The saved Slack app configuration is unavailable. Resume Slack setup to update its permissions.");
    });

    it("preserves scopes from manifest when slackOptInScopeGroups is undefined even if installed groups is defined", async () => {
      const f = await fixture();
      // Setup has undefined slackOptInScopeGroups but defined slackInstalledOptInScopeGroups
      const setup = {
        ...f.endpoint.setup,
        slackOptInScopeGroups: undefined,
        slackInstalledOptInScopeGroups: [],
      };
      const manifestWithFile = buildSlackAppManifest({
        app: f.endpoint.setup.slackApp!,
        agentName: "Maya",
        webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
      });
      (manifestWithFile as any).oauth_config.scopes.bot = ["chat:write", "files:write"];
      await db!.update(chatSlackRegistrations).set({
        manifest: manifestWithFile,
        manifestHash: slackInstallManifestHash(manifestWithFile),
        errorCode: null,
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      await ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        agentName: "Maya",
        app: f.endpoint.setup.slackApp,
        setup,
      });

      const [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");
      const botScopes = (row!.manifest as any).oauth_config.scopes.bot;
      expect(botScopes).toContain("im:write");
      // Preserved files:write from manifest because slackOptInScopeGroups was undefined!
      expect(botScopes).toContain("files:write");
    });

    it("removes optional groups when explicitly requested as empty [] even if previous manifest had them", async () => {
      const f = await fixture();
      const explicitEmptySetup = {
        ...f.endpoint.setup,
        slackOptInScopeGroups: [],
        slackInstalledOptInScopeGroups: ["file_upload" as const],
      };
      // Manifest previously had file_upload scope
      const manifestWithFile = buildSlackAppManifest({
        app: f.endpoint.setup.slackApp!,
        agentName: "Maya",
        webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
      });
      (manifestWithFile as any).oauth_config.scopes.bot = ["chat:write", "files:write"];
      await db!.update(chatSlackRegistrations).set({
        manifest: manifestWithFile,
        manifestHash: slackInstallManifestHash(manifestWithFile),
        errorCode: null,
      }).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));

      await ensureSlackManifestScopesCurrent(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        agentName: "Maya",
        app: f.endpoint.setup.slackApp,
        setup: explicitEmptySetup,
      });

      const [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");
      const botScopes = (row!.manifest as any).oauth_config.scopes.bot;
      expect(botScopes).toContain("im:write");
      expect(botScopes).not.toContain("files:write");
    });
  });
});
