import { readFileSync, statSync } from "node:fs";

/** Private file contains only explicit disposable-resource allowlists and env
 * names. Credential values belong in the coordinator's child environment. */
export const EXTERNAL_CONFIG_ENV = "PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG";
export type ExternalProvider = "notion" | "slack" | "agentmail" | "vault" | "github";
export interface ProviderBinding {
  disposable: true;
  resourceIds: string[];
  credentialEnv: string[];
  prerequisites: Record<string, string>;
}
export interface ExternalFixtureConfig { schemaVersion: 1; providers: Partial<Record<ExternalProvider, ProviderBinding>> }
export const externalRequirements: Record<string, { provider: ExternalProvider; fields: readonly string[] }> = {
  "projects.add-repository": { provider: "github", fields: ["siteRepositoryId", "siteRepositoryFullName", "tokenEnv"] },
  "workspaces.prepare-repository": { provider: "github", fields: ["siteRepositoryId", "siteRepositoryFullName", "tokenEnv"] },
  "workspaces.private-repository-no-access": { provider: "github", fields: ["siteRepositoryId", "siteRepositoryFullName", "tokenEnv", "humanAuthEnv"] },
  "projects.replace-repository": { provider: "github", fields: ["oldRepositoryId", "oldRepositoryFullName", "newRepositoryId", "newRepositoryFullName", "tokenEnv"] },
  "app-permissions.revoke-account": { provider: "notion", fields: ["workspaceId", "mcpUrl", "apiVersion", "apiTokenEnv", "mcpTokenEnv"] },
  "app-permissions.grant-one-agent": { provider: "notion", fields: ["workspaceId", "mcpUrl", "apiVersion", "apiTokenEnv", "mcpTokenEnv"] },
  "gateways-profiles.define-profile": { provider: "notion", fields: ["workspaceId", "mcpUrl", "apiVersion", "apiTokenEnv", "mcpTokenEnv"] },
  "connection-setup.notion-connected": { provider: "notion", fields: ["workspaceId", "recentPageId", "olderPageId", "mcpUrl", "apiVersion", "apiTokenEnv", "mcpTokenEnv", "recentMarker", "olderMarker", "recentFactJson", "olderFactJson"] },
  "connection-setup.notion-missing": { provider: "notion", fields: ["workspaceId", "workspaceName", "recentPageId", "olderPageId", "mcpUrl", "apiVersion", "apiTokenEnv", "recentMarker", "olderMarker", "recentFactJson", "olderFactJson", "oauthBrowserSessionEnv", "oauthHumanEmailEnv"] },
  "connection-setup.notion-wrong-account": { provider: "notion", fields: ["workspaceId", "workspaceName", "recentPageId", "olderPageId", "mcpUrl", "apiVersion", "apiTokenEnv", "recentMarker", "olderMarker", "recentFactJson", "olderFactJson", "oauthBrowserSessionEnv", "oauthHumanEmailEnv", "sharedWorkspaceId", "sharedApiTokenEnv", "sharedMcpTokenEnv"] },
  "connection-setup.notion-agent-unassigned": { provider: "notion", fields: ["workspaceId", "recentPageId", "olderPageId", "mcpUrl", "apiVersion", "apiTokenEnv", "mcpTokenEnv", "recentMarker", "olderMarker", "recentFactJson", "olderFactJson"] },
  "connection-setup.notion-expired": { provider: "notion", fields: ["workspaceId", "workspaceName", "recentPageId", "olderPageId", "mcpUrl", "apiVersion", "apiTokenEnv", "recentMarker", "olderMarker", "recentFactJson", "olderFactJson", "oauthBrowserSessionEnv", "oauthHumanEmailEnv", "expiredAuthorizationEnv", "authorizationExpiresAt", "authorizationFailureKind"] },
  "connection-setup.return-from-login": { provider: "notion", fields: ["workspaceId", "workspaceName", "recentPageId", "olderPageId", "mcpUrl", "apiVersion", "apiTokenEnv", "recentMarker", "olderMarker", "recentFactJson", "olderFactJson", "oauthBrowserSessionEnv", "oauthHumanEmailEnv"] },
  "connection-setup.save-and-resume": { provider: "notion", fields: ["workspaceId", "workspaceName", "recentPageId", "olderPageId", "mcpUrl", "apiVersion", "apiTokenEnv", "recentMarker", "olderMarker", "recentFactJson", "olderFactJson", "oauthBrowserSessionEnv", "oauthHumanEmailEnv"] },
  "connection-setup.channel-prerequisites": { provider: "slack", fields: ["workspaceId", "channelId", "senderUserId", "botUserId", "appId", "registeredWebhookOrigin", "webhookRelayPort", "botTokenEnv", "senderTokenEnv", "signingSecretEnv", "configurationTokenEnv", "slackBrowserSessionEnv"] },
  "chat-channels.connect-slack": { provider: "slack", fields: ["workspaceId", "channelId", "senderUserId", "botUserId", "appId", "registeredWebhookOrigin", "webhookRelayPort", "botTokenEnv", "senderTokenEnv", "signingSecretEnv", "configurationTokenEnv", "slackBrowserSessionEnv"] },
  "chat-channels.link-sender": { provider: "slack", fields: ["workspaceId", "channelId", "senderUserId", "botUserId", "appId", "registeredWebhookOrigin", "webhookRelayPort", "botTokenEnv", "senderTokenEnv", "signingSecretEnv", "configurationTokenEnv"] },
  "chat-channels.reply-in-thread": { provider: "slack", fields: ["workspaceId", "channelId", "senderUserId", "botUserId", "appId", "registeredWebhookOrigin", "webhookRelayPort", "botTokenEnv", "senderTokenEnv", "signingSecretEnv", "configurationTokenEnv"] },
  "chat-channels.channel-file": { provider: "slack", fields: ["workspaceId", "channelId", "senderUserId", "botUserId", "appId", "registeredWebhookOrigin", "webhookRelayPort", "botTokenEnv", "senderTokenEnv", "signingSecretEnv", "configurationTokenEnv"] },
  "chat-channels.repair-endpoint": { provider: "slack", fields: ["workspaceId", "channelId", "senderUserId", "botUserId", "appId", "registeredWebhookOrigin", "webhookRelayPort", "botTokenEnv", "senderTokenEnv", "signingSecretEnv", "configurationTokenEnv", "slackBrowserSessionEnv", "botTokenExpiresAt", "repairBotTokenEnv"] },
  "chat-channels.outbound-email": { provider: "agentmail", fields: ["inboxId", "recipient", "recipientAuthorization", "apiTokenEnv"] },
  "chat-channels.reply-to-email": { provider: "agentmail", fields: ["inboxId", "recipient", "recipientAuthorization", "apiTokenEnv", "reviewerAddress", "reviewerAuthorization", "senderCredentialEnv"] },
  "secrets.vault-reference": { provider: "vault", fields: ["provider", "region", "deploymentId", "kmsKeyId", "secretReference", "accessKeyIdEnv", "secretAccessKeyEnv", "sessionTokenEnv", "expectedValueEnv"] },
  "recovery.unknown-email-outcome": { provider: "agentmail", fields: ["inboxId", "recipient", "recipientAuthorization", "apiTokenEnv"] },
};
export interface PrerequisiteReceipt { scenarioId: string; provider?: ExternalProvider; configured: boolean; missing: string[] }
export function validateExternalConfig(value: unknown): ExternalFixtureConfig {
  const config = value as ExternalFixtureConfig;
  if (!config || config.schemaVersion !== 1 || !config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)) throw new Error("Invalid external fixture configuration; contents withheld");
  for (const [provider, binding] of Object.entries(config.providers)) {
    if (!["notion", "slack", "agentmail", "vault", "github"].includes(provider) || !binding || binding.disposable !== true
      || !Array.isArray(binding.resourceIds) || !binding.resourceIds.length || binding.resourceIds.some((id: unknown) => typeof id !== "string" || !id.trim())
      || !Array.isArray(binding.credentialEnv) || !binding.credentialEnv.length || binding.credentialEnv.some((name: unknown) => typeof name !== "string" || !/^PAPERCLIP_CHAT_EVAL_[A-Z0-9_]+$/.test(name))
      || !binding.prerequisites || typeof binding.prerequisites !== "object" || Array.isArray(binding.prerequisites)
      || Object.values(binding.prerequisites).some(value => typeof value !== "string" || !value.trim())) throw new Error("Invalid disposable provider binding; contents withheld");
  }
  return config;
}
export function readExternalConfig(env: NodeJS.ProcessEnv = process.env): ExternalFixtureConfig | undefined {
  const path = env[EXTERNAL_CONFIG_ENV]?.trim(); if (!path) return;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65_536) throw new Error("Not a private bounded file");
    return validateExternalConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch { throw new Error("External fixture config is unavailable, invalid or not private (0600); contents withheld"); }
}
export function externalPrerequisiteReceipt(scenarioId: string, config: ExternalFixtureConfig | undefined, env: NodeJS.ProcessEnv = process.env): PrerequisiteReceipt {
  const requirement = externalRequirements[scenarioId]; if (!requirement) return { scenarioId, configured: true, missing: [] };
  const binding = config?.providers[requirement.provider];
  const missing = !binding ? ["authorized-disposable-provider-binding", ...requirement.fields] : [
    ...requirement.fields.filter(field => !binding.prerequisites[field]),
    ...binding.credentialEnv.filter(name => !env[name]?.trim()).map(name => `environment:${name}`),
    ...requirement.fields.filter(field => field.endsWith("Env") && binding.prerequisites[field] && !env[binding.prerequisites[field]!]?.trim()).map(field => `environment-reference:${field}`),
  ];
  return { scenarioId, provider: requirement.provider, configured: missing.length === 0, missing };
}
export function requireExternalPrerequisites(scenarioId: string, config = readExternalConfig()): ProviderBinding {
  const receipt = externalPrerequisiteReceipt(scenarioId, config);
  if (!receipt.configured) throw new Error(`Setup blocker ${scenarioId}: ${receipt.provider} requires ${receipt.missing.join(", ")}; provide private ${EXTERNAL_CONFIG_ENV} reference`);
  const provider = externalRequirements[scenarioId]?.provider;
  if (!provider) throw new Error("This scenario has no external-account prerequisite");
  return config!.providers[provider]!;
}

/** Runtime case consumers receive only the selected declaration's configuration
 * and references. Never fall back to ambient host/model/provider environment. */
export function selectedExternalBinding(
  context: import("../chat-catalog-contract.js").ChatCatalogContext,
  scenarioId = context.scenario.id,
): ProviderBinding {
  const privateInputs = context.input.privateInputs;
  if (!privateInputs) throw new Error(`Setup blocker ${scenarioId}: selected-case private inputs are unavailable`);
  const configValue = privateInputs.configuration("external-provider");
  if (!configValue) throw new Error(`Setup blocker ${scenarioId}: authorized disposable provider configuration is missing`);
  const config = validateExternalConfig(configValue);
  const requirement = externalRequirements[scenarioId];
  if (!requirement) throw new Error("No external provider requirement is declared for this scenario");
  const binding = config.providers[requirement.provider];
  const references: NodeJS.ProcessEnv = {};
  for (const name of [...binding?.credentialEnv ?? [], ...requirement.fields.filter(field => field.endsWith("Env")).map(field => binding?.prerequisites[field]).filter((name): name is string => !!name)]) {
    if (!/^PAPERCLIP_CHAT_EVAL_[A-Z0-9_]+$/.test(name)) throw new Error("Selected provider reference is outside the private namespace");
    references[name] = privateInputs.read(name);
  }
  const receipt = externalPrerequisiteReceipt(scenarioId, config, references);
  if (!receipt.configured) throw new Error(`Setup blocker ${scenarioId}: ${receipt.provider} requires ${receipt.missing.join(", ")}`);
  return binding!;
}
export function selectedExternalCredential(
  context: import("../chat-catalog-contract.js").ChatCatalogContext,
  binding: ProviderBinding,
  name: string,
): string {
  const fieldReference = binding.prerequisites[name];
  const reference = fieldReference && name.endsWith("Env") ? fieldReference : name;
  if (!binding.credentialEnv.includes(reference) && !Object.entries(binding.prerequisites).some(([field, value]) => field.endsWith("Env") && value === reference)) throw new Error("Credential reference was not declared by this selected provider");
  const value = context.input.privateInputs?.read(reference);
  if (!value) throw new Error("Selected private provider credential is unavailable; reference withheld");
  context.input.privateSecrets?.push(value);
  return value;
}
