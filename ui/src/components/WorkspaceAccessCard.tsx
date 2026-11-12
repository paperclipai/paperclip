import { ExternalLink, Loader2, Play, ScrollText, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "../lib/utils";
import type { WorkspaceAccessState } from "../lib/workspace-access-state";

/**
 * Workspace access surface (PAP-17572).
 *
 * One card per workspace that names the state, the cause, and the single safe
 * next action. It replaces the previous behavior where a cloned workspace whose
 * database was missing still rendered a plain "Open" link and answered with
 * "invalid email or password".
 */

/**
 * Badge tones come from the semantic status token layer, so a theme change moves
 * these states with every other status surface. `ready` reuses the "done" tone
 * and `degraded` the "todo" (amber) tone; the icon variants are the contrast-
 * corrected pair the token layer already tunes per mode.
 */
type ActiveWorkspaceAccessState = Exclude<WorkspaceAccessState["state"], "stopped">;

const STATE_BADGE_CLASSES: Record<ActiveWorkspaceAccessState, string> = {
  provisioning: "border-border text-muted-foreground",
  validating: "border-border text-muted-foreground",
  ready: "border-(--status-task-done) text-(--status-task-icon-done)",
  degraded: "border-(--status-task-todo) text-(--status-task-icon-todo)",
  repairing: "border-border text-muted-foreground",
  failed: "border-destructive/50 text-destructive",
};

const STATE_LABELS: Record<ActiveWorkspaceAccessState, string> = {
  provisioning: "Provisioning",
  validating: "Validating clone",
  ready: "Ready",
  degraded: "Degraded",
  repairing: "Repairing",
  failed: "Failed",
};

const ACTION_ICONS = {
  open: ExternalLink,
  start: Play,
  repair: Wrench,
  view_logs: ScrollText,
  wait: Loader2,
} as const;

export function WorkspaceAccessCard({
  access,
  isBusy,
  onOpen,
  onStart,
  onRepair,
  onViewLogs,
  errorMessage,
}: {
  access: WorkspaceAccessState;
  isBusy?: boolean;
  onOpen: () => void;
  onStart: () => void;
  onRepair: () => void;
  onViewLogs: () => void;
  errorMessage?: string | null;
}) {
  const Icon = ACTION_ICONS[access.action.kind];
  const isWaiting = access.action.kind === "wait";
  const handlers: Record<WorkspaceAccessState["action"]["kind"], () => void> = {
    open: onOpen,
    start: onStart,
    repair: onRepair,
    view_logs: onViewLogs,
    wait: () => undefined,
  };
  const SecondaryNoticeIcon = access.secondaryNotice
    ? ACTION_ICONS[access.secondaryNotice.action.kind]
    : null;

  return (
    <Card data-testid="workspace-access-card" data-state={access.state}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{access.title}</CardTitle>
          {access.state !== "stopped" ? (
            <span
              data-testid="workspace-access-badge"
              className={cn(
                "inline-flex items-center rounded-full border bg-background px-2.5 py-1 text-xs",
                STATE_BADGE_CLASSES[access.state],
              )}
            >
              {(access.state === "repairing" || access.state === "provisioning") && (
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              )}
              {STATE_LABELS[access.state]}
            </span>
          ) : null}
        </div>
        <CardDescription>{access.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={access.action.kind === "open" ? "default" : "outline"}
            disabled={isWaiting || isBusy}
            onClick={handlers[access.action.kind]}
          >
            {isBusy && !isWaiting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Icon className={cn("mr-2 h-4 w-4", isWaiting && "animate-spin")} />
            )}
            {access.action.label}
          </Button>
          {access.state === "ready" && !access.handoffAvailable ? (
            <span className="text-xs text-muted-foreground">
              Signs in with the snapshot-local credentials captured when this clone was made.
            </span>
          ) : null}
          {access.state === "ready" && access.handoffAvailable ? (
            <span className="text-xs text-muted-foreground">
              Uses a single-use login handoff — no password needed.
            </span>
          ) : null}
        </div>
        {errorMessage ? (
          <p data-testid="workspace-access-error" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        {access.secondaryNotice && SecondaryNoticeIcon ? (
          <div data-testid="workspace-access-secondary-notice" className="flex flex-col gap-1.5 text-sm">
            <p className="font-medium text-destructive">{access.secondaryNotice.title}</p>
            <p className="text-muted-foreground">{access.secondaryNotice.description}</p>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto w-fit p-0"
              disabled={isBusy}
              onClick={handlers[access.secondaryNotice.action.kind]}
            >
              <SecondaryNoticeIcon className="mr-2 h-4 w-4" />
              {access.secondaryNotice.action.label}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
