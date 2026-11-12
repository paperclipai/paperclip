import { Clock, EyeOff, ShieldX, UserCog } from "lucide-react";
import {
  describeIssueWriteDenial,
  type IssueWriteDenialCode,
  type IssueWriteDenialContext,
  type IssueWriteDenialTone,
} from "@paperclipai/shared";
import { cn } from "../lib/utils";

/**
 * Renders actionable copy for a denied issue write (the open cross-task write design (failure UX)).
 *
 * Cross-issue writes are open by default, so the walls that remain are rare —
 * which is exactly why hitting one has to be self-explaining. A real incident
 * burned a full detour discovering a workaround behind an opaque 403; this notice always
 * states the boundary that fired, who *can* act, and the sanctioned path.
 *
 * Copy comes from the shared `describeIssueWriteDenial` contract, so the words a
 * human reads here match the API error body an agent reads.
 */

const TONE_ICONS: Record<IssueWriteDenialTone, typeof ShieldX> = {
  boundary: ShieldX,
  lock: Clock,
  cap: Clock,
  attribution: UserCog,
};

const TONE_CLASSES: Record<IssueWriteDenialTone, { surface: string; icon: string; action: string }> = {
  // A real authorization wall — the strongest signal.
  boundary: {
    surface:
      "border-red-300/70 bg-red-50/90 text-red-950 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100",
    icon: "text-red-600 dark:text-red-300",
    action: "text-red-800 dark:text-red-200",
  },
  // Run-lifecycle machinery that clears on its own; not a permission problem.
  lock: {
    surface:
      "border-amber-300/70 bg-amber-50/90 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
    icon: "text-amber-600 dark:text-amber-300",
    action: "text-amber-800 dark:text-amber-200",
  },
  // A rate backstop — the write was allowed, the budget was not.
  cap: {
    surface:
      "border-amber-300/70 bg-amber-50/90 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
    icon: "text-amber-600 dark:text-amber-300",
    action: "text-amber-800 dark:text-amber-200",
  },
  // Rejected attribution: the write is fine, the claimed identity is not.
  // Neutral surface, but the action lines stay near-foreground — on a muted
  // background `text-muted-foreground` drops below comfortable contrast.
  attribution: {
    surface:
      "border-border bg-muted/60 text-foreground dark:border-border dark:bg-muted/30",
    icon: "text-muted-foreground",
    action: "text-foreground/80",
  },
};

/** Codes whose primary failure is that the target is simply not visible. */
const VISIBILITY_CODES: ReadonlySet<IssueWriteDenialCode> = new Set([
  "issue_write_not_visible",
]);

export function IssueWriteDenialNotice({
  code,
  context,
  className,
}: {
  code: IssueWriteDenialCode;
  context?: IssueWriteDenialContext;
  className?: string;
}) {
  const copy = describeIssueWriteDenial(code, context ?? {});
  const tone = TONE_CLASSES[copy.tone];
  const Icon = VISIBILITY_CODES.has(code) ? EyeOff : TONE_ICONS[copy.tone];

  return (
    <div
      role="status"
      data-testid="issue-write-denial-notice"
      data-denial-code={copy.code}
      data-denial-tone={copy.tone}
      className={cn("rounded-md border px-3 py-2.5 text-sm shadow-sm", tone.surface, className)}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", tone.icon)} aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium leading-5">
            {copy.title}
            {/* Naming the boundary is obligation 1 of plan §6. */}
            <span className="ml-1.5 font-normal opacity-80">({copy.boundary})</span>
          </p>
          <p className="leading-5">{copy.description}</p>
          {/* Inline flow, not flex rows: a flex `dd` is an unbreakable line box,
              so a long value drops whole and orphans its label. Inline keeps the
              label and the first words of the value together at every width. */}
          <dl className={cn("space-y-0.5 text-xs leading-5", tone.action)}>
            <div className="min-w-0">
              <dt className="inline font-medium">Who can act:</dt>{" "}
              <dd className="inline">{copy.whoCanAct}</dd>
            </div>
            <div className="min-w-0">
              <dt className="inline font-medium">Try this:</dt>{" "}
              <dd className="inline">{copy.sanctionedPath}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
