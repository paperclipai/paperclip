import { and, eq } from "drizzle-orm";
import { chatSlackRegistrations } from "@paperclipai/db";
import { isProvisionedSlackSetup, resolveAgentAppearance, buildSlackAppManifest, slackSearchRedirectUri, isSlackManifestUpdatePending, slackAppConfigurationSchema, slackRequestedOptInGroups, type SlackRegistrationInput, type SlackAvatarState } from "@paperclipai/shared";
import { conflict } from "../../../../errors.js";
import { logger } from "../../../../middleware/logger.js";
import type { CredentialMutationLeaseGuard } from "../../../chat-credential-mutation-lease.js";
import { object, knownProviderErrors, providerFailure, type Registration, type SlackSetupActor, type SlackRegistrationStore } from "./registration.js";
import type { SlackConfigurationCredentials } from "./configuration-credentials.js";
import { ensureSlackManifestScopesCurrent, slackInstallManifestHash } from "./opt-in-manifest.js";

/** Resolve once, lazily: an early return must never trigger a rotation. */
function once<T>(resolve: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= resolve());
}

export function createCustomerOwnedSetup(store: SlackRegistrationStore, credentials: SlackConfigurationCredentials) {
  const { db, options, endpoint, registration, callbackUri, origin, api, audit, saveSecrets, setFailure, saveAvatar, assertOrigins, renderAvatar } = store;
  async function create(endpointId: string, actor: SlackSetupActor, input: SlackRegistrationInput, managed?: { grantId: string; workspaceId: string; request: typeof api }) {
    return options.withLock(endpointId, async lease => {
      const api = managed?.request ?? store.api;
      const current = await endpoint(endpointId, actor);
      const previous = await registration(endpointId);
      // TECH-7981: a saved credential rotates only where a token is actually
      // needed -- never on the already-created / same-request / uncertain paths.
      const token = once(() => "configurationToken" in input.credentials
        ? Promise.resolve(input.credentials.configurationToken)
        : credentials.accessToken(input.credentials.configurationCredentialId, current.endpoint.companyId, actor));
      const method = managed ? "managed" : "automatic";
      if (current.endpoint.setup.slackSetupMethod !== method) throw conflict("Resume the selected Slack setup method");
      if (previous && previous.managerGrantId !== (managed?.grantId ?? null)) throw conflict("Resume setup with the original Slack workspace");
      if (previous?.status === "removed") throw conflict("This registration was removed. Continue the selected manual setup.");
      let activeRegistration = previous;
      if (previous?.appId && isProvisionedSlackSetup(current.endpoint.setup.slackSetupMethod)) {
        await db.transaction(async (tx) => {
          await lease.assertOwned(tx);
          await ensureSlackManifestScopesCurrent(tx, {
            endpointId,
            companyId: current.endpoint.companyId,
            agentName: current.agentName,
            app: current.endpoint.setup.slackApp,
            setup: current.endpoint.setup,
          });
        });
        activeRegistration = (await registration(endpointId)) ?? previous;
      }
      if (activeRegistration?.appId) {
        if (isSlackManifestUpdatePending(activeRegistration.errorCode)) {
          const configurationToken = await token();
          if (!await configureManifest(activeRegistration, actor, configurationToken, lease, method, api)) return;
          if (current.endpoint.setup.slackAvatar?.status !== "uploaded") await configureAvatar(activeRegistration, actor, configurationToken, lease, api);
        }
        return;
      }
      if (previous?.requestId === input.requestId) return;
      if (previous && ["creating", "uncertain"].includes(previous.status) && !input.confirmedNoAppCreated) {
        await setFailure(previous, "uncertain", "slack_creation_uncertain", lease);
        return;
      }
      if (current.endpoint.status !== "draft" || current.endpoint.botExternalId || current.endpoint.setup.slackSetupMethod !== method)
        throw conflict("Automatic creation is only available for a new Slack connection");
      const app = slackAppConfigurationSchema.parse(current.endpoint.setup.slackApp);
      const redirect = callbackUri();
      const manifest = buildSlackAppManifest({ app, agentName: current.agentName,
        webhookUrl: `${origin(options.webhookOrigin())}/api/chat-webhooks/${current.endpoint.publicId}/slack`, redirectUri: redirect, searchRedirectUri: slackSearchRedirectUri(redirect),
        optInScopeGroups: slackRequestedOptInGroups(current.endpoint.setup) });
      // Slack cannot authenticate a challenge until its creation response gives us
      // the signing secret. Add event subscriptions only after that secret is durable.
      const { event_subscriptions: _events, ...creationSettings } = manifest.settings;
      const creationManifest = { ...manifest, settings: creationSettings };
      // Resolve the token before the intent row exists, so a provider or
      // credential failure leaves no misleading `creating` registration.
      const configurationToken = await token();
      try { await api("apps.manifest.validate", { manifest: JSON.stringify(manifest) }, configurationToken); }
      catch (error) {
        if (error instanceof Error && "status" in error) throw error;
        throw providerFailure("slack_provider_failure");
      }
      // No provider creation has happened until this intent is durable.
      await endpoint(endpointId, actor);
      await lease.assertOwned();
      const values = { companyId: current.endpoint.companyId, requestId: input.requestId, status: "creating" as const,
        manifest, manifestHash: slackInstallManifestHash(manifest), callbackUri: redirect,
        createdByUserId: actor.userId, managerGrantId: managed?.grantId ?? null, workspaceId: managed?.workspaceId ?? null, errorCode: null, updatedAt: new Date() };
      const [row] = await db.insert(chatSlackRegistrations).values({ endpointId, ...values })
        .onConflictDoUpdate({ target: chatSlackRegistrations.endpointId, set: values }).returning();
      await audit(row, actor, "creation_started", undefined,
        "configurationCredentialId" in input.credentials ? { configurationCredentialId: input.credentials.configurationCredentialId } : undefined);
      let createdAppId: string;
      try {
        const result = await api("apps.manifest.create", { manifest: JSON.stringify(creationManifest) }, configurationToken);
        const credentials = object(result.credentials);
        if (typeof result.app_id !== "string" || !/^A[A-Z0-9]+$/.test(result.app_id)
          || typeof credentials.client_id !== "string" || !/^\d+\.\d+$/.test(credentials.client_id)
          || typeof credentials.client_secret !== "string" || !credentials.client_secret
          || typeof credentials.signing_secret !== "string" || !credentials.signing_secret)
          throw new Error("Incomplete Slack creation response");
        if (managed && result.team_id !== managed.workspaceId) throw new Error("Slack creation workspace mismatch");
        await endpoint(endpointId, actor);
        await saveSecrets(row, { signingSecret: credentials.signing_secret, clientSecret: credentials.client_secret }, actor, lease,
          { appId: result.app_id, clientId: credentials.client_id, status: "install", errorCode: "slack_manifest_update_pending" });
        createdAppId = result.app_id;
      } catch (error) {
        // Only documented rejection responses prove that creation did not happen.
        const code = object(object(error).details).code;
        const rejected = typeof code === "string" && [...Object.values(knownProviderErrors), "slack_manager_reauthorize"].includes(code);
        await setFailure(row, rejected ? "failed" : "uncertain", rejected ? code : "slack_creation_uncertain", lease);
        await audit(row, actor, "creation_failed", rejected ? code : "slack_creation_uncertain");
        return;
      }
      // The app and credentials are durable before optional icon provisioning.
      // A retry/restart always reuses this app, even if icon upload is interrupted.
      const created = { ...row, appId: createdAppId };
      if (!await configureManifest(created, actor, configurationToken, lease, method, api)) return;
      await configureAvatar(created, actor, configurationToken, lease, api);
      // An audit outage cannot change the saved creation outcome.
      try { await audit({ ...row, appId: createdAppId }, actor, "app_created"); }
      catch { logger.warn({ endpointId, appId: createdAppId }, "Slack app creation activity could not be recorded"); }
    });
  }
  async function configureAvatar(row: Registration, actor: SlackSetupActor, configurationToken: string, lease: CredentialMutationLeaseGuard, api = store.api) {
    const current = await endpoint(row.endpointId, actor);
    await saveAvatar(row, { status: "pending" }, actor, lease);
    let avatar: SlackAvatarState;
    try {
      await endpoint(row.endpointId, actor);
      await lease.assertOwned();
      // Cloud ingress requires a tenant session. Send the preset PNG bytes so
      // Slack does not need to fetch an authenticated Paperclip URL.
      const render = renderAvatar;
      const appearance = { ...resolveAgentAppearance(current.agentAppearance, current.endpoint.assignedAgentId) };
      delete appearance.customAvatarAssetId; // The preset renderer cannot read private uploaded assets.
      const png = await render({ appearance,
        size: 512, scale: 1, pose: "rest", muted: false, background: "paperclip-dark" });
      await endpoint(row.endpointId, actor);
      await lease.assertOwned();
      const upload = new FormData();
      upload.set("app_id", row.appId!);
      upload.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "agent-avatar.png");
      await api("apps.icon.set", upload, configurationToken);
      avatar = { status: "uploaded", uploadedAt: new Date().toISOString() };
    } catch {
      // Provider echoes (including tokens) never become saved state or activity.
      avatar = { status: "failed", errorCode: "slack_avatar_upload_failed" };
    }
    await saveAvatar(row, avatar, actor, lease);
    try { await audit(row, actor, avatar.status === "uploaded" ? "avatar_uploaded" : "avatar_upload_failed", avatar.status === "failed" ? avatar.errorCode : undefined); }
    catch { logger.warn({ endpointId: row.endpointId, appId: row.appId! }, "Slack avatar activity could not be recorded"); }
  }
  async function configureManifest(row: Registration, actor: SlackSetupActor, configurationToken: string, lease: CredentialMutationLeaseGuard, method: "automatic" | "managed" = "automatic", api = store.api) {
    const current = await endpoint(row.endpointId, actor);
    // A draft configures its app for the first time. An installed app only
    // reaches this path through an explicit pending manifest update (TECH-7988
    // opt-in change), which mutates only the scopes of the same app. The origin
    // check below still fences every callback URL.
    const pendingUpdate = isSlackManifestUpdatePending(row.errorCode);
    if ((current.endpoint.status !== "draft" && !pendingUpdate) || current.endpoint.setup.slackSetupMethod !== method)
      throw conflict("Resume the saved Slack connection before configuring its app");
    assertOrigins(row, current.endpoint.publicId);
    await lease.assertOwned();
    try {
      await api("apps.manifest.update", { app_id: row.appId!, manifest: JSON.stringify(row.manifest) }, configurationToken);
    } catch {
      // The pending marker was saved with the app secrets before dispatch. Retrying
      // the same manifest is safe even when Slack's response was lost.
      await audit(row, actor, "manifest_update_failed", row.errorCode ?? "slack_manifest_update_pending");
      return false;
    }
    await endpoint(row.endpointId, actor);
    // A changed scope set is not live until Slack is asked to install again.
    // `install` re-requests this manifest's scopes and the prior grant stays
    // recorded (see `slackOptInGroupsForSetup`) until that install completes.
    //
    // The manifest call above is external and can be slow, so re-check under a
    // row lock before committing: the lease must still be ours, and the
    // registration must still be the one whose manifest was just sent. A
    // removed registration, or one rewritten by a newer permission change,
    // keeps its own state instead of becoming installable for a stale manifest.
    const applied = await db.transaction(async tx => {
      await lease.assertOwned(tx);
      const [latest] = await tx.select().from(chatSlackRegistrations)
        .where(eq(chatSlackRegistrations.endpointId, row.endpointId)).for("update");
      if (!latest || latest.requestId !== row.requestId || latest.status === "removed"
        || latest.manifestHash !== row.manifestHash || !isSlackManifestUpdatePending(latest.errorCode)) return false;
      await tx.update(chatSlackRegistrations).set({ status: "install", errorCode: null, updatedAt: new Date() })
        .where(and(eq(chatSlackRegistrations.endpointId, row.endpointId), eq(chatSlackRegistrations.requestId, row.requestId)));
      await lease.assertOwned(tx);
      return true;
    });
    if (!applied) {
      await audit(row, actor, "manifest_update_superseded", row.errorCode ?? "slack_manifest_update_pending");
      return false;
    }
    await audit(row, actor, "manifest_updated");
    return true;
  }
  return { create, configureManifest };
}
