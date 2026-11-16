import {
  SLACK_DEFAULT_BOT_SCOPES,
  SLACK_OPT_IN_BOT_SCOPE_GROUPS,
  SLACK_OPT_IN_SCOPE_GROUPS,
  type SlackOptInScopeGroup,
} from "@paperclipai/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  sameSlackOptInGroupSet,
  slackOptInGroupStatus,
  type SlackOptInGroupStatus,
} from "./slack-opt-in-state";

export type SlackOptInSetupMethod =
  | "managed"
  | "automatic"
  | "manual"
  | "existing";

const statusLabels: Record<SlackOptInGroupStatus, string> = {
  off: "Off",
  requested: "Requested — reinstall to activate",
  enabled: "Enabled",
  installed: "Enabled — stays on until you reinstall",
};

/** Before any install a chosen group is part of the upcoming request, not a pending reconnect. */
const preInstallRequestLabel = "Requested — applied at install";

/**
 * TECH-7988 / TECH-8783: per-agent Slack permission opt-ins.
 *
 * Direct messages are standard across all agents. The remaining two groups
 * (channel management and file upload) are off by default because they require
 * scopes rated above Low risk, so enabling either group may require Slack
 * workspace admin approval.
 *
 * This component owns the permission-change reconnect notice: callers must not render a second
 * one for permission changes next to it.
 */
export function SlackScopeOptIns({
  value,
  installed,
  setupMethod,
  manifestErrorCode,
  disabled,
  pending,
  onChange,
  onReconnect,
  idPrefix = "slack-scope",
}: {
  /** The groups the operator has requested (the saved or draft selection). */
  value: readonly SlackOptInScopeGroup[];
  /** Groups the live installation holds; undefined when no app is installed. */
  installed?: readonly SlackOptInScopeGroup[];
  /** Selects the reconnect wording: managed reinstalls, own-app retries first. */
  setupMethod?: SlackOptInSetupMethod;
  /** Server evidence that even a reverted request still needs to be pushed. */
  manifestErrorCode?: string | null;
  disabled?: boolean;
  /** A save is in flight. */
  pending?: boolean;
  onChange: (groups: SlackOptInScopeGroup[]) => void;
  /** Offered when a saved change still needs a manifest update and reinstall. */
  onReconnect?: () => void;
  /** Prefix for the control ids; lets two instances coexist on one page. */
  idPrefix?: string;
}) {
  const requested = SLACK_OPT_IN_SCOPE_GROUPS.filter((group) =>
    value.includes(group),
  );
  const installedGroups = installed
    ? SLACK_OPT_IN_SCOPE_GROUPS.filter((group) => installed.includes(group))
    : undefined;
  // The server treats a requested-vs-installed difference as pending. Only
  // compute it once an install exists; a draft has nothing to reconnect.
  const pendingChange = Boolean(installed) &&
    !sameSlackOptInGroupSet(requested, installedGroups!);
  const managed = setupMethod === "managed";
  const controlsDisabled = Boolean(disabled || pending);
  return (
    <fieldset className="space-y-3" disabled={controlsDisabled}>
      <legend className="text-sm font-semibold">Extra Slack permissions</legend>
      <p className="text-sm text-muted-foreground">
        Off by default. The install requests standard permissions including direct
        messages ({SLACK_DEFAULT_BOT_SCOPES.length} scopes). Enabling either of these
        remaining groups may require Slack workspace admin approval. Reading, replying,
        direct messages, and channel history work without these groups.
      </p>
      <div className="space-y-3">
        {SLACK_OPT_IN_SCOPE_GROUPS.map((group) => {
          const definition = SLACK_OPT_IN_BOT_SCOPE_GROUPS[group];
          const checked = requested.includes(group);
          const status = slackOptInGroupStatus(group, requested, installedGroups);
          const helpId = `${idPrefix}-${group}-help`;
          return (
            <div key={group} className="flex items-start gap-2 text-sm">
              <Checkbox
                id={`${idPrefix}-${group}`}
                checked={checked}
                disabled={controlsDisabled}
                aria-describedby={`${helpId} ${idPrefix}-${group}-status`}
                onCheckedChange={(next) =>
                  onChange(
                    next === true
                      ? SLACK_OPT_IN_SCOPE_GROUPS.filter(
                          (item) => item === group || requested.includes(item),
                        )
                      : requested.filter((item) => item !== group),
                  )
                }
              />
              <div className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={`${idPrefix}-${group}`} className="font-medium">
                    {definition.label}
                  </label>
                  <span
                    id={`${idPrefix}-${group}-status`}
                    data-slack-opt-in-status={status}
                    className={
                      status === "off"
                        ? "text-xs text-muted-foreground"
                        : "text-xs font-medium"
                    }
                  >
                    {status === "requested" && installedGroups === undefined
                      ? preInstallRequestLabel
                      : statusLabels[status]}
                  </span>
                </div>
                <p id={helpId} className="text-muted-foreground">
                  {definition.description}{" "}
                  <span className="font-mono text-xs">
                    ({definition.scopes.join(", ")})
                  </span>
                </p>
                {status === "requested" && (
                  <p className="text-muted-foreground">
                    {installedGroups === undefined
                      ? "Slack grants this when you install the app."
                      : "Not active yet. Slack must grant this after you reinstall."}
                  </p>
                )}
                {status === "installed" && (
                  <p className="text-muted-foreground">
                    Still active because the app is installed. Reinstalling
                    removes it.
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-sm text-muted-foreground">
        Each extra group is not Low risk, so your Slack administrators may need
        to approve this agent&apos;s install. Until then the agent keeps its
        current permissions.
      </p>
      {(pendingChange || manifestErrorCode === "slack_permissions_update_pending") && (
        <div role="status" className="space-y-2 rounded-lg border border-border bg-muted p-3 text-sm">
          <p>
            {!pendingChange
              ? "The Slack app configuration still needs to be updated. Apply the restored manifest before reconnecting, even though your selection matches the live grant."
              : managed
              ? "Your selection differs from what Slack granted. Reinstall this agent's app to apply it."
              : "Your selection differs from what Slack granted. Update the app configuration, then reinstall it in Slack, to apply it."}
          </p>
          {onReconnect && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={controlsDisabled}
              onClick={onReconnect}
            >
              {managed ? "Reinstall in Slack" : "Update app and reinstall"}
            </Button>
          )}
        </div>
      )}
    </fieldset>
  );
}
