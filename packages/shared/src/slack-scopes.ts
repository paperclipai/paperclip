import { z } from "zod";

/**
 * TECH-7988 / TECH-8783: the bot scopes every Paperclip agent Slack app
 * requests by default.
 *
 * This includes Slack's standard low-risk scopes plus `im:write` so direct
 * messages with active workspace members are standard for all agents. Because
 * `im:write` is rated above Slack's default low-risk tier, new installs may
 * require workspace admin approval unless an internal policy auto-approves it.
 * Scopes that remain opt-in live in `SLACK_OPT_IN_BOT_SCOPE_GROUPS` and are
 * requested per agent on request.
 *
 * `users:read.email` lets `slack_find_user` match a person by email. Existing apps
 * keep the scopes they were created with until an admin updates them.
 *
 * Channel reading and replying stay here (`*:history`, `chat:write`), so an
 * agent added to a channel can still read its full history and answer.
 *
 * Treat this list as a security boundary: a scope only moves here when it is
 * safe to grant every agent.
 */
export const SLACK_DEFAULT_BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "bookmarks:read",
  "bookmarks:write",
  "canvases:read",
  "canvases:write",
  "channels:history",
  "channels:read",
  "channels:write.topic",
  "chat:write",
  "commands",
  "emoji:read",
  "files:read",
  "groups:history",
  "groups:read",
  "groups:write.topic",
  "im:history",
  "im:read",
  "im:write",
  "lists:read",
  "lists:write",
  "mpim:history",
  "mpim:read",
  "pins:read",
  "pins:write",
  "reactions:read",
  "reactions:write",
  "users:read",
  "users:read.email",
] as const;

const defaultScopeSet = new Set<string>(SLACK_DEFAULT_BOT_SCOPES);

/**
 * The remaining bot scopes are each rated above Low risk, so a workspace admin
 * approves them manually. Grouping them by the capability they unlock keeps the
 * opt-in UI honest about what an agent gains.
 */
export const SLACK_OPT_IN_BOT_SCOPE_GROUPS = {
  channel_management: {
    label: "Channel management",
    description:
      "Create channels and invite people. Enabling this sends this agent's Slack install to admin review.",
    scopes: ["channels:manage", "groups:write"],
  },
  file_upload: {
    label: "File upload",
    description:
      "Upload task attachments into Slack. Enabling this sends this agent's Slack install to admin review.",
    scopes: ["files:write"],
  },
} as const;

export type SlackOptInScopeGroup =
  keyof typeof SLACK_OPT_IN_BOT_SCOPE_GROUPS;

export const SLACK_OPT_IN_SCOPE_GROUPS = Object.keys(
  SLACK_OPT_IN_BOT_SCOPE_GROUPS,
) as SlackOptInScopeGroup[];

export function isSlackOptInScopeGroup(
  value: string,
): value is SlackOptInScopeGroup {
  return Object.hasOwn(SLACK_OPT_IN_BOT_SCOPE_GROUPS, value);
}

/** Dedupes and filters an arbitrary list down to valid opt-in groups. */
export function normalizeSlackOptInGroups(
  groups: readonly unknown[] | undefined | null,
): SlackOptInScopeGroup[] {
  if (!groups || !Array.isArray(groups)) return [];
  const result: SlackOptInScopeGroup[] = [];
  for (const group of groups) {
    if (typeof group === "string" && isSlackOptInScopeGroup(group) && !result.includes(group)) {
      result.push(group);
    }
  }
  return result;
}

/**
 * Request/response contract for the per-agent opt-in choice.
 * `proactive_dms` stays in the enum deliberately for backward compatibility and is normalized away.
 */
const slackOptInScopeGroupSchema = z.enum([
  "channel_management",
  "proactive_dms",
  "file_upload",
]);
export const slackOptInScopeGroupsSchema = z
  .array(slackOptInScopeGroupSchema)
  // Bounded before dedupe so a pathological list cannot be unbounded.
  .max(50)
  .transform((groups) => normalizeSlackOptInGroups(groups))
  .refine(
    (groups) => groups.length <= SLACK_OPT_IN_SCOPE_GROUPS.length,
    { message: "Unknown Slack permission group" },
  );

/** The scopes contributed by the given opt-in groups. */
export function slackOptInScopes(
  groups: readonly (SlackOptInScopeGroup | string)[] | undefined | null,
): string[] {
  const scopes = new Set<string>();
  for (const group of groups ?? []) {
    if (!isSlackOptInScopeGroup(group)) continue;
    for (const scope of SLACK_OPT_IN_BOT_SCOPE_GROUPS[group].scopes) {
      scopes.add(scope);
    }
  }
  return [...scopes].sort();
}

/** Default scopes plus only the enabled groups' scopes, sorted and deduped. */
export function slackBotScopes(
  groups: readonly SlackOptInScopeGroup[] | undefined | null,
): string[] {
  return [
    ...new Set([...SLACK_DEFAULT_BOT_SCOPES, ...slackOptInScopes(groups)]),
  ].sort();
}

/**
 * Every bot scope any agent can request, derived from the two sources above so
 * the full list can never drift from the default/opt-in split.
 */
export const SLACK_ALL_BOT_SCOPES = slackBotScopes(SLACK_OPT_IN_SCOPE_GROUPS);

/**
 * True when the operator's requested groups differ from what the live install
 * covers, i.e. the app needs a manifest update plus a reinstall.
 *
 * A brand-new endpoint with nothing requested and nothing installed is not
 * "changed". A pre-TECH-7988 installation does hold the full grant, so trimming
 * its request is a real change.
 */
export function slackOptInGroupsChanged(
  setup: SlackOptInSetupState | null | undefined,
  options?: { legacyInstall?: boolean },
): boolean {
  // A legacy installation carrying neither field has no operator request at
  // all: its implied request is the same full grant it holds, so nothing is
  // pending until someone actually edits the groups.
  if (
    options?.legacyInstall === true &&
    setup?.slackOptInScopeGroups === undefined &&
    setup?.slackInstalledOptInScopeGroups === undefined
  )
    return false;
  const requested = slackRequestedOptInGroups(setup);
  const installed = slackOptInGroupsForSetup(setup, options);
  // `sameGroupSet` reports a difference; unchanged means the sets match.
  return sameGroupSet(requested, installed);
}

/** The opt-in group a scope belongs to, if it is one. */
export function slackOptInGroupForScope(
  scope: string,
): SlackOptInScopeGroup | null {
  if (defaultScopeSet.has(scope)) return null;
  for (const group of SLACK_OPT_IN_SCOPE_GROUPS) {
    if (
      (SLACK_OPT_IN_BOT_SCOPE_GROUPS[group].scopes as readonly string[]).includes(
        scope,
      )
    ) {
      return group;
    }
  }
  return null;
}

/** The opt-in groups a tool depends on, for a precise error message. */
export function slackOptInGroupsForTool(tool: {
  scopes: readonly string[];
}): SlackOptInScopeGroup[] {
  const groups = new Set<SlackOptInScopeGroup>();
  for (const requirement of tool.scopes) {
    for (const scope of requirement.split("|")) {
      const group = slackOptInGroupForScope(scope);
      if (group) groups.add(group);
    }
  }
  return SLACK_OPT_IN_SCOPE_GROUPS.filter((group) => groups.has(group));
}

/**
 * Whether a tool is enabled for the given opt-in groups. Every scope
 * requirement must be satisfied by the default set or an enabled group; `a|b`
 * requirements need only one alternative. Tools with no requirement (for
 * example the receipt lookup) are always enabled.
 *
 * `slack_search` is always enabled: its `search:read.*` scopes are granted by a
 * separate personal-search OAuth flow, never by the bot manifest.
 */
export function isSlackToolEnabledForOptIns(
  tool: { name: string; scopes: readonly string[] },
  enabledGroups: readonly SlackOptInScopeGroup[] | undefined | null,
): boolean {
  if (tool.name === "slack_search") return true;
  const available = new Set<string>([
    ...SLACK_DEFAULT_BOT_SCOPES,
    ...slackOptInScopes(enabledGroups),
  ]);
  return tool.scopes.every((requirement) =>
    requirement.split("|").some((scope) => available.has(scope)),
  );
}

/** The bot scopes a stored manifest requests. */
export function slackManifestBotScopes(
  manifest: unknown,
): string[] {
  const oauth = manifest && typeof manifest === "object"
    ? (manifest as Record<string, unknown>).oauth_config
    : undefined;
  const scopes = oauth && typeof oauth === "object"
    ? (oauth as Record<string, unknown>).scopes
    : undefined;
  const bot = scopes && typeof scopes === "object"
    ? (scopes as Record<string, unknown>).bot
    : undefined;
  return Array.isArray(bot)
    ? bot.filter((scope): scope is string => typeof scope === "string")
    : [];
}

/** The opt-in groups whose full scope set is present in `scopes`. */
export function slackOptInGroupsFromScopes(
  scopes: readonly string[],
): SlackOptInScopeGroup[] {
  return SLACK_OPT_IN_SCOPE_GROUPS.filter((group) =>
    (SLACK_OPT_IN_BOT_SCOPE_GROUPS[group].scopes as readonly string[]).every(
      (scope) => scopes.includes(scope),
    ),
  );
}

type SlackOptInSetupState = {
  slackOptInScopeGroups?: readonly SlackOptInScopeGroup[];
  slackInstalledOptInScopeGroups?: readonly SlackOptInScopeGroup[];
};

function sameGroupSet(
  a: readonly SlackOptInScopeGroup[],
  b: readonly SlackOptInScopeGroup[],
): boolean {
  return JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort());
}

/** The groups the operator asked for. Opt-in groups are off unless chosen. */
export function slackRequestedOptInGroups(
  setup: { slackOptInScopeGroups?: readonly unknown[] } | null | undefined,
): SlackOptInScopeGroup[] {
  return normalizeSlackOptInGroups(setup?.slackOptInScopeGroups);
}

/**
 * The opt-in groups an endpoint's *live* install actually covers. Gating reads
 * only this: a requested but not-yet-installed group exposes no tools until
 * Slack has granted its scopes.
 *
 * - A recorded install wins, so a pending change never exposes ungranted tools
 *   and never silently drops access the existing install still holds.
 * - The full pre-TECH-7988 grant applies only to an installation that predates
 *   per-agent opt-ins: a prior install exists (`legacyInstall`) and the row
 *   carries neither opt-in field.
 * - Everything else -- including a new endpoint created without the fields --
 *   has no opt-in groups.
 */
export function slackOptInGroupsForSetup(
  setup: SlackOptInSetupState | null | undefined,
  options?: { legacyInstall?: boolean },
): SlackOptInScopeGroup[] {
  const installed = setup?.slackInstalledOptInScopeGroups;
  if (installed !== undefined) return normalizeSlackOptInGroups(installed);
  if (
    options?.legacyInstall === true &&
    setup?.slackOptInScopeGroups === undefined
  )
    return normalizeSlackOptInGroups(SLACK_OPT_IN_SCOPE_GROUPS);
  return [];
}

/**
 * User scopes for personal Slack search (a separate per-user OAuth flow, not
 * the bot install). Shared so the app manifest can request them alongside the
 * search redirect URL; `apps.manifest.update` replaces both wholesale.
 */
export const SLACK_SEARCH_USER_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.files",
] as const;

export const SLACK_SEARCH_CALLBACK_PATH = "/api/slack/search/callback";

/** The personal-search redirect URL on the same public origin as `baseUrl`. */
export function slackSearchRedirectUri(baseUrl: string): string {
  return new URL(SLACK_SEARCH_CALLBACK_PATH, new URL(baseUrl).origin).toString();
}
