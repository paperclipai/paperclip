import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SLACK_MANAGER_SCOPES } from "@paperclipai/shared";
import type { PaperclipCloudConnector, SealedConnectorCredentials } from "../../../paperclip-cloud-connector.js";
import { createSlackSetupClient, object, providerFailure } from "./provider-client.js";

export type SlackManagerClient = Pick<PaperclipCloudConnector,
  "getSlackManagerAppId" | "startAuthorization" | "claim" | "refresh" | "revoke"
> & { authorizationMode?: "code" };

// Explicit local qualification only. Production continues using the sealed Cloud
// broker; ordinary self-hosted installs neither load credentials nor contact it.
export function developmentSlackManager(
  publicOrigin: () => string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): SlackManagerClient | null {
  if (env.NODE_ENV !== "development" || env.PAPERCLIP_SLACK_MANAGED_SETUP_ENABLED !== "true"
    || !env.PAPERCLIP_SLACK_MANAGER_DEVELOPMENT_CONFIG) return null;
  let config: Record<string, unknown>;
  try {
    const path = env.PAPERCLIP_SLACK_MANAGER_DEVELOPMENT_CONFIG;
    if (!isAbsolute(path)) throw new Error();
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0) throw new Error();
    config = object(JSON.parse(readFileSync(path, "utf8")));
  } catch { throw providerFailure("slack_managed_unavailable"); }
  const { appId, clientId, clientSecret } = config;
  if (typeof appId !== "string" || !/^A[A-Z0-9]+$/.test(appId)
    || typeof clientId !== "string" || !/^\d+\.\d+$/.test(clientId)
    || typeof clientSecret !== "string" || !clientSecret) throw providerFailure("slack_managed_unavailable");
  const callback = () => {
    const url = new URL(publicOrigin());
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw providerFailure("slack_managed_unavailable");
    return `${url.origin}/api/chat-slack/managed/oauth/callback`;
  };
  const api = createSlackSetupClient(fetchImpl);
  async function credentials(fields: Record<string, string>, subject: string, companyId: string, initial: boolean): Promise<SealedConnectorCredentials> {
    let result: Record<string, unknown>;
    try { result = await api("oauth.v2.access", { client_id: clientId as string, client_secret: clientSecret as string, ...fields }); }
    catch { throw providerFailure("slack_manager_reauthorize"); }
    const user = initial ? object(result.authed_user) : result;
    const scopes = typeof user.scope === "string" ? user.scope.split(/[, ]+/) : [];
    const team = object(result.team);
    if (typeof user.access_token !== "string" || !user.access_token || typeof user.refresh_token !== "string" || !user.refresh_token
      || user.token_type !== "user" || typeof user.expires_in !== "number" || !Number.isFinite(user.expires_in) || user.expires_in <= 0
      || SLACK_MANAGER_SCOPES.some(scope => !scopes.includes(scope))
      || (initial && (result.app_id !== appId || typeof team.id !== "string" || !/^T[A-Z0-9]+$/.test(team.id)
        || typeof team.name !== "string" || !team.name || typeof user.id !== "string" || !/^[UW][A-Z0-9]+$/.test(user.id)))) throw providerFailure("slack_manager_reauthorize");
    return {
      v: 1, accessToken: user.access_token, refreshToken: user.refresh_token, tokenType: "user",
      accessTokenExpiresAt: new Date(Date.now() + user.expires_in * 1000).toISOString(), refreshTokenExpiresAt: null,
      scopes, subject, companyId, instanceId: "local-slack-qualification", environment: "development", provider: "slack", profile: "slack.manager",
      ...(initial ? { slackManager: { appId: appId as string, workspaceId: team.id as string, workspaceName: team.name as string, userId: user.id as string } } : {}),
    };
  }
  return {
    authorizationMode: "code",
    async getSlackManagerAppId() { callback(); return appId as string; },
    async startAuthorization(values) {
      if (values.returnUri !== callback() || values.profile !== "slack.manager") throw providerFailure("slack_manager_reauthorize");
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.search = new URLSearchParams({ client_id: clientId as string, user_scope: SLACK_MANAGER_SCOPES.join(","), redirect_uri: callback(), state: values.returnState }).toString();
      return { authorizationUrl: url.toString(), expiresAt: new Date(Date.now() + 600_000).toISOString() };
    },
    async claim(values) { return credentials({ code: values.claimId, redirect_uri: callback() }, values.subject, values.companyId, true); },
    async refresh(values) { return credentials({ grant_type: "refresh_token", refresh_token: values.refreshToken }, values.subject, values.companyId, false); },
    async revoke(values) {
      try { await api("auth.revoke", {}, values.token); }
      catch { throw providerFailure("slack_manager_reauthorize"); }
    },
  };
}
