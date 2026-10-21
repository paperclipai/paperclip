import { and, eq } from "drizzle-orm";
import { chatActions, chatSlackRegistrations } from "@paperclipai/db";
import { type SlackManagedProvisionInput, type SlackManagedResult } from "@paperclipai/shared";
import { conflict } from "../../../../errors.js";
import type { createCustomerOwnedSetup } from "./customer-owned.js";
import type { createSlackManagerGrants } from "./manager-grants.js";
import type { createSlackCompletion } from "./completion.js";
import { object, providerFailure, type SlackRegistrationStore, type SlackSetupActor } from "./registration.js";

/** Managed provisioning ends at the same saved-credential boundary as child OAuth. */
export function createManagedSlackSetup(store: SlackRegistrationStore, grants: ReturnType<typeof createSlackManagerGrants>,
  provisioner: ReturnType<typeof createCustomerOwnedSetup>, completion: ReturnType<typeof createSlackCompletion>,
  installFallback: (endpointId: string, actor: SlackSetupActor) => Promise<{ authorizationUrl: string; expiresAt: string }>) {
  async function provision(endpointId: string, actor: SlackSetupActor, input: SlackManagedProvisionInput): Promise<SlackManagedResult> {
    const current = await store.endpoint(endpointId, actor);
    if (current.endpoint.setup.slackSetupMethod !== "managed") throw conflict("Resume the selected Slack setup method");
    const authorized = await grants.token(input.grantId, current.endpoint.companyId, actor);
    await provisioner.create(endpointId, actor, { requestId: input.requestId, confirmedNoAppCreated: input.confirmedNoAppCreated,
      credentials: { configurationToken: authorized.token } }, { grantId: authorized.grant.id, workspaceId: authorized.grant.workspaceId, request: (method, fields) => grants.request(input.grantId, current.endpoint.companyId, actor, method, fields) });
    let fallback = false;
    await store.options.withLock(endpointId, async lease => {
      const latest = await store.endpoint(endpointId, actor);
      const row = await store.registration(endpointId);
      if (!row?.appId || row.status === "removed" || row.errorCode === "slack_manifest_update_pending") return;
      if (row.managerGrantId !== authorized.grant.id || latest.endpoint.setup.slackSetupMethod !== "managed") throw conflict("Slack setup changed");
      store.assertOrigins(row, latest.endpoint.publicId);
      const reconnectKey = input.reconnect ? `slack_managed_reconnect:${actor.userId}:${input.requestId}` : null;
      const [previous] = reconnectKey ? await store.db.select().from(chatActions).where(and(eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, endpointId), eq(chatActions.providerActionId, reconnectKey))) : [];
      async function completeSaved() {
        await completion.resumeLocked(endpointId, actor, lease);
        if (reconnectKey && (await store.registration(endpointId))?.status === "configured") {
          await lease.assertOwned();
          await store.db.update(chatActions).set({ status: "processed", updatedAt: new Date() }).where(and(eq(chatActions.companyId, row!.companyId), eq(chatActions.endpointId, endpointId), eq(chatActions.providerActionId, reconnectKey)));
        }
      }
      if (previous && row.status === "configured" && !["revoked", "attention"].includes(latest.endpoint.status)) {
        await completeSaved(); return;
      }
      const needsReinstall = row.status === "configured" && (input.reconnect || ["revoked", "attention"].includes(latest.endpoint.status))
        || row.status === "credentials_saved" && ["slack_install_token_invalid", "slack_install_scopes_missing"].includes(row.errorCode ?? "");
      if (reconnectKey && !previous) {
        // Atomically bind an explicit reconnect to its durable installation intent.
        // Duplicate requests can return the saved connection without reinstalling.
        await store.db.transaction(async tx => {
          await lease.assertOwned(tx);
          await tx.insert(chatActions).values({ companyId: row.companyId, endpointId, kind: "slack_managed_reconnect", providerActionId: reconnectKey, status: "processing", payload: { grantId: row.managerGrantId, registrationRequestId: row.requestId } });
          if (needsReinstall) await tx.update(chatSlackRegistrations).set({ status: "install", errorCode: row.errorCode ?? "slack_install_failed", updatedAt: new Date() }).where(eq(chatSlackRegistrations.endpointId, endpointId));
        });
      }
      if ((row.status === "configured" || row.status === "credentials_saved") && !needsReinstall) {
        await completeSaved();
        return;
      }
      // Keep reinstall intent durable even if this dispatch fails or the process exits.
      if (needsReinstall && (!reconnectKey || previous)) await store.setFailure(row, "install", row.errorCode ?? "slack_install_failed", lease);
      const { grant } = await grants.token(input.grantId, row.companyId, actor);
      try {
        await lease.assertOwned();
        const result = await grants.request(grant.id, row.companyId, actor, "apps.managedInstall", { app_id: row.appId, team_id: grant.workspaceId });
        const botToken = object(result.api_access_tokens).bot_access_token;
        if (result.app_id !== row.appId || result.team_id !== grant.workspaceId || typeof botToken !== "string" || !botToken.startsWith("xoxb-")) throw providerFailure("slack_install_identity_mismatch");
        if ((await grants.get(grant.id, row.companyId, actor)).status !== "active") throw providerFailure("slack_manager_reauthorize");
        await store.endpoint(endpointId, actor);
        // Vault before auth.test/inventory so network failures never lose this installation.
        await store.saveSecrets(row, { botToken }, actor, lease, { status: "credentials_saved", workspaceId: grant.workspaceId, errorCode: null },
          { externalUserId: grant.slackUserId, paperclipUserId: actor.userId, status: "pending", welcomeStatus: "pending" });
      } catch (error) {
        const code = object(object(error).details).code;
        const safe = typeof code === "string" ? code : "slack_install_failed";
        await store.setFailure(row, needsReinstall ? "install" : row.status, safe, lease);
        await store.audit(row, actor, "installation_failed", safe);
        fallback = ["slack_approval_required", "slack_approval_pending", "slack_approval_denied"].includes(safe);
        return;
      }
      await completeSaved();
    });
    // OAuth's state/actor binding is ours; never trust a provider-supplied redirect.
    return fallback ? { authorization: await installFallback(endpointId, actor) } : {};
  }
  return { provision };
}
