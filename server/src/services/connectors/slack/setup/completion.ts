import { and, eq, inArray, sql } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations } from "@paperclipai/db";
import { SLACK_CHAT_BOT_SCOPES, SLACK_BOT_TOOL_SCOPES, type SlackAccountState } from "@paperclipai/shared";
import { conflict, forbidden } from "../../../../errors.js";
import { logger } from "../../../../middleware/logger.js";
import { secretService } from "../../../secrets.js";
import type { CredentialMutationLeaseGuard } from "../../../chat-credential-mutation-lease.js";
import { object, providerFailure, type Registration, type SlackSetupActor, type SlackRegistrationStore } from "./registration.js";
export function createSlackCompletion(store: SlackRegistrationStore) {
  const { db, options, endpoint, registration, assertOrigins, api, readSecret, audit, setFailure } = store;
  const vault = secretService(db);
  async function saveAccount(row: Registration, account: SlackAccountState, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    await endpoint(row.endpointId, actor);
    await db.transaction(async tx => {
      await lease.assertOwned(tx);
      const saved = (await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, row.endpointId), eq(chatEndpoints.companyId, row.companyId))).for("update"))[0];
      const registrationNow = (await tx.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, row.endpointId)))[0];
      if (!saved || saved.status === "archived" || registrationNow?.status === "removed" || registrationNow?.requestId !== row.requestId) throw conflict("Slack setup changed");
      await tx.update(chatEndpoints).set({ setup: { ...saved.setup, slackAccount: account }, updatedAt: new Date() }).where(eq(chatEndpoints.id, row.endpointId));
      await lease.assertOwned(tx);
    });
  }
  async function linkAccount(row: Registration, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    const current = await endpoint(row.endpointId, actor);
    const account = current.endpoint.setup.slackAccount;
    if (!account) throw providerFailure("slack_install_account_missing");
    if (account.status === "linked") return;
    const token = row.secretIds.botToken ? await readSecret(row, "botToken") : await options.runtimeBotToken(row.endpointId);
    const user = object((await api("users.info", { user: account.externalUserId }, token)).user);
    if (user.id !== account.externalUserId || user.team_id !== row.workspaceId || user.is_bot !== false || user.is_app_user === true || user.deleted !== false) throw providerFailure("slack_install_account_missing");
    await endpoint(row.endpointId, actor);
    await options.linkInstaller(row.endpointId, user, { ...actor, userId: account.paperclipUserId }, lease);
    await saveAccount(row, { ...account, status: "linked" }, actor, lease);
    try { await audit(row, actor, "account_linked"); }
    catch { logger.warn({ endpointId: row.endpointId, appId: row.appId }, "Slack account activity could not be recorded"); }
  }
  async function sendSetupMessage(row: Registration, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard, kind: "welcome" | "verification") {
    const current = await endpoint(row.endpointId, actor);
    const account = current.endpoint.setup.slackAccount;
    if (!account || account.status !== "linked") return;
    if (kind === "verification" && (!current.endpoint.setup.webhookVerifiedAt || ["pending", "sending"].includes(account.welcomeStatus))) return;
    const field = kind === "welcome" ? "welcomeStatus" : "verificationStatus";
    const status = account[field] ?? "pending";
    if (status === "sending") {
      await saveAccount(row, { ...account, [field]: "uncertain" }, actor, lease);
      return; // Never replay an ambiguous dispatch after a process restart.
    }
    if (status !== "pending") return;
    await saveAccount(row, { ...account, [field]: "sending" }, actor, lease);
    let result: SlackAccountState;
    try {
      await endpoint(row.endpointId, actor);
      await lease.assertOwned();
      if (!await options.canWelcome(row.endpointId, account)) throw forbidden("Slack account access changed");
      const sent = await api("chat.postMessage", { channel: account.dmChannelId ?? account.externalUserId,
        text: kind === "verification" ? "Your Slack connection is working! Now ask me a question about your Paperclip instance."
          : `Hi, I’m ${current.agentName}. Your Slack account is connected to Paperclip.`,
        unfurl_links: "false", unfurl_media: "false" }, await options.runtimeBotToken(row.endpointId));
      if (typeof sent.channel !== "string" || !/^D[A-Z0-9]+$/.test(sent.channel)) throw new Error("Incomplete message response");
      result = { ...account, [field]: "sent", dmChannelId: sent.channel };
    } catch (error) {
      result = { ...account, [field]: error instanceof Error && "status" in error ? "failed" : "uncertain" };
    }
    await saveAccount(row, result, actor, lease);
    try { await audit(row, actor, `${kind}_${result[field] === "sent" ? "sent" : "failed"}`); }
    catch { logger.warn({ endpointId: row.endpointId, appId: row.appId }, "Slack setup message activity could not be recorded"); }
  }
  async function welcome(row: Registration, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    await sendSetupMessage(row, actor, lease, "welcome");
    await sendSetupMessage(row, actor, lease, "verification");
  }
  async function notifyVerified(endpointId: string) {
    return options.withLock(endpointId, async lease => {
      const row = await registration(endpointId);
      if (!row || row.status !== "configured") return;
      const [saved] = await db.select({ setup: chatEndpoints.setup, status: chatEndpoints.status }).from(chatEndpoints).where(eq(chatEndpoints.id, endpointId));
      const account = saved?.setup.slackAccount;
      if (!account || !["verifying", "active"].includes(saved.status)) return;
      await sendSetupMessage(row, { userId: account.paperclipUserId, sessionId: null, bypassPermissionCheck: false }, lease, "verification");
    });
  }
  async function processPendingVerificationMessages(limit = 25) {
    const pending = await db.select({ endpointId: chatEndpoints.id }).from(chatEndpoints)
      .innerJoin(chatSlackRegistrations, and(eq(chatSlackRegistrations.endpointId, chatEndpoints.id), eq(chatSlackRegistrations.companyId, chatEndpoints.companyId)))
      .where(and(eq(chatSlackRegistrations.status, "configured"), inArray(chatEndpoints.status, ["verifying", "active"]),
        sql`${chatEndpoints.setup}->'slackAccount'->>'verificationStatus' in ('pending', 'sending')`)).limit(limit);
    for (const row of pending) {
      try { await notifyVerified(row.endpointId); }
      catch { logger.warn({ endpointId: row.endpointId }, "Slack verification message could not be processed"); }
    }
  }
  async function resumeLocked(endpointId: string, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    const current = await endpoint(endpointId, actor);
    const row = await registration(endpointId);
    if (!row || row.status === "removed") throw conflict("Slack registration is unavailable");
    if (row.status === "configured") { await cleanupStaged(endpointId, lease); await welcome(row, actor, lease); return; }
    if (row.status !== "credentials_saved") throw conflict("Install this Slack app before connecting it");
    try {
      assertOrigins(row, current.endpoint.publicId);
      const botToken = await readSecret(row, "botToken");
      const auth = await api("auth.test", {}, botToken, row.managerGrantId ? [...SLACK_CHAT_BOT_SCOPES, ...SLACK_BOT_TOOL_SCOPES] : undefined);
      if (auth.team_id !== row.workspaceId || row.botUserId && auth.user_id !== row.botUserId || typeof auth.user_id !== "string" || !/^[UW][A-Z0-9]+$/.test(auth.user_id)) throw providerFailure("slack_install_identity_mismatch");
      if (row.managerGrantId) {
        if (typeof auth.bot_id !== "string" || !/^B[A-Z0-9]+$/.test(auth.bot_id)) throw providerFailure("slack_install_identity_mismatch");
        const bot = object((await api("bots.info", { bot: auth.bot_id }, botToken)).bot);
        if (bot.id !== auth.bot_id || bot.app_id !== row.appId || bot.user_id !== auth.user_id || bot.deleted !== false) throw providerFailure("slack_install_identity_mismatch");
      }
      if (!row.botUserId) {
        if (!row.managerGrantId) throw providerFailure("slack_install_identity_mismatch");
        await lease.assertOwned();
        await db.update(chatSlackRegistrations).set({ botUserId: auth.user_id }).where(eq(chatSlackRegistrations.endpointId, endpointId));
      }
      await options.configure(endpointId, { botToken, signingSecret: row.secretIds.signingSecret
        ? await readSecret(row, "signingSecret") : await options.runtimeSigningSecret(endpointId) }, actor, {
          assertOwned: async database => {
            await lease.assertOwned(database);
            await endpoint(endpointId, actor);
            assertOrigins(row, current.endpoint.publicId);
          },
        });
      await linkAccount(row, actor, lease);
    } catch (error) {
      const code = object(object(error).details).code;
      const safeCode = code === "slack_configuration_token_invalid" ? "slack_install_token_invalid" : code === "slack_install_account_missing" ? code : code === "chat_identity_link_conflict" || code === "chat_identity_already_linked" ? "slack_install_account_conflict" : code === "slack_install_identity_mismatch" || code === "chat_bot_identity_changed"
        ? "slack_install_identity_mismatch" : (code === "chat_provider_permissions_missing" || code === "slack_install_scopes_missing" || code === "slack_setup_permission_denied") ? "slack_install_scopes_missing"
        : code === "chat_bot_identity_in_use" ? "slack_bot_already_connected" : "slack_configuration_incomplete";
      await setFailure(row, "credentials_saved", safeCode, lease);
      await audit(row, actor, "configuration_failed", safeCode);
      return;
    }
    await lease.assertOwned();
    await db.update(chatSlackRegistrations).set({ status: "configured", errorCode: null, updatedAt: new Date() }).where(eq(chatSlackRegistrations.endpointId, endpointId));
    // Runtime now owns a separate vaulted copy. Keep the registration IDs until
    // deletion succeeds so cleanup itself is retryable.
    await cleanupStaged(endpointId, lease);
    try { await audit(row, actor, "installation_completed"); }
    catch { logger.warn({ endpointId, appId: row.appId }, "Slack installation activity could not be recorded"); }
    await welcome(row, actor, lease);
  }
  async function cleanupStaged(endpointId: string, lease: CredentialMutationLeaseGuard) {
    const row = await registration(endpointId);
    if (!row || row.status !== "configured") return;
    const ids = { ...row.secretIds };
    for (const key of ["botToken", "signingSecret"]) {
      if (ids[key]) { await lease.assertOwned(); await vault.remove(ids[key]); delete ids[key]; }
    }
    await lease.assertOwned();
    await db.update(chatSlackRegistrations).set({ secretIds: ids }).where(eq(chatSlackRegistrations.endpointId, endpointId));
  }
  return { resumeLocked, notifyVerified, processPendingVerificationMessages };
}
