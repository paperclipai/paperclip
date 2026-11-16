import { and, eq } from "drizzle-orm";
import { chatEndpoints, toolConnections, type Db } from "@paperclipai/db";
import {
  SLACK_DEFAULT_BOT_SCOPES,
  SLACK_OPT_IN_BOT_SCOPE_GROUPS,
  SLACK_OPT_IN_SCOPE_GROUPS,
  SLACK_TOOLS,
  slackOptInGroupsForTool,
  type SlackToolCapabilities,
} from "@paperclipai/shared";
import { notFound } from "../../errors.js";
import { secretService } from "../secrets.js";
import { slackClient } from "./slack-client.js";
import { ensureSlackBotCatalogCurrent, slackActiveCatalogToolNames } from "./slack-catalog.js";
import {
  isSlackToolEnabledForOptIns,
  slackEnabledOptInGroups,
  slackEndpointOptInsForGating,
} from "./slack-opt-ins.js";
export async function slackCapabilities(
  db: Db,
  companyId: string,
  endpointId: string,
): Promise<SlackToolCapabilities> {
  const [row] = await db
    .select({ endpoint: chatEndpoints, connection: toolConnections })
    .from(chatEndpoints)
    .innerJoin(
      toolConnections,
      and(
        eq(toolConnections.id, chatEndpoints.connectionId),
        eq(toolConnections.companyId, companyId),
      ),
    )
    .where(
      and(
        eq(chatEndpoints.companyId, companyId),
        eq(chatEndpoints.id, endpointId),
        eq(chatEndpoints.provider, "slack"),
      ),
    );
  if (
    !row ||
    !row.connection.enabled ||
    !["active", "verifying"].includes(row.endpoint.status)
  )
    throw notFound("Active Slack connection not found");
  const ref = row.connection.credentialSecretRefs.find(
    (r) => r.configPath === "credentials.botToken",
  );
  if (!ref) throw notFound("Slack bot credential is unavailable");
  const token = await secretService(db).resolveSecretValue(
    companyId,
    ref.secretId,
    ref.versionSelector ?? "latest",
    {
      consumerType: "tool_connection",
      consumerId: row.connection.id,
      configPath: ref.configPath,
      actorType: "system",
      actorId: null,
    },
  );
  const auth = await slackClient(token)("auth.test");
  const scopes = Array.isArray(auth.grantedScopes)
    ? auth.grantedScopes.filter((s): s is string => typeof s === "string")
    : null;
  // `tools`, `missingScopes` and `missingGroups` must agree with runtime
  // gating: all three use requested-and-installed groups, never installed
  // alone and never the pending request. A group the operator removed stays
  // ungated-off even if Slack kept its scope on the installation.
  const gating = await slackEndpointOptInsForGating(db, row.endpoint);
  const enabled = slackEnabledOptInGroups(row.endpoint.setup, gating);
  const tools = SLACK_TOOLS.filter((tool) => isSlackToolEnabledForOptIns(tool, enabled));
  // Settings refresh is system maintenance, not a user review of tool grants.
  await ensureSlackBotCatalogCurrent(db, row.endpoint, null);
  const activeNames = await slackActiveCatalogToolNames(db, row.endpoint);
  // Guidance names the permission group to enable, not just raw scopes: a
  // scope can be enabled through a switch the operator recognises.
  const missingGroups = SLACK_OPT_IN_SCOPE_GROUPS.filter((group) => !enabled.includes(group))
    .map((group) => {
      const definition = SLACK_OPT_IN_BOT_SCOPE_GROUPS[group];
      const toolNames = SLACK_TOOLS
        .filter((tool) => slackOptInGroupsForTool(tool).includes(group))
        .map((tool) => tool.name);
      return toolNames.length === 0
        ? null
        : {
            group: String(group),
            label: definition.label,
            description: definition.description,
            scopes: [...definition.scopes],
            toolNames,
            action: row.endpoint.setup?.slackOptInScopeGroups?.includes(group)
              ? "reconnect" as const
              : "enable" as const,
          };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  // The floor plus every enabled group's scopes is what this install needs.
  // Nothing else is reported missing, so a trimmed install stays quiet.
  const required = new Set<string>([
    ...SLACK_DEFAULT_BOT_SCOPES,
    ...enabled.flatMap((group) => SLACK_OPT_IN_BOT_SCOPE_GROUPS[group].scopes),
  ]);
  return {
    grantedScopes: scopes,
    missingScopes: scopes ? [...required].filter((scope) => !scopes.includes(scope)) : [],
    missingGroups,
    dmReconnectRequired: scopes ? !scopes.includes("im:write") : false,
    // Only tools this agent may actually call are listed: a gated-off group's
    // tool is neither offered nor reported as merely unavailable.
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
      available: !activeNames.has(t.name)
        ? false
        : t.name === "slack_search"
          ? true
          : scopes
            ? t.scopes.every((s) => s.split("|").some((scope) => scopes.includes(scope)))
            : null,
    })),
  };
}
