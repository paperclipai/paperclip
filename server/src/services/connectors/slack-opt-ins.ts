import { and, eq, inArray } from "drizzle-orm";
import { chatEndpoints, type Db } from "@paperclipai/db";
import {
  SLACK_TOOLS,
  SLACK_OPT_IN_BOT_SCOPE_GROUPS,
  isSlackToolEnabledForOptIns,
  slackOptInGroupsForSetup,
  slackOptInGroupsForTool,
  slackOptInScopes,
  slackRequestedOptInGroups,
  type SlackOptInScopeGroup,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../../errors.js";

/**
 * TECH-7988: the opt-in groups that decide which Slack tools an endpoint may
 * use. Gating reads only what the live install holds, so a requested but not
 * yet installed group exposes no tools.
 */
export type SlackSetupOptIns = {
  slackOptInScopeGroups?: readonly SlackOptInScopeGroup[];
  slackInstalledOptInScopeGroups?: readonly SlackOptInScopeGroup[];
};

type SlackGatingOptions = { legacyInstall?: boolean };

/** A database handle or transaction; both support the reads below. */
type SlackReadExecutor = Pick<Db, "select">;

export function slackEndpointOptInGroups(
  setup: SlackSetupOptIns | null | undefined,
  options?: SlackGatingOptions,
): SlackOptInScopeGroup[] {
  return slackOptInGroupsForSetup(setup, options);
}

/** The groups the operator requested, used for install-time scope verification. */
export function slackEndpointRequestedOptInGroups(
  setup: SlackSetupOptIns | null | undefined,
): SlackOptInScopeGroup[] {
  return slackRequestedOptInGroups(setup);
}

/**
 * The opt-in groups an agent may actually use, and the one definition every
 * listing and dispatch path gates on.
 *
 * This is the intersection of requested and installed, never installed alone.
 * A group counts only when the operator still asks for it AND Slack granted it:
 * - requested but not granted yet: no access, because Slack would refuse the
 *   call with `missing_scope`.
 * - granted but since removed: no access, even if Slack kept the scope on the
 *   existing installation, because the operator asked for it to be disabled.
 *
 * A requested field that is present is authoritative as the operator's request.
 * Only a legacy install (no request recorded at all) uses its implied full
 * grant as the request, so pre-opt-in installations keep working until their
 * opt-ins are first edited.
 */
export function slackEnabledOptInGroups(
  setup: SlackSetupOptIns | null | undefined,
  options?: SlackGatingOptions,
): SlackOptInScopeGroup[] {
  const requested =
    setup?.slackOptInScopeGroups !== undefined
      ? new Set(slackRequestedOptInGroups(setup))
      : new Set(slackOptInGroupsForSetup(setup, options));
  return slackEndpointOptInGroups(setup, options).filter((group) => requested.has(group));
}

export function isSlackToolEnabledForSetup(
  setup: SlackSetupOptIns | null | undefined,
  tool: { name: string; scopes: readonly string[] },
  options?: SlackGatingOptions,
): boolean {
  return isSlackToolEnabledForOptIns(tool, slackEnabledOptInGroups(setup, options));
}

/**
 * Fail closed before any Slack API call: a tool whose scopes this agent does
 * not have enabled is rejected here rather than surfacing as a Slack
 * `missing_scope` at call time.
 *
 * An unknown tool name is a caller mistake, not a permission problem, so it is
 * a 400 rather than a 403: an authorization error would mislead a client into
 * asking for access it will never be granted.
 */
export function assertSlackToolEnabledForSetup(
  setup: SlackSetupOptIns | null | undefined,
  toolName: string,
  options?: SlackGatingOptions,
): void {
  const tool = SLACK_TOOLS.find((entry) => entry.name === toolName);
  if (!tool)
    throw badRequest(`Unknown Slack tool: ${toolName}`, {
      code: "unknown_slack_tool",
    });
  if (isSlackToolEnabledForSetup(setup, tool, options)) return;
  const groups = slackOptInGroupsForTool(tool);
  const labels = groups
    .map((group) => SLACK_OPT_IN_BOT_SCOPE_GROUPS[group].label)
    .join(", ");
  throw forbidden(
    groups.length > 0
      ? `${toolName} is not enabled for this agent. Enable ${labels} in the agent's Slack setup, then reconnect so Slack grants the new permissions.`
      : `${toolName} is not enabled for this agent.`,
    { code: "slack_tool_not_enabled", groups },
  );
}

/** Scope-based check for a catalog entry, independent of endpoint plumbing. */
export { isSlackToolEnabledForOptIns };

/** The tools an endpoint with these enabled groups may use. */
export function slackEnabledToolsForSetup(
  setup: SlackSetupOptIns | null | undefined,
  options?: SlackGatingOptions,
) {
  const groups = slackEnabledOptInGroups(setup, options);
  return SLACK_TOOLS.filter((tool) => isSlackToolEnabledForOptIns(tool, groups));
}

/** True when two group lists name the same set, ignoring order and duplicates. */
export function sameSlackOptInGroups(
  a: readonly SlackOptInScopeGroup[],
  b: readonly SlackOptInScopeGroup[],
): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((group) => right.has(group));
}

/**
 * True when the requested groups differ from what the install holds.
 *
 * An untouched legacy install carries neither field: it has no operator request
 * at all, so its implied request is the full grant it already holds and nothing
 * is pending until someone actually edits the groups.
 */
export function slackEndpointOptInsChanged(
  setup: SlackSetupOptIns | null | undefined,
  options?: SlackGatingOptions,
): boolean {
  if (
    options?.legacyInstall === true &&
    setup?.slackOptInScopeGroups === undefined &&
    setup?.slackInstalledOptInScopeGroups === undefined
  )
    return false;
  return !sameSlackOptInGroups(
    slackRequestedOptInGroups(setup),
    slackEndpointOptInGroups(setup, options),
  );
}

/**
 * The opt-in scopes a Slack bot token must hold beyond the chat floor.
 *
 * - `replacement`: a newly issued token (a reinstall, or credentials the
 *   operator just supplied) becomes the install. It must hold what the operator
 *   requested, which is what its manifest asked Slack for. Checking it against
 *   the grant it replaces would make removing a group impossible: the new token
 *   correctly lacks the removed scopes.
 * - `installed`: a stored token is the live install. It must still hold every
 *   group recorded as installed, because gating exposes those groups' tools.
 *
 * Neither case ever requires the implied legacy grant. A row with no recorded
 * field needs only the chat floor, so a legacy app with a trimmed manifest or
 * declined scopes can still be resumed and repaired.
 */
export function slackVerificationOptInScopes(
  setup: SlackSetupOptIns | null | undefined,
  token: "replacement" | "installed",
): string[] {
  const groups =
    token === "replacement"
      ? setup?.slackOptInScopeGroups
      : setup?.slackInstalledOptInScopeGroups;
  return slackOptInScopes([...new Set(groups ?? [])]);
}

/**
 * Whether an endpoint is an installation from before per-agent opt-ins.
 *
 * This is the single definition of a legacy install, shared by the setup
 * projection, credential verification, gating and persistence. Every Slack
 * endpoint created since opt-ins exist carries both fields explicitly, so a
 * row with neither field predates them. It counts as installed when a bot is
 * connected, whatever the setup method: a manual app has a bot but no Slack
 * registration row, so the definition cannot depend on one.
 */
export function isSlackLegacyInstall(endpoint: {
  botExternalId: string | null | undefined;
  setup: SlackSetupOptIns | null | undefined;
}): boolean {
  return (
    Boolean(endpoint.botExternalId) &&
    endpoint.setup?.slackOptInScopeGroups === undefined &&
    endpoint.setup?.slackInstalledOptInScopeGroups === undefined
  );
}

/**
 * Which endpoints were already installed before per-agent opt-ins existed.
 *
 * The legacy full-grant fallback must never apply to a brand-new endpoint. This
 * reads the same columns `isSlackLegacyInstall` judges, so the database answer
 * always matches the in-memory one.
 */
export async function slackLegacyInstallEndpoints(
  db: SlackReadExecutor,
  input: { companyId: string; agentId?: string; endpointIds?: readonly string[] },
): Promise<Set<string>> {
  const ids = input.endpointIds?.filter(Boolean) ?? [];
  if (input.endpointIds && ids.length === 0) return new Set();
  const rows = await db
    .select({
      id: chatEndpoints.id,
      botExternalId: chatEndpoints.botExternalId,
      setup: chatEndpoints.setup,
    })
    .from(chatEndpoints)
    .where(
      and(
        eq(chatEndpoints.companyId, input.companyId),
        eq(chatEndpoints.provider, "slack"),
        ...(input.agentId ? [eq(chatEndpoints.assignedAgentId, input.agentId)] : []),
        ...(input.endpointIds ? [inArray(chatEndpoints.id, ids)] : []),
      ),
    );
  return new Set(rows.filter(isSlackLegacyInstall).map((row) => row.id));
}

export async function slackLegacyInstall(
  db: SlackReadExecutor,
  input: { companyId: string; endpointId: string },
): Promise<boolean> {
  return (await slackLegacyInstallEndpoints(db, {
    companyId: input.companyId,
    endpointIds: [input.endpointId],
  })).has(input.endpointId);
}

/** Gating for one already-loaded endpoint, resolving its legacy install. */
export async function slackEndpointOptInsForGating(
  db: SlackReadExecutor,
  endpoint: { id: string; companyId: string; setup: SlackSetupOptIns | null },
): Promise<SlackGatingOptions> {
  if (
    endpoint.setup?.slackInstalledOptInScopeGroups !== undefined ||
    endpoint.setup?.slackOptInScopeGroups !== undefined
  )
    return {};
  return {
    legacyInstall: await slackLegacyInstall(db, {
      companyId: endpoint.companyId,
      endpointId: endpoint.id,
    }),
  };
}

/**
 * Direct messages with other active workspace members are standard for all agents (TECH-8783).
 */
export const SLACK_OTHER_USER_DM_OPTIONS = { allowOtherUserDm: true } as const;

/** Capability/tool listing that must match runtime gating exactly. */
export async function slackEnabledToolsForEndpoint(
  db: Db,
  endpoint: { id: string; companyId: string; setup: SlackSetupOptIns | null },
) {
  return slackEnabledToolsForSetup(
    endpoint.setup,
    await slackEndpointOptInsForGating(db, endpoint),
  );
}
