import { and, eq, isNull } from "drizzle-orm";
import { agents, dotAgentBindings, mcpOauthGrants, type Db } from "@paperclipai/db";
import { canConfigureAgentConnection } from "../modules/agent-lifecycle/index.js";
import { accessService } from "./access.js";
import { boardAuthService } from "./board-auth.js";
import { instanceSettingsService } from "./instance-settings.js";
import { McpOAuthError, type McpPrincipal } from "./public-mcp/oauth.js";

export async function externalBotEnabled(db: Db, provider: "openai_dot" | "grok_bot") {
  const experimental = await instanceSettingsService(db).getExperimental();
  return experimental.enablePublicMcp && (provider === "openai_dot" ? experimental.enableOpenAiDot : experimental.enableGrokBot && experimental.enableNativeRunner);
}

/** Persistent agent authority, distinct from task/run authority enforced by the broker. */
export async function authorizeExternalBotBinding(db: Db, principal: McpPrincipal, options: {
  requireReady?: boolean; allowPaused?: boolean; provider?: "openai_dot" | "grok_bot";
} = {}) {
  const requireReady = options.requireReady ?? true;
  if (principal.grant.purpose !== "agent" || !principal.grant.scopes.includes("paperclip:agent")) {
    throw new McpOAuthError("access_denied", "Use a dedicated external-agent connection.", 403);
  }
  const [binding] = await db.select().from(dotAgentBindings).where(and(eq(dotAgentBindings.grantId, principal.grant.id),
    eq(dotAgentBindings.companyId, principal.grant.companyId), isNull(dotAgentBindings.revokedAt)));
  if (!binding || (options.provider && binding.providerKind !== options.provider)
      || (requireReady && binding.status !== "ready")) throw new McpOAuthError("access_denied", "Connect this agent and complete its wake verification first.", 409);
  if (!await externalBotEnabled(db, binding.providerKind)) throw new McpOAuthError("access_denied", "This external provider is disabled.", 409);
  const [grant] = await db.select().from(mcpOauthGrants).where(and(eq(mcpOauthGrants.id, principal.grant.id), isNull(mcpOauthGrants.revokedAt)));
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, binding.agentId), eq(agents.companyId, binding.companyId)));
  const access = grant ? await boardAuthService(db).resolveBoardAccess(grant.userId) : null;
  const membership = access?.memberships.find(m => m.companyId === binding.companyId && m.status === "active");
  if (!access?.user || !membership || membership.membershipRole === "viewer" || !grant || grant.agentId !== binding.agentId || !agent
      || agent.adapterType !== "paperclip_runner" || agent.adapterConfig.provider !== binding.providerKind
      || ["terminated", "pending_approval"].includes(agent.status)
      || (!options.allowPaused && (requireReady ? agent.status === "paused" : !canConfigureAgentConnection(agent)))) {
    throw new McpOAuthError("access_denied", "Agent connection authority is unavailable.", 409);
  }
  if (binding.providerKind === "grok_bot" && agent.adapterConfig.externalBindingId !== binding.id) throw new McpOAuthError("access_denied", "This agent connection was replaced.", 409);
  if (binding.providerKind === "grok_bot") await authorizeExternalBotOperator(db, binding.companyId, binding.operatorId);
  return binding;
}

export async function authorizeExternalBotOperator(db: Db, companyId: string, operatorId: string) {
  const access = await boardAuthService(db).resolveBoardAccess(operatorId);
  const membership = access.memberships.find(m => m.companyId === companyId && m.status === "active");
  if (!access.user || !membership || membership.membershipRole === "viewer") throw new McpOAuthError("access_denied", "Sign in with permission to manage this agent.", 403);
  const decision = await accessService(db).decide({ actor: { type: "board", source: "session", userId: operatorId,
    companyIds: [companyId], memberships: [membership], isInstanceAdmin: false },
    action: "agents:create", resource: { type: "company", companyId } });
  if (!decision.allowed) throw new McpOAuthError("access_denied", decision.explanation, 403);
  return access;
}
