import { z } from "zod";
import {
  SLACK_DEFAULT_BOT_SCOPES,
  SLACK_SEARCH_USER_SCOPES,
  slackBotScopes,
  type SlackOptInScopeGroup,
} from "./slack-scopes.js";
import type { SlackAppConfiguration } from "./types/chat-channels.js";

/**
 * The minimum bot scopes a manually created or existing app must hold for chat
 * to work at all. Unchanged from before TECH-7988 except `files:write`, which is
 * now the opt-in file-upload group. `im:write` must NOT be added here: existing
 * apps installed before TECH-8783 lacking `im:write` must remain reconnectable
 * rather than failing credential validation. Tool-only scopes (pins, bookmarks,
 * canvases, lists, ...) stay optional for those apps and are reported as missing
 * on the connection's capabilities instead of blocking reconnect. A strict
 * subset of `SLACK_DEFAULT_BOT_SCOPES`.
 */
export const SLACK_CHAT_BOT_SCOPES = [
  "app_mentions:read", "assistant:write", "channels:history", "channels:read",
  "chat:write", "commands", "files:read", "groups:history",
  "groups:read", "im:history", "im:read", "mpim:history", "mpim:read",
  "reactions:read", "reactions:write", "users:read",
] as const satisfies readonly (typeof SLACK_DEFAULT_BOT_SCOPES)[number][];

function slackNameSlug(name: string): string {
  return name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24)
    .replace(/^-+|-+$/g, "");
}

/**
 * The starting Slack app details. Without a company name the app is named after the agent, as before. With one, the
 * app and its bot are named after the company (the app name as written, up to Slack's 35 characters; the bot display
 * name as the lowercase slug Slack requires), while the slash command still comes from the agent so two agents in
 * one company never claim the same command.
 */
export function defaultSlackAppConfiguration(agentName: string, companyName?: string): SlackAppConfiguration {
  const agentSlug = slackNameSlug(agentName) || "paperclip-agent";
  const command = `/${agentSlug.replace(/[._]+/g, "-")}`;
  const company = companyName?.trim();
  const companySlug = company ? slackNameSlug(company) : "";
  if (!company || !companySlug) return { appName: `${agentSlug}-paperclip`, botName: agentSlug, command };
  // The schema counts UTF-16 units, so cut on whole characters until 35 units are used: an emoji at the boundary
  // is dropped rather than split into a lone surrogate or pushed past the limit.
  let appName = "";
  for (const character of company) {
    if (appName.length + character.length > 35) break;
    appName += character;
  }
  return { appName: appName.trim(), botName: companySlug, command };
}

export function buildSlackAppManifest(input: {
  app: SlackAppConfiguration;
  agentName: string;
  webhookUrl: string;
  redirectUri?: string;
  /**
   * Personal-search OAuth redirect URL. Slack replaces the whole redirect_urls
   * array on a manifest update, so it must be declared here or an update drops it.
   */
  searchRedirectUri?: string;
  /** Per-agent opt-ins. Off by default; each enabled group adds its scopes. */
  optInScopeGroups?: readonly SlackOptInScopeGroup[];
}) {
  return {
    display_information: { name: input.app.appName, description: `Talk to ${input.agentName} and manage work in Paperclip.`.slice(0, 140) },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      agent_view: { agent_description: "Work with a Paperclip agent in a task-backed conversation." },
      bot_user: { display_name: input.app.botName },
      slash_commands: [{ command: input.app.command, description: `Start or manage work with ${input.agentName}`,
        usage_hint: "status | new | close | <task>", should_escape: false, url: input.webhookUrl }],
    },
    oauth_config: {
      scopes: {
        bot: slackBotScopes(input.optInScopeGroups),
        ...(input.searchRedirectUri ? { user: [...SLACK_SEARCH_USER_SCOPES] } : {}),
      },
      ...(input.redirectUri || input.searchRedirectUri
        ? { redirect_urls: [...new Set([input.redirectUri, input.searchRedirectUri].filter((url): url is string => !!url))] }
        : {}),
    },
    settings: {
      org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false,
      event_subscriptions: {
        request_url: input.webhookUrl,
        bot_events: ["agent_session_stopped", "app_mention", "message.channels", "message.groups", "message.im", "message.mpim",
          "member_joined_channel", "member_left_channel", "channel_left", "group_left", "reaction_added", "reaction_removed",
          "channel_archive", "group_archive", "channel_unarchive", "group_unarchive", "channel_deleted", "channel_rename",
          "group_rename", "app_uninstalled", "tokens_revoked"],
      },
      interactivity: { is_enabled: true, request_url: input.webhookUrl },
    },
  };
}

export const slackRegistrationSchema = z.object({
  requestId: z.string().uuid(),
  // Two mutually exclusive, strictly validated sources. The refresh token never
  // travels here: it is saved separately (see slackConfigurationCredentialSaveSchema).
  credentials: z.union([
    z.object({ configurationToken: z.string().trim().min(1).max(4096) }).strict(),
    z.object({ configurationCredentialId: z.string().uuid() }).strict(),
  ]),
  confirmedNoAppCreated: z.boolean().optional(),
}).strict();
export type SlackRegistrationInput = z.infer<typeof slackRegistrationSchema>;
export const slackRegistrationStatusSchema = z.enum(["creating", "uncertain", "failed", "install", "credentials_saved", "configured", "removed"]);
export type SlackRegistrationStatus = z.infer<typeof slackRegistrationStatusSchema>;
export const slackRegistrationStateSchema = z.object({
  status: slackRegistrationStatusSchema,
  appId: z.string().nullable().optional(),
  managementUrl: z.string().url().nullable().optional(),
  managerGrantId: z.string().uuid().nullable().optional(),
  errorCode: z.string().nullable().optional(),
}).strict();
export type SlackRegistrationState = z.infer<typeof slackRegistrationStateSchema>;
export const slackAvatarStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("uploaded"), uploadedAt: z.string().datetime() }).strict(),
  z.object({ status: z.literal("failed"), errorCode: z.literal("slack_avatar_upload_failed") }).strict(),
]);
export type SlackAvatarState = z.infer<typeof slackAvatarStateSchema>;
export const slackAccountStateSchema = z.object({
  externalUserId: z.string().regex(/^[UW][A-Z0-9]+$/),
  paperclipUserId: z.string().min(1),
  status: z.enum(["pending", "linked"]),
  welcomeStatus: z.enum(["pending", "sending", "sent", "failed", "uncertain"]),
  verificationStatus: z.enum(["pending", "sending", "sent", "failed", "uncertain"]).optional(),
  dmChannelId: z.string().regex(/^D[A-Z0-9]+$/).optional(),
}).strict();
export type SlackAccountState = z.infer<typeof slackAccountStateSchema>;
export const slackInstallAuthorizationSchema = z.object({ authorizationUrl: z.string().url(), expiresAt: z.string().datetime() });
export const slackManagerAuthorizationSchema = slackInstallAuthorizationSchema.extend({ handoff: z.object({ kind: z.literal("paperclip_cloud"), session: z.string().min(16).max(512) }).optional() });
export type SlackManagerAuthorization = z.infer<typeof slackManagerAuthorizationSchema>;
export type SlackInstallAuthorization = z.infer<typeof slackInstallAuthorizationSchema>;
export const slackSetupActionSchema = z.object({}).strict();

export const slackTestMessageSchema = z.object({
  requestId: z.string().uuid(),
  slackUserId: z.string().regex(/^[UW][A-Z0-9]+$/).optional(),
  accountCursor: z.string().min(1).max(512).optional(),
}).strict();
export type SlackTestMessageInput = z.infer<typeof slackTestMessageSchema>;
export const slackTestMessageResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("sent"), slackUrl: z.string().url() }).strict(),
  z.object({ status: z.literal("connection_required"), accounts: z.array(z.object({
    id: z.string(), name: z.string(),
  }).strict()), nextCursor: z.string().nullable() }).strict(),
  z.object({ status: z.literal("connection_pending"), principalId: z.string().uuid(), expiresAt: z.string().datetime() }).strict(),
]);
export type SlackTestMessageResult = z.infer<typeof slackTestMessageResultSchema>;

export function slackRegistrationErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    slack_managed_unavailable: "Managed Slack setup is unavailable. Try again later or use your own app before creation starts.",
    slack_manager_reauthorize: "Reconnect your Slack workspace to continue setting up this agent.",
    slack_approval_pending: "Slack is waiting for your workspace administrator to approve this app.",
    slack_approval_required: "Your Slack workspace requires approval. Continue in Slack to request it.",
    slack_approval_denied: "Your Slack administrator declined this installation. Contact them to continue.",
    slack_configuration_token_invalid: "Slack rejected the app configuration access token. Generate a new access token and try again, or use a saved refresh token so you don't need a new access token for each agent.",
    slack_configuration_refresh_invalid: "Slack rejected the saved configuration refresh token. It may have been used elsewhere or revoked. In Slack app settings, generate a new token and save its refresh token again.",
    slack_configuration_refresh_required: "Save a Slack configuration refresh token, or enter an app configuration access token, to continue.",
    slack_configuration_refresh_uncertain: "Slack may have issued a new configuration token that Paperclip couldn't save. Try again. If it still fails, generate a new token in Slack and save its refresh token again.",
    slack_configuration_refresh_busy: "Paperclip is already refreshing this Slack configuration token. Try again in a moment.",
    slack_configuration_credential_mismatch: "Slack returned a token for a different workspace or account. Save the refresh token again from the intended workspace.",
    slack_configuration_credential_forbidden: "This saved Slack token belongs to another Paperclip account. Use your own token.",
    slack_configuration_shared_forbidden: "Only an instance administrator can save or forget the Slack token shared by every company.",
    slack_manifest_invalid: "Slack rejected this app configuration. Check the app details or use manual setup.",
    slack_manifest_update_pending: "Your Slack app is saved, but its event settings still need to be applied. Enter an app configuration access token to retry configuring the same app.",
    slack_permissions_update_pending: "This agent's Slack permissions changed. Update the Slack app and re-authorize it to apply them. Until then the agent keeps its current permissions.",
    slack_dm_scope_missing: "Reconnect this agent's Slack app so Slack grants permission to open direct messages (im:write).",
    slack_tool_not_enabled: "This Slack action is not enabled for this agent. Enable the matching permission group in the agent's Slack setup, then reconnect so Slack grants it.",
    slack_setup_rate_limited: "Slack is limiting setup requests. Wait a minute and try again.",
    slack_setup_permission_denied: "Slack requires permission to create or install this app. Ask your workspace administrator.",
    slack_creation_uncertain: "Slack may have created the app. Check your Slack app settings before trying again, or connect the existing app manually.",
    slack_install_declined: "Installation was not approved. You can install the same app when you are ready.",
    slack_install_expired: "Slack authorization expired. Install the same app again to continue.",
    slack_install_failed: "Slack installation could not be completed. Authorize the same app again.",
    slack_install_identity_mismatch: "Slack returned a different app, workspace, or bot. Install the app created for this connection.",
    slack_install_scopes_missing: "Slack did not grant all requested bot permissions. Ask the Slack workspace administrator to approve missing permissions, such as the direct-message (im:write) permission, or turn off an optional permission group if one is enabled in this agent's Slack setup.",
    slack_bot_already_connected: "This Slack bot is already connected to Paperclip. Resume its existing connection or use a different app.",
    slack_install_token_invalid: "Slack rejected the saved bot credentials. Continue in Slack to authorize this app again.",
    slack_configuration_incomplete: "The app is installed, but Paperclip could not finish connecting it. Retry connecting the saved installation.",
    slack_install_account_missing: "Slack did not identify your account. Authorize the same app again to connect your Slack account.",
    slack_install_account_conflict: "This Slack account already has an existing link. Manage account links in connection settings, or authorize with your own Slack account.",
  };
  return messages[code] ?? "Slack setup could not be completed. Resume setup and try again.";
}

/**
 * A saved Slack app whose stored manifest still has to be pushed to Slack.
 *
 * Two causes share the same follow-up (apply the manifest, then install) but
 * need different words for the user:
 * - `slack_manifest_update_pending`: a newly created app whose event settings
 *   are not applied yet.
 * - `slack_permissions_update_pending`: an installed app whose per-agent opt-in
 *   permissions changed and must be re-authorized.
 */
export function isSlackManifestUpdatePending(code: string | null | undefined): boolean {
  return code === "slack_manifest_update_pending" || code === "slack_permissions_update_pending";
}

/** Persisted legacy values keep their original meaning. Missing means manual. */
export type SlackSetupMethod = "managed" | "automatic" | "manual" | "existing";
export function isProvisionedSlackSetup(method: string | undefined): boolean {
  return method === "automatic" || method === "managed";
}
export const SLACK_MANAGER_SCOPES = ["app_configurations:read", "app_configurations:write", "managed_apps:install"] as const;
/**
 * TECH-7981: the public, secret-free summary of a saved Slack configuration
 * credential. No vault ids, workspace tokens or expiry travel to the browser.
 */
export const slackConfigurationCredentialSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string(),
  slackUserId: z.string(),
  status: z.enum(["active", "reauthorize"]),
  lastRotatedAt: z.string().datetime().nullable(),
  /** Saved once by an instance administrator and used by every company's Slack setup. */
  shared: z.boolean().optional(),
});
export type SlackConfigurationCredential = z.infer<typeof slackConfigurationCredentialSchema>;
/** Save a refresh token once; it is rotated immediately so the stored one is unique. */
export const slackConfigurationCredentialSaveSchema = z.object({
  credentials: z.object({ refreshToken: z.string().trim().regex(/^xoxe-/).max(4096) }).strict(),
  /** Instance administrators only: save this token once for every company in this instance. */
  shared: z.boolean().optional(),
}).strict();
export type SlackConfigurationCredentialSaveInput = z.infer<typeof slackConfigurationCredentialSaveSchema>;
export const slackSetupOptionsSchema = z.object({
  managedAvailable: z.boolean(),
  defaultMethod: z.enum(["managed", "automatic"]),
  workspaces: z.array(z.object({ grantId: z.string().uuid(), workspaceId: z.string(), workspaceName: z.string(), userId: z.string() })),
  configurationCredentials: z.array(slackConfigurationCredentialSchema).optional(),
});
export type SlackSetupOptions = z.infer<typeof slackSetupOptionsSchema>;
export const slackManagedProvisionSchema = z.object({
  requestId: z.string().uuid(), grantId: z.string().uuid(), confirmedNoAppCreated: z.boolean().optional(), reconnect: z.boolean().optional(),
}).strict();
export type SlackManagedProvisionInput = z.infer<typeof slackManagedProvisionSchema>;
export const slackManagedResultSchema = z.object({ authorization: slackInstallAuthorizationSchema.optional() });
export type SlackManagedResult = z.infer<typeof slackManagedResultSchema>;
