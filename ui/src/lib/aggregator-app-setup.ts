import { aggregatorContinuationInstruction, type Agent, type ToolConnection } from "@paperclipai/shared";
import type { AggregatorAppRoute } from "@paperclipai/shared/aggregator-app-catalog";
import { isAgentTaskTarget } from "./company-members";

// Connect consumer accounts live in For You, separately from developer projects.
// Composio resolves the organization placeholder for the signed-in user.
export const COMPOSIO_APP_MANAGEMENT_URL = "https://dashboard.composio.dev/~/org/connect/apps";

type SetupAgent = Pick<Agent, "id" | "name" | "role" | "reportsTo" | "createdAt" | "status" | "orgChainHealth">;

export function aggregatorSetupAgent(agents: SetupAgent[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const depth = (agent: SetupAgent) => {
    const seen = new Set([agent.id]);
    let parent = agent.reportsTo;
    while (parent && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = byId.get(parent)!.reportsTo;
    }
    return seen.size - 1;
  };
  const leadership: Partial<Record<Agent["role"], number>> = { ceo: 0, cto: 1, cfo: 2, cmo: 3 };
  const createdAt = (agent: SetupAgent) => {
    const time = new Date(agent.createdAt).getTime();
    return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
  };
  const isDefault = (agent: SetupAgent) => agent.name.trim().toLowerCase() === "default agent";
  // Prefer the named default, then organizational rank, then the oldest hire.
  return agents.filter(isAgentTaskTarget).sort((a, b) =>
    Number(isDefault(b)) - Number(isDefault(a))
    || depth(a) - depth(b)
    || (leadership[a.role] ?? 4) - (leadership[b.role] ?? 4)
    || createdAt(a) - createdAt(b)
    || a.id.localeCompare(b.id),
  )[0];
}

export function aggregatorAppSetupTask(appName: string, route: AggregatorAppRoute, account?: Pick<ToolConnection, "id" | "name">, agents: SetupAgent[] = []) {
  const providerName = route.provider === "composio" ? "Composio" : "Arcade";
  const accountInstruction = account ? ` Use the saved connection "${account.name}" (connection ID ${account.id}).` : "";
  const requiredAccess = route.provider === "composio"
    ? "For Composio setup, request COMPOSIO_SEARCH_TOOLS as Allowed and COMPOSIO_MANAGE_CONNECTIONS as Ask first; request any additional tool only when it is needed."
    : "For Arcade setup, identify and request only the discovery and app authorization tools needed for the requested app.";
  const permissionInstruction = `Before using provider tools, call connections_search for ${providerName}, then connection_request with service "${route.provider}"${account ? `, connectionId "${account.id}"` : ""}${route.provider === "composio" ? ', and toolNames ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MANAGE_CONNECTIONS"]' : ", and the exact indexed toolNames needed for discovery and app authorization"}. If this agent lacks access, connection_request creates an embedded Grant access card for the human. ${requiredAccess} Wait for that card's recorded outcome and leave the task in_review while waiting. Do not replace it with a generic permission question or ask the human to change settings manually. Do not change permissions yourself or request access for all agents. After acceptance, verify the tools are available, then follow the provider steps below.`;
  const agent = aggregatorSetupAgent(agents);
  return {
    navigateOnCreate: true,
    ...(agent ? { assigneeAgentId: agent.id } : {}),
    title: `Connect ${appName} through ${providerName}`,
    description: `Help me connect ${appName} through ${providerName}, using my existing ${providerName} gateway.${accountInstruction} The provider toolkit is ${route.toolkit}. Do not switch providers or create another gateway.\n\nHandle this connection setup directly. Do not hire agents or delegate the setup. If a human needs to sign in or authorize access, provide the browser link and wait for them.\n\n${permissionInstruction}\n\n${aggregatorContinuationInstruction(route.provider, appName)}`,
  };
}
