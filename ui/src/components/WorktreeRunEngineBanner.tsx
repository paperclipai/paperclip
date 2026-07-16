import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Fingerprint, Pause, Play } from "lucide-react";
import type {
  WorktreeRunEngineStatus,
  WorktreeRunExecutionActivationState,
} from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

function formatActivationTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function shortIdentity(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 8 ? value.slice(0, 8) : value;
}

type SuppressionCopy = { headline: string; detail: string };

/**
 * Human-readable copy for each fail-closed reason. `instance_id_mismatch` is
 * handled separately because it interpolates the two identities.
 */
function suppressionCopy(
  activation: Extract<WorktreeRunExecutionActivationState, { armed: false }>,
  instanceNonce: string | null,
): SuppressionCopy {
  switch (activation.reason) {
    case "flag_disabled":
      return {
        headline: "Run engine off",
        detail:
          "The scheduler will not execute tasks in this worktree. Inherited tasks stay parked. Turn on “Run tasks in this worktree” to arm execution.",
      };
    case "missing_cutoff":
      return {
        headline: "Execution suppressed — missing activation cutoff",
        detail:
          "This setting has no activation cutoff, so no tasks run automatically. Toggle it off and back on to arm execution for tasks created here.",
      };
    case "missing_instance_id":
      return {
        headline: "Execution suppressed — no instance identity",
        detail:
          "This worktree has not stamped an instance identity yet, so execution fails closed. Toggle off and back on to arm execution.",
      };
    case "instance_id_mismatch":
      return {
        headline: "Toggle inactive — bound to another instance",
        detail: `This setting was armed against instance ${shortIdentity(
          activation.activationInstanceId,
        )} and copied here; this boot is ${shortIdentity(
          instanceNonce,
        )}. No tasks run automatically. Toggle off and back on to re-arm execution for this instance.`,
      };
    case "settings_read_error":
      return {
        headline: "Execution suppressed — settings unavailable",
        detail:
          "The run engine could not read its settings, so it fails closed and no tasks run automatically.",
      };
    case "not_worktree_runtime":
    default:
      return {
        headline: "Execution suppressed",
        detail: "No tasks run automatically in this instance.",
      };
  }
}

function QuarantineLine({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {count} inherited {count === 1 ? "run was" : "runs were"} quarantined at seed time and remain
      inactive. Cleared wakeups and monitors are not retained.
    </p>
  );
}

function IdentityLine({
  activation,
  instanceNonce,
}: {
  activation: WorktreeRunExecutionActivationState;
  instanceNonce: string | null;
}) {
  const matches =
    activation.armed || activation.activationInstanceId === instanceNonce;
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Fingerprint className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        Bound to <span className="font-mono text-foreground">{shortIdentity(activation.activationInstanceId)}</span>
      </span>
      <span aria-hidden="true">·</span>
      <span>
        this boot <span className="font-mono text-foreground">{shortIdentity(instanceNonce)}</span>
      </span>
      <span
        className={cn(
          "rounded-md border px-1.5 py-0.5 text-(length:--text-micro) font-medium",
          matches
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        )}
      >
        {matches ? "matches" : "mismatch"}
      </span>
    </p>
  );
}

/**
 * PAP-14312: persistent boot-truth for the worktree run engine. Renders nothing
 * outside a worktree runtime. Otherwise it reports whether the scheduler is armed
 * or suppressed (and why), which instance identity the toggle is bound to, and how
 * many inherited runs were quarantined at seed time.
 *
 * `variant="strip"` is a single dense line for the app shell; `variant="detail"`
 * is the fuller block used on the Experimental Settings page.
 */
export function WorktreeRunEngineBanner({
  variant = "detail",
  status: statusOverride,
}: {
  variant?: "strip" | "detail";
  /** Injected in tests/stories to bypass the network query. */
  status?: WorktreeRunEngineStatus;
}) {
  const query = useQuery({
    queryKey: queryKeys.instance.worktreeRunEngine,
    queryFn: () => instanceSettingsApi.getWorktreeRunEngine(),
    enabled: statusOverride === undefined,
  });

  const status = statusOverride ?? query.data;
  if (!status || !status.inWorktree) return null;

  const { activation, instanceNonce, quarantinedRunCount } = status;
  const armed = activation.armed;

  if (variant === "strip") {
    return (
      <div
        role="status"
        data-testid="worktree-run-engine-strip"
        className={cn(
          "flex items-center gap-2 border-b px-3 py-1.5 text-xs",
          armed
            ? "border-emerald-500/30 bg-emerald-500/5 text-foreground"
            : "border-amber-500/30 bg-amber-500/5 text-foreground",
        )}
      >
        {armed ? (
          <Play className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
        ) : (
          <Pause className="h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">
          <span className="font-medium">Run engine</span>{" "}
          {armed ? (
            <>armed since {formatActivationTimestamp(activation.cutoff)}</>
          ) : (
            <>{suppressionCopy(activation, instanceNonce).headline.toLowerCase()}</>
          )}
          {quarantinedRunCount > 0 ? (
            <span className="text-muted-foreground">
              {" · "}
              {quarantinedRunCount} inherited {quarantinedRunCount === 1 ? "run" : "runs"} inactive
            </span>
          ) : null}
        </span>
      </div>
    );
  }

  if (armed) {
    return (
      <div
        role="status"
        data-testid="worktree-run-engine-banner"
        className="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-sm text-foreground"
      >
        <div className="flex items-center gap-2">
          <Play className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <span>
            Run engine armed since{" "}
            <span className="font-medium">{formatActivationTimestamp(activation.cutoff)}</span>. Tasks
            created after this run automatically.
          </span>
        </div>
        <IdentityLine activation={activation} instanceNonce={instanceNonce} />
        <QuarantineLine count={quarantinedRunCount} />
      </div>
    );
  }

  const copy = suppressionCopy(activation, instanceNonce);
  // The identity binding is only meaningful when it's the reason execution is
  // suppressed; showing a "mismatch" badge on a plainly-off engine reads as noise.
  const showIdentity = activation.reason === "instance_id_mismatch";
  return (
    <div
      role="status"
      data-testid="worktree-run-engine-banner"
      className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
        <div className="space-y-0.5">
          <p className="font-medium text-foreground">{copy.headline}</p>
          <p className="text-muted-foreground">{copy.detail}</p>
        </div>
      </div>
      {showIdentity ? <IdentityLine activation={activation} instanceNonce={instanceNonce} /> : null}
      <QuarantineLine count={quarantinedRunCount} />
    </div>
  );
}
