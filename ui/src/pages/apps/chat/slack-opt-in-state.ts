import {
  SLACK_OPT_IN_SCOPE_GROUPS,
  slackOptInGroupsChanged,
  type SlackOptInScopeGroup,
} from "@paperclipai/shared";

/**
 * The subset of a Slack endpoint that decides its permission opt-ins. Kept
 * structural so the setup wizard can pass a draft and the detail page a saved
 * endpoint.
 */
export type SlackOptInEndpointLike = {
  /**
   * Set once Slack has installed the bot. A draft can carry empty opt-in fields
   * -- creation always writes them explicitly -- so this is the only reliable
   * "a live installation exists" signal.
   */
  botExternalId?: string | null;
  setup?: {
    // No excess-property check: callers pass a full setup object (or a draft
    // with extra keys), and this helper only reads the opt-in fields.
    slackOptInScopeGroups?: readonly SlackOptInScopeGroup[];
    slackInstalledOptInScopeGroups?: readonly SlackOptInScopeGroup[];
    [key: string]: unknown;
  } | null;
};

export type SlackOptInUiState = {
  /** Groups the checkboxes show as chosen: the saved request or the full legacy grant. */
  requested: SlackOptInScopeGroup[];
  /** Groups the live installation holds. Undefined before an app is installed. */
  installed: SlackOptInScopeGroup[] | undefined;
  /** A pre-TECH-7988 installation that carries neither opt-in field. */
  legacyInstall: boolean;
  /** The saved request differs from the live grant, so a reinstall is required. */
  pendingChange: boolean;
};

/**
 * TECH-7988 / TECH-8783: derive what the opt-in controls show.
 *
 * A pre-TECH-7988 installation holds the full grant and has no saved request.
 * Showing it as "all off, reconnect to change" would be false: nothing is
 * pending until an operator actually edits the groups, and every group is
 * already enabled. Both sets therefore start at the full grant for a legacy
 * installation (now the remaining opt-in groups, with direct messages standard
 * in default scopes), which also makes the first edit a real, explicit choice.
 */
export function slackOptInUiState(
  endpoint: SlackOptInEndpointLike | null | undefined,
): SlackOptInUiState {
  const setup = endpoint?.setup;
  const hasInstall = Boolean(endpoint?.botExternalId);
  const legacyInstall =
    hasInstall &&
    setup?.slackOptInScopeGroups === undefined &&
    setup?.slackInstalledOptInScopeGroups === undefined;
  const fullGrant = [...SLACK_OPT_IN_SCOPE_GROUPS];
  return {
    requested: legacyInstall
      ? fullGrant
      : [...(setup?.slackOptInScopeGroups ?? [])],
    installed: !hasInstall
      ? undefined
      : legacyInstall
        ? fullGrant
        : [...(setup?.slackInstalledOptInScopeGroups ?? [])],
    legacyInstall,
    // The shared helper owns the legacy rule, so the prompt can never disagree
    // with the server's own notion of a pending change.
    pendingChange: hasInstall && slackOptInGroupsChanged(setup, { legacyInstall }),
  };
}

/** Set equality for group lists; order and duplicates do not matter. */
export function sameSlackOptInGroupSet(
  a: readonly SlackOptInScopeGroup[],
  b: readonly SlackOptInScopeGroup[],
): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((group) => right.has(group));
}

export type SlackOptInGroupStatus =
  /** Neither requested nor installed. */
  | "off"
  /** Requested for an install that has not landed yet. */
  | "requested"
  /** Requested and installed: live now. */
  | "enabled"
  /** Installed but no longer requested: live until the next reinstall drops it. */
  | "installed";

/**
 * Per-group state. `installed === undefined` means no app is installed yet, so
 * a chosen group is only a request for the upcoming install, not a pending
 * reconnect.
 */
export function slackOptInGroupStatus(
  group: SlackOptInScopeGroup,
  requested: readonly SlackOptInScopeGroup[],
  installed: readonly SlackOptInScopeGroup[] | undefined,
): SlackOptInGroupStatus {
  const isRequested = requested.includes(group);
  const isInstalled = installed?.includes(group) ?? false;
  if (isRequested && isInstalled) return "enabled";
  if (isRequested) return "requested";
  if (isInstalled) return "installed";
  return "off";
}
