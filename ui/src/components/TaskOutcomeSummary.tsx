import { memo, useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileText,
  GitPullRequest,
  ListTree,
} from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";
import { StatusBadge } from "./StatusBadge";
import { Link } from "../lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { cn, relativeTime } from "../lib/utils";
import {
  TASK_OUTCOME_EVIDENCE_DETAIL_LIMIT,
  TASK_OUTCOME_MAX_EVIDENCE,
  TASK_OUTCOME_REQUEST_EXCERPT_LIMIT,
  type TaskOutcomeModel,
} from "../lib/task-outcome-summary";

export interface TaskOutcomeSummaryProps {
  model: TaskOutcomeModel;
  /** React-router location state passthrough for task links. */
  linkState?: unknown;
  projectHref?: string | null;
  /** Overview-hook observation time (ms epoch) for the freshness line. */
  observedAt?: number | null;
  overviewPending?: boolean;
  /** Hook error text: shown, never silently hidden. */
  overviewError?: string | null;
  /** Switches to the technical Delivery tab. Omitted where tabs are hidden. */
  onOpenDelivery?: () => void;
  className?: string;
}

const RESULT_BADGE: Record<
  TaskOutcomeModel["resultKind"],
  { status: string; label: string }
> = {
  merged: { status: "ok", label: "Merged" },
  done_with_code: { status: "ok", label: "Done · code changes recorded" },
  done_noncode: { status: "info", label: "Done · no code delivery" },
  done_unclassified: { status: "unclassified", label: "Marked done" },
  recorded_evidence: { status: "info", label: "Evidence recorded" },
  unknown: { status: "unknown", label: "No recorded result" },
};

const PR_STATE_LABEL: Record<string, string> = {
  draft: "Draft",
  open: "Open",
  closed: "Closed",
  merged: "Merged",
  unknown: "Unknown state",
};

function SectionLabel({ children }: { children: string }) {
  return (
    <dt className="shrink-0 text-xs font-medium text-muted-foreground uppercase tracking-wide w-20">
      {children}
    </dt>
  );
}

function BoundedText({ text }: { text: string }) {
  const truncated =
    text.length > TASK_OUTCOME_EVIDENCE_DETAIL_LIMIT
      ? text.slice(0, TASK_OUTCOME_EVIDENCE_DETAIL_LIMIT)
      : null;
  if (!truncated) {
    return (
      <p className="mt-0.5 text-foreground/90 whitespace-pre-wrap break-words">
        {text}
      </p>
    );
  }
  return (
    <>
      <p className="mt-0.5 text-foreground/90 whitespace-pre-wrap break-words">
        {truncated}…
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:underline">
          Full recorded summary
        </summary>
        <p className="mt-1 max-h-48 overflow-y-auto text-foreground/90 whitespace-pre-wrap break-words">
          {text}
        </p>
      </details>
    </>
  );
}

function EvidenceRow({ item }: { item: TaskOutcomeModel["evidence"][number] }) {
  return (
    <div className="min-w-0">
      <span className="text-xs text-muted-foreground">{item.label} · </span>
      {item.href ? (
        <a
          href={item.href}
          target="_blank"
          rel="noreferrer"
          className="font-medium underline-offset-2 hover:underline"
        >
          {item.title}
        </a>
      ) : (
        <span className="font-medium">{item.title}</span>
      )}
      {item.detail ? <BoundedText text={item.detail} /> : null}
    </div>
  );
}

export const TaskOutcomeSummary = memo(function TaskOutcomeSummary({
  model,
  linkState,
  projectHref,
  observedAt,
  overviewPending,
  overviewError,
  onOpenDelivery,
  className,
}: TaskOutcomeSummaryProps) {
  const badge = RESULT_BADGE[model.resultKind];
  const excerpt = useMemo(() => {
    if (!model.requestedText || !model.requestedTruncated) return null;
    return model.requestedText.slice(0, TASK_OUTCOME_REQUEST_EXCERPT_LIMIT);
  }, [model.requestedText, model.requestedTruncated]);
  const visibleEvidence = model.evidence.slice(0, TASK_OUTCOME_MAX_EVIDENCE);
  const overflowEvidence = model.evidence.slice(TASK_OUTCOME_MAX_EVIDENCE);

  const showContext = model.parent !== null || model.projectName !== null;
  const showRemaining = model.childrenTotal > 0;
  const showEvidenceLinks =
    model.planDocs.length > 0 || model.previews.length > 0;
  const allSubtasksComplete =
    showRemaining &&
    model.openChildren.length === 0 &&
    !model.hasMoreOpenChildren &&
    model.childrenCancelled === 0;

  return (
    <section
      aria-label="Task outcome"
      data-testid="task-outcome-summary"
      className={cn(
        "rounded-lg border border-border bg-card p-3",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold">Outcome</h2>
        {model.currentStatus !== "done" ? <StatusBadge status={model.currentStatus} /> : null}
        <StatusBadge status={badge.status} label={badge.label} />
        {model.workKind === "noncode" ? (
          <span className="text-xs text-muted-foreground">
            (non-code work)
          </span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {overviewError ? (
            <span className="text-destructive">
              Live state unavailable: {overviewError}
            </span>
          ) : overviewPending ? (
            "Loading live state…"
          ) : observedAt ? (
            `Record observed ${relativeTime(new Date(observedAt))}`
          ) : model.lastEventAt ? (
            `Last delivery event ${relativeTime(model.lastEventAt)}`
          ) : null}
        </span>
      </div>

      <dl className="mt-2 space-y-2 text-sm">
        <div className="flex gap-2">
          <SectionLabel>Requested</SectionLabel>
          <dd className="min-w-0 flex-1">
            {!model.requestedText ? (
              <span className="text-muted-foreground">
                No description recorded.
              </span>
            ) : model.requestedTruncated && excerpt ? (
              <>
                <p className="text-foreground/90 whitespace-pre-wrap break-words">
                  {excerpt}…
                </p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:underline">
                    Full request
                  </summary>
                  <div className="mt-1 max-h-64 overflow-y-auto">
                    <MarkdownBody className="text-sm">
                      {model.requestedText}
                    </MarkdownBody>
                  </div>
                </details>
              </>
            ) : (
              <MarkdownBody className="text-sm">
                {model.requestedText}
              </MarkdownBody>
            )}
          </dd>
        </div>

        <div className="flex gap-2">
          <SectionLabel>Result</SectionLabel>
          <dd className="min-w-0 flex-1 space-y-1.5">
            {model.resultNote ? (
              <p className="text-muted-foreground">{model.resultNote}</p>
            ) : null}
            {model.resultKind === "done_with_code" && onOpenDelivery ? (
              <p className="text-xs text-muted-foreground">
                Merge state lives in{" "}
                <button
                  type="button"
                  onClick={onOpenDelivery}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Delivery
                </button>
                .
              </p>
            ) : null}
            {visibleEvidence.map((item, index) => (
              <EvidenceRow key={`${item.label}-${index}`} item={item} />
            ))}
            {overflowEvidence.length > 0 ? (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:underline">
                  {overflowEvidence.length} more work{" "}
                  {overflowEvidence.length === 1 ? "product" : "products"}
                </summary>
                <div className="mt-1 space-y-1.5">
                  {overflowEvidence.map((item, index) => (
                    <EvidenceRow key={`overflow-${item.label}-${index}`} item={item} />
                  ))}
                </div>
              </details>
            ) : null}
          </dd>
        </div>

        {showRemaining ? (
          <div className="flex gap-2">
            <SectionLabel>Remaining</SectionLabel>
            <dd className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-foreground/90">
                <ListTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {model.childrenCompleted} of {model.childrenTotal} subtasks
                complete
                {model.childrenCancelled > 0
                  ? ` · ${model.childrenCancelled} cancelled`
                  : null}
              </p>
              {model.openChildren.length > 0 ||
              model.hasMoreOpenChildren ? (
                <ul className="mt-1 space-y-0.5">
                  {model.openChildren.map((child) => (
                    <li key={child.id} className="min-w-0 truncate">
                      <Link
                        to={createIssueDetailPath(
                          child.identifier ?? child.id,
                        )}
                        state={linkState}
                        className="text-xs underline-offset-2 hover:underline"
                        title={child.title}
                      >
                        {child.identifier ? `${child.identifier} · ` : null}
                        {child.title}
                      </Link>
                    </li>
                  ))}
                  {model.hasMoreOpenChildren ? (
                    <li className="text-xs text-muted-foreground">
                      + more open subtasks — see Related work
                    </li>
                  ) : null}
                </ul>
              ) : allSubtasksComplete ? (
                <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  All subtasks done
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  No open subtasks.
                </p>
              )}
            </dd>
          </div>
        ) : null}

        {model.blockerMessage ? (
          <div className="flex gap-2">
            <SectionLabel>Blocker</SectionLabel>
            <dd className="min-w-0 flex-1">
              <p className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                <span>{model.blockerMessage}</span>
              </p>
              {model.blockerOwnerLabel || model.blockerNextAction ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {model.blockerOwnerLabel
                    ? `Owner: ${model.blockerOwnerLabel}`
                    : null}
                  {model.blockerOwnerLabel && model.blockerNextAction
                    ? " · "
                    : null}
                  {model.blockerNextAction}
                </p>
              ) : null}
              {model.blockerIssue ? (
                <Link
                  to={createIssueDetailPath(
                    model.blockerIssue.identifier ?? model.blockerIssue.id,
                  )}
                  state={linkState}
                  className="mt-0.5 inline-block text-xs underline-offset-2 hover:underline"
                  title={model.blockerIssue.title}
                >
                  {model.blockerIssue.identifier
                    ? `${model.blockerIssue.identifier} · `
                    : null}
                  {model.blockerIssue.title}
                </Link>
              ) : null}
            </dd>
          </div>
        ) : null}

        <div className="flex gap-2">
          <SectionLabel>Pull reqs</SectionLabel>
          <dd className="min-w-0 flex-1">
            {!model.prStateAvailable ? (
              <p className="text-xs text-muted-foreground">
                Pull request state unavailable — live summary not loaded.
              </p>
            ) : model.pullRequests.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No pull requests recorded.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {model.pullRequests.map((pr, index) => {
                  const label =
                    pr.number !== null
                      ? `#${pr.number}`
                      : (pr.repository ?? "PR");
                  const stateLabel = PR_STATE_LABEL[pr.state] ?? pr.state;
                  const content = (
                    <>
                      <GitPullRequest className="h-3 w-3" />
                      <span className="max-w-44 truncate">
                        {pr.repository && pr.number !== null
                          ? `${pr.repository} ${label}`
                          : label}
                      </span>
                      <span className="text-muted-foreground">
                        · {stateLabel}
                        {pr.stale ? " · stale" : ""}
                      </span>
                    </>
                  );
                  const chipClass =
                    "inline-flex max-w-full items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs";
                  return (
                    <li key={`${pr.repository}-${pr.number}-${pr.url}-${index}`}>
                      {pr.url ? (
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noreferrer"
                          className={cn(chipClass, "hover:bg-accent/50")}
                        >
                          {content}
                        </a>
                      ) : (
                        <span className={chipClass}>{content}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </dd>
        </div>

        {showContext ? (
          <div className="flex gap-2">
            <SectionLabel>Context</SectionLabel>
            <dd className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {model.parent ? (
                <span className="min-w-0">
                  <span className="text-muted-foreground">Parent · </span>
                  <Link
                    to={createIssueDetailPath(
                      model.parent.identifier ?? model.parent.id,
                    )}
                    state={linkState}
                    className="underline-offset-2 hover:underline"
                    title={model.parent.title}
                  >
                    {model.parent.identifier
                      ? `${model.parent.identifier} · `
                      : null}
                    {model.parent.title}
                  </Link>
                </span>
              ) : null}
              {model.projectName ? (
                <span className="min-w-0">
                  <span className="text-muted-foreground">Project · </span>
                  {projectHref ? (
                    <Link
                      to={projectHref}
                      className="underline-offset-2 hover:underline"
                    >
                      {model.projectName}
                    </Link>
                  ) : (
                    <span>{model.projectName}</span>
                  )}
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}

        {showEvidenceLinks ? (
          <div className="flex gap-2">
            <SectionLabel>Evidence</SectionLabel>
            <dd className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1 text-xs">
              {model.planDocs.map((doc) => (
                <a
                  key={doc.key}
                  href={doc.hash}
                  className="inline-flex min-w-0 items-center gap-1 underline-offset-2 hover:underline"
                >
                  <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{doc.title}</span>
                </a>
              ))}
              {model.previews.map((preview) => (
                <a
                  key={preview.href}
                  href={preview.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 underline-offset-2 hover:underline"
                >
                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{preview.title}</span>
                </a>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
});
