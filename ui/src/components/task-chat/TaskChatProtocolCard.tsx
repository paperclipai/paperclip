import { useContext, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleHelp,
  Clock3,
  ExternalLink,
  FileCode2,
  FileText,
  GitBranch,
  Loader2,
  PackageCheck,
  ShieldCheck,
  TerminalSquare,
  X,
} from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { MentionOption } from "@/components/MarkdownEditor";
import { WorkspaceFileLink } from "@/components/WorkspaceFileLink";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  clearDraft,
  loadStructuredDraft,
  saveStructuredDraft,
} from "@/lib/composer-draft";
import type {
  TaskChatProtocolItem,
  TaskChatProtocolStep,
  TaskChatProviderActivityItem,
  TaskChatRuntimeRequestDecision,
  TaskChatRuntimeRequestItem,
  TaskChatWorkspaceChangeItem,
  TaskChatWorkspaceFileItem,
} from "./task-chat-model";
import { QuestionForm, QuestionResponseSummary } from "./QuestionForm";
import { TaskChatComposerTakeoverHeader, TaskChatRequestHistoryContext } from "./TaskChatComposerTakeoverContext";
import { RichWorkProductCard } from "./RichWorkProductCard";
import { planPreviewContent, TaskChatPlanPreviewCard } from "./TaskChatPlanPreviewCard";
import { TaskChatDiffCounts, TaskChatDiffView } from "./TaskChatDiffView";
import { parseUnifiedDiffLines } from "./diff-lines";
import { useArtifactsV1Enabled } from "@/hooks/useArtifactsV1Enabled";
import { ArtifactFileRow, ArtifactRow, fileRowSourceFromAttachment, fileRowSourceFromWorkProduct, subjectFromAttachment, subjectFromDocumentSummary, subjectFromWorkProduct, workProductStateBadge } from "@/components/artifacts/v1";

export interface TaskChatProtocolCardProps {
  item: TaskChatProtocolItem;
  presentation?: "timeline" | "takeover";
  draftKey?: string;
  imageUploadHandler?: (file: File) => Promise<string>;
  mentions?: MentionOption[];
  onRuntimeRequestDecision?: (
    item: TaskChatRuntimeRequestItem,
    decision: TaskChatRuntimeRequestDecision,
  ) => void | Promise<void>;
}

const FAMILY_ICON = {
  plan: GitBranch,
  plan_proposal: FileText,
  tool_execution: TerminalSquare,
  research: FileText,
  delegation: Bot,
  model_identity: Bot,
  context: PackageCheck,
  artifact: PackageCheck,
  review: ShieldCheck,
  hook: GitBranch,
  memory: FileText,
  safety: ShieldCheck,
  terminal: TerminalSquare,
  wait: Clock3,
  verification: CircleCheck,
  provider_notice: AlertTriangle,
} as const;

function statusTone(status: string): string {
  if (
    ["failed", "blocked", "denied", "cancelled", "interrupted"].includes(status)
  )
    return "text-destructive";
  if (["running", "pending", "in_progress", "waiting"].includes(status))
    return "text-(--status-agent-running)";
  if (["completed", "done", "succeeded", "passed", "resolved"].includes(status))
    return "text-(--status-task-icon-done)";
  return "text-muted-foreground";
}

function StatusIcon({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  if (["running", "pending", "in_progress", "waiting"].includes(status)) {
    return (
      <Loader2
        aria-hidden
        className={cn("h-4 w-4 animate-spin", statusTone(status), className)}
      />
    );
  }
  if (
    ["failed", "blocked", "denied", "cancelled", "interrupted"].includes(status)
  ) {
    return (
      <X aria-hidden className={cn("h-4 w-4", statusTone(status), className)} />
    );
  }
  if (
    ["completed", "done", "succeeded", "passed", "resolved"].includes(status)
  ) {
    return (
      <Check
        aria-hidden
        className={cn("h-4 w-4", statusTone(status), className)}
      />
    );
  }
  return (
    <Circle
      aria-hidden
      className={cn("h-4 w-4", statusTone(status), className)}
    />
  );
}

function CardShell({
  icon: Icon,
  title,
  status,
  summary,
  children,
  testId,
  presentation = "timeline",
}: {
  icon: typeof Circle;
  title: string;
  status: string | null;
  summary?: string;
  children?: React.ReactNode;
  testId: string;
  presentation?: "timeline" | "takeover";
}) {
  const titleRow = (
    <div className="flex min-w-0 items-center gap-2">
      <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
      <strong className="min-w-0 truncate text-sm font-medium text-foreground">
        {title}
      </strong>
      {status && status !== "pending" ? (
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 text-xs capitalize",
            statusTone(status),
          )}
        >
          <StatusIcon status={status} className="h-3.5 w-3.5" />
          {status.replaceAll("_", " ")}
        </span>
      ) : null}
    </div>
  );

  if (presentation === "takeover") {
    return (
      <article className="overflow-hidden" data-testid={testId}>
        <TaskChatComposerTakeoverHeader>
          {titleRow}
        </TaskChatComposerTakeoverHeader>
        {summary ? (
          <p
            className={cn(
              "text-sm text-muted-foreground",
              Boolean(children) && "mb-3",
            )}
          >
            {summary}
          </p>
        ) : null}
        {children}
      </article>
    );
  }

  return (
    <article
      className={cn(
        "overflow-hidden",
        presentation === "timeline" &&
          "rounded-md border border-border bg-card/60",
      )}
      data-testid={testId}
    >
      <header className="flex min-w-0 items-start gap-2 px-3 py-2.5">
        <Icon
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <strong className="text-sm font-medium text-foreground">
              {title}
            </strong>
            {status ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-xs capitalize",
                  statusTone(status),
                )}
              >
                <StatusIcon status={status} className="h-3.5 w-3.5" />
                {status.replaceAll("_", " ")}
              </span>
            ) : null}
          </div>
          {summary ? (
            <p className="mt-1 text-sm text-muted-foreground">{summary}</p>
          ) : null}
        </div>
      </header>
      {children ? (
        <div className="border-t border-border/70 px-3 py-2.5">{children}</div>
      ) : null}
    </article>
  );
}

function PlanSteps({ steps }: { steps: TaskChatProtocolStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="flex flex-col gap-1.5" aria-label="Plan steps">
      {steps.map((step) => (
        <li key={step.id} className="flex items-start gap-2 text-sm">
          <StatusIcon status={step.status} className="mt-0.5 shrink-0" />
          <span
            className={cn(
              "min-w-0 flex-1",
              step.status === "completed" &&
                "text-muted-foreground line-through",
            )}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A harness's proposed plan. While it streams it is the live plan card; once
 * complete, the synchronized Plan document and its approval card carry it, so
 * the turn keeps only a one-line record.
 */
function PlanProposalCard({ item }: { item: TaskChatProviderActivityItem }) {
  if (item.status === "running") {
    return <TaskChatPlanPreviewCard source={{ kind: "live", activity: item }} testId="task-chat-plan-proposal" />;
  }
  const title = item.output ? planPreviewContent(item.output).title : "Plan";
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-sm text-muted-foreground" data-testid="task-chat-plan-proposal">
      <FileText aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">Proposed a plan · <span className="text-foreground">{title}</span></span>
    </div>
  );
}

function ProviderActivityCard({
  item,
}: {
  item: TaskChatProviderActivityItem;
}) {
  if (item.family === "plan_proposal") return <PlanProposalCard item={item} />;
  const Icon = FAMILY_ICON[item.family];
  const hasDetails =
    item.details.length > 0 ||
    item.links.length > 0 ||
    item.children.length > 0 ||
    Boolean(item.output);
  return (
    <CardShell
      icon={Icon}
      title={item.title}
      status={item.status}
      summary={item.summary}
      testId={`task-chat-provider-${item.family}`}
    >
      {item.steps.length > 0 ? <PlanSteps steps={item.steps} /> : null}
      {item.children.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Delegated agents">
          {item.children.map((child) => (
            <li
              key={child.id}
              className="rounded-sm bg-muted/40 px-2.5 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <StatusIcon status={child.status} className="shrink-0" />
                <strong className="font-medium">{child.title}</strong>
                <span
                  className={cn(
                    "ml-auto text-xs capitalize",
                    statusTone(child.status),
                  )}
                >
                  {child.status}
                </span>
              </div>
              {child.metadata ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {child.metadata}
                </p>
              ) : null}
              {child.summary ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  {child.summary}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {item.links.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Research sources">
          {item.links.map((link) => (
            <li key={link.href}>
              <a
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                href={link.href}
                target="_blank"
                rel="noreferrer"
              >
                {link.label}
                <ExternalLink aria-hidden className="h-3.5 w-3.5" />
              </a>
              {link.description ? (
                <p className="text-xs text-muted-foreground">
                  {link.description}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {hasDetails ? (
        <details
          className={cn(
            (item.steps.length > 0 ||
              item.links.length > 0 ||
              item.children.length > 0) &&
              "mt-2",
          )}
        >
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground">
            <ChevronDown aria-hidden className="h-3.5 w-3.5" /> Details
          </summary>
          {item.details.length > 0 ? (
            <dl className="mt-2 flex min-w-0 flex-col gap-1.5 text-xs">
              {item.details.map((detail) => (
                <div
                  key={`${detail.label}:${detail.value}`}
                  className="grid min-w-0 grid-cols-1 gap-0.5 sm:grid-cols-(--gtc-task-chat-details) sm:gap-3"
                >
                  <dt className="text-muted-foreground">{detail.label}</dt>
                  <dd
                    className={cn(
                      "min-w-0 break-words text-foreground",
                      detail.mono && "font-mono",
                    )}
                  >
                    {detail.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {item.output ? (
            <pre className="mt-2 max-h-(--sz-64) overflow-auto whitespace-pre-wrap rounded-sm bg-muted/50 p-2 font-mono text-xs text-foreground">
              {item.output}
            </pre>
          ) : null}
          {item.outputTruncated ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Output truncated to 8 KiB.
            </p>
          ) : null}
        </details>
      ) : null}
    </CardShell>
  );
}

function WorkspaceChangeFileRow({
  file,
  open,
  onToggle,
}: {
  file: TaskChatWorkspaceChangeItem["files"][number];
  open: boolean;
  onToggle: () => void;
}) {
  const parsed = useMemo(
    () => (file.diff ? parseUnifiedDiffLines(file.diff) : null),
    [file.diff],
  );
  const expandable = file.binary || Boolean(parsed?.lines.length) || file.diffTruncated === true;
  return (
    <div className="flex min-w-0 flex-col" data-testid="task-chat-workspace-change-file">
      <button
        type="button"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        className={cn(
          "group/file flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-xs",
          expandable ? "hover:bg-muted/60" : "cursor-default",
        )}
        onClick={expandable ? onToggle : undefined}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            !expandable && "invisible",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-foreground">
          {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        </span>
        {file.operation !== "modify" ? (
          <span className="shrink-0 text-(length:--text-micro) capitalize text-muted-foreground">
            {file.binary ? "binary · " : ""}
            {OPERATION_LABEL[file.operation] ?? file.operation.replaceAll("_", " ")}
          </span>
        ) : file.binary ? (
          <span className="shrink-0 text-(length:--text-micro) text-muted-foreground">binary</span>
        ) : null}
        <TaskChatDiffCounts added={file.additions} removed={file.deletions} />
      </button>
      {open ? (
        file.binary ? (
          <p className="ml-7 mt-1 text-xs text-muted-foreground">Binary file; text diff is unavailable.</p>
        ) : parsed?.lines.length ? (
          <TaskChatDiffView
            className="ml-7 mt-1"
            lines={parsed.lines}
            truncated={parsed.truncated || file.diffTruncated === true}
          />
        ) : (
          <p className="ml-7 mt-1 text-xs text-muted-foreground">This patch is too large to show here.</p>
        )
      ) : null}
    </div>
  );
}

const OPERATION_LABEL: Record<string, string> = {
  create: "new",
  delete: "deleted",
  rename: "renamed",
  mode_change: "mode change",
};

function WorkspaceChangeCard({ item }: { item: TaskChatWorkspaceChangeItem }) {
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState(false);
  const visibleFiles = expanded ? item.files : item.files.slice(0, 5);
  const fileCount = item.totals.files || item.files.length;
  const fileLabel = `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  const summary = item.complete ? `${fileLabel} changed` : `${fileLabel} so far`;
  const toggle = (path: string) =>
    setOpenPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <CardShell
      icon={GitBranch}
      title={item.complete ? "Changed in this turn" : "Changing files"}
      status={item.complete ? null : "running"}
      testId="task-chat-workspace-change"
    >
      <div className="flex min-w-0 items-center gap-2 px-2 pb-1 text-xs text-muted-foreground">
        <span>{summary}</span>
        <TaskChatDiffCounts added={item.totals.additions} removed={item.totals.deletions} />
        {item.files.length > 1 ? (
          <button
            type="button"
            className="ml-auto text-foreground underline-offset-2 hover:underline"
            onClick={() =>
              setOpenPaths((current) =>
                current.size > 0 ? new Set() : new Set(item.files.map((file) => file.path)),
              )
            }
          >
            {openPaths.size > 0 ? "Collapse all" : "Expand all"}
          </button>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        {visibleFiles.map((file) => (
          <WorkspaceChangeFileRow
            key={`${file.operation}:${file.path}`}
            file={file}
            open={openPaths.has(file.path)}
            onToggle={() => toggle(file.path)}
          />
        ))}
      </div>
      {item.files.length > 5 ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-1"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show fewer files" : `Show ${item.files.length - 5} more files`}
        </Button>
      ) : null}
      {fileCount > item.files.length ? (
        <p className="mt-1 px-2 text-xs text-muted-foreground" data-testid="task-chat-workspace-change-omitted">
          {fileCount - item.files.length} more {fileCount - item.files.length === 1 ? "file" : "files"} changed.
          This change set is too large to list them here.
        </p>
      ) : null}
    </CardShell>
  );
}

function WorkspaceFileCard({ item }: { item: TaskChatWorkspaceFileItem }) {
  const [open, setOpen] = useState(false);
  const extension = item.displayName.includes(".")
    ? item.displayName.split(".").at(-1)?.toUpperCase()
    : "FILE";
  const label =
    item.presentation === "generic" ? "File" : titleCaseKey(item.presentation);
  const workspaceFileRef = useMemo(
    () => ({
      path: item.path,
      resourceKind: "file" as const,
      line: item.line,
      column: null,
      raw: item.path,
    }),
    [item.line, item.path],
  );
  return (
    <>
      <CardShell
        icon={FileCode2}
        title={item.displayName}
        status={
          item.source === "runner_verified" ? "completed" : "informational"
        }
        summary={`${label} · ${extension}${item.line ? ` · line ${item.line}` : ""}`}
        testId="task-chat-workspace-file"
      >
        <div className="flex flex-wrap items-center gap-2">
          <WorkspaceFileLink
            workspaceFileRef={workspaceFileRef}
            label={item.path}
          />
          <Button
            className="ml-auto"
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setOpen(true)}
          >
            Preview
          </Button>
        </div>
      </CardShell>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-full max-w-(--pct-90) overflow-hidden">
          <DialogHeader>
            <DialogTitle>{item.displayName}</DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground">{item.path}</p>
          {item.preview == null ? (
            <p className="rounded-sm bg-muted/50 p-3 text-sm text-muted-foreground">
              Preview unavailable. The verified workspace reference is still
              available above.
            </p>
          ) : item.presentation === "document" ? (
            <div className="max-h-(--sz-70vh) overflow-auto rounded-sm bg-muted/30 p-3">
              <MarkdownBody>{item.preview}</MarkdownBody>
            </div>
          ) : item.presentation === "image" &&
            item.mediaType?.startsWith("image/") &&
            item.preview.startsWith("data:") ? (
            <img
              className="max-h-(--sz-70vh) max-w-full object-contain"
              alt={item.displayName}
              src={item.preview}
            />
          ) : (
            <pre className="max-h-(--sz-70vh) overflow-auto whitespace-pre-wrap rounded-sm bg-muted/50 p-3 font-mono text-xs">
              {item.preview}
            </pre>
          )}
          {item.previewTruncated ? (
            <p className="text-xs text-muted-foreground">
              Preview truncated by the runner.
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function titleCaseKey(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function RuntimeQuestionHistory({
  item,
}: {
  item: TaskChatRuntimeRequestItem;
}) {
  const questionSet = item.questionSet;
  if (!questionSet) return null;
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="task-chat-runtime-request-history"
    >
      {item.response ? (
        <QuestionResponseSummary
          questionSet={questionSet}
          response={item.response}
        />
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          {questionSet.questions.map((question) => (
            <div key={question.id}>
              {question.header ? (
                <p className="text-xs font-medium text-muted-foreground">
                  {question.header}
                </p>
              ) : null}
              <p className="text-foreground">{question.prompt}</p>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {item.status === "resolved"
              ? "Answer details were not recorded by this older runtime."
              : `No answers were submitted; this request was ${item.status}.`}
          </p>
        </div>
      )}
    </div>
  );
}

function RuntimeQuestionReceipt({
  item,
}: {
  item: TaskChatRuntimeRequestItem;
}) {
  const label =
    item.status === "resolved"
      ? "Questions answered"
      : item.status === "cancelled"
        ? "Questions cancelled"
        : item.status === "expired"
          ? "Questions expired"
          : "Questions resolved";
  return (
    <details className="group" data-testid="task-chat-runtime-request">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-sm px-1 py-1.5 text-sm leading-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span
          className="flex w-6 shrink-0 items-center justify-center"
          data-testid="task-chat-runtime-request-icon-slot"
        >
          <CircleHelp
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            data-testid="task-chat-runtime-request-icon"
          />
        </span>
        <span>{label}</span>
        <ChevronRight
          aria-hidden
          className="ml-auto h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover:opacity-70 group-focus-visible:opacity-70 group-open:rotate-90"
          data-testid="task-chat-runtime-request-caret"
        />
      </summary>
      <div className="pb-3 pl-7 pr-1">
        <div className="mb-3">
          <p className="text-sm font-medium text-foreground">
            {item.questionSet?.title ?? "Runtime input"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{item.prompt}</p>
        </div>
        <RuntimeQuestionHistory item={item} />
      </div>
    </details>
  );
}

function RuntimeRequestCard({
  item,
  onDecision,
  presentation,
  draftKey: requestedDraftKey,
  imageUploadHandler,
  mentions,
}: {
  item: TaskChatRuntimeRequestItem;
  onDecision?: TaskChatProtocolCardProps["onRuntimeRequestDecision"];
  presentation: "timeline" | "takeover";
  draftKey?: string;
  imageUploadHandler?: (file: File) => Promise<string>;
  mentions?: MentionOption[];
}) {
  const historyIssueId = useContext(TaskChatRequestHistoryContext);
  const draftKey = requestedDraftKey ?? (historyIssueId
    ? `paperclip:task-input:${historyIssueId}:runtime:${item.runId}:${item.requestId}`
    : undefined);
  const title =
    item.questionSet?.title ??
    (item.requestType === "permission"
      ? "Runtime permission"
      : "Runtime input");
  const fields =
    item.fields.length > 0
      ? item.fields
      : [{ name: "answer", label: "Response", placeholder: null }];
  const [values, setValues] = useState<Record<string, string>>(() =>
    draftKey ? loadStructuredDraft(draftKey, {}) : {},
  );
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!draftKey) setValues({});
    setSubmitting(false);
    setError(null);
  }, [draftKey, item.requestId, item.status]);
  useEffect(() => {
    if (draftKey) saveStructuredDraft(draftKey, values);
  }, [draftKey, values]);

  if (
    presentation === "timeline" &&
    item.requestType === "input" &&
    item.status !== "pending" &&
    item.questionSet
  ) {
    return <RuntimeQuestionReceipt item={item} />;
  }

  const submit = async (decision: TaskChatRuntimeRequestDecision) => {
    if (!onDecision || item.status !== "pending" || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onDecision(item, decision);
      if (draftKey) clearDraft(draftKey);
    } catch (cause) {
      setSubmitting(false);
      setError(
        cause instanceof Error
          ? cause.message
          : "The runtime request could not be resolved.",
      );
    }
  };
  const canSubmitInput = fields.some(
    (field) => (values[field.name] ?? "").trim().length > 0,
  );

  if (
    presentation === "takeover" &&
    item.requestType === "input" &&
    item.status === "pending" &&
    item.questionSet
  ) {
    return (
      <QuestionForm
        id={item.id}
        questionSet={item.questionSet}
        draftKey={draftKey}
        disabled={!onDecision || submitting}
        imageUploadHandler={imageUploadHandler}
        mentions={mentions}
        onSubmit={(response) => submit({ action: "submit", response })}
      />
    );
  }

  const content = (
    <CardShell
      icon={ShieldCheck}
      title={title}
      status={item.status}
      summary={item.prompt}
      testId="task-chat-runtime-request"
      presentation={presentation}
    >
      {item.requestType === "input" &&
      item.status === "pending" &&
      item.questionSet ? (
        <QuestionForm
          id={item.id}
          questionSet={item.questionSet}
          draftKey={draftKey}
          disabled={!onDecision || submitting}
          imageUploadHandler={imageUploadHandler}
          mentions={mentions}
          onSubmit={(response) => submit({ action: "submit", response })}
          onCancel={
            presentation === "timeline"
              ? () => submit({ action: "cancel" })
              : undefined
          }
        />
      ) : item.requestType === "input" &&
        item.status !== "pending" &&
        item.questionSet ? (
        <RuntimeQuestionHistory item={item} />
      ) : item.requestType === "input" && item.status === "pending" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmitInput) void submit({ action: "submit", values });
          }}
        >
          {fields.map((field) => {
            const inputId = `${item.id}:${field.name}`;
            return (
              <label
                key={field.name}
                className="flex flex-col gap-1.5 text-sm"
                htmlFor={inputId}
              >
                <span className="font-medium text-foreground">
                  {field.label}
                </span>
                <Textarea
                  id={inputId}
                  value={values[field.name] ?? ""}
                  placeholder={field.placeholder ?? undefined}
                  disabled={!onDecision || submitting}
                  rows={2}
                  className="resize-y border-0 bg-muted/35 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.name]: event.target.value,
                    }))
                  }
                />
              </label>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={!onDecision || submitting || !canSubmitInput}
            >
              {submitting ? "Submitting…" : "Submit response"}
            </Button>
            {item.choices.some((choice) => choice.key === "decline") ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!onDecision || submitting}
                onClick={() => void submit({ action: "decline" })}
              >
                Deny
              </Button>
            ) : null}
            {presentation === "timeline" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!onDecision || submitting}
                onClick={() => void submit({ action: "cancel" })}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : item.status === "pending" && item.choices.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {item.choices
            .filter(
              (choice) =>
                presentation === "timeline" || choice.key !== "cancel",
            )
            .map((choice) => (
              <Button
                key={choice.key}
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  item.status !== "pending" || !onDecision || submitting
                }
                onClick={() => {
                  if (
                    choice.key === "accept" ||
                    choice.key === "accept_for_session" ||
                    choice.key === "decline" ||
                    choice.key === "cancel"
                  ) {
                    void submit({ action: choice.key });
                  }
                }}
              >
                {submitting ? "Submitting…" : choice.label}
              </Button>
            ))}
        </div>
      ) : null}
      {item.status === "pending" && !onDecision ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Resolve this request in the active runtime session.
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </CardShell>
  );

  if (historyIssueId && presentation === "timeline" && item.status === "pending") {
    return (
      <details open={expanded} onToggle={event => {
        if (event.currentTarget.open && draftKey) setValues(loadStructuredDraft(draftKey, {}));
        setExpanded(event.currentTarget.open);
      }} className="group w-full" data-testid="task-chat-pending-runtime-request">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm px-1 py-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <CircleHelp aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1"><span className="block text-xs">{title}</span><span className="block truncate">{item.prompt}</span></span>
          <ChevronRight aria-hidden className="h-3 w-3 shrink-0 group-open:rotate-90" />
        </summary>
        {expanded ? content : null}
      </details>
    );
  }
  return content;
}

function ResultCard({
  item,
}: {
  item: Extract<TaskChatProtocolItem, { surface: "run_result" }>;
}) {
  const hasDetails =
    item.verification.length > 0 ||
    item.remainingWork.length > 0 ||
    item.artifacts.length > 0 ||
    item.blocker;
  return (
    <CardShell
      icon={PackageCheck}
      title="Run result"
      status={item.disposition}
      summary={item.summary}
      testId="task-chat-run-result"
    >
      {hasDetails ? (
        <div className="flex flex-col gap-3 text-sm">
          {item.blocker ? (
            <div className="rounded-sm bg-muted/50 p-2">
              <strong>Blocked: {item.blocker.reasonCode}</strong>
              <p className="mt-1 text-muted-foreground">
                {item.blocker.unblockAction}
              </p>
            </div>
          ) : null}
          {item.verification.length > 0 ? (
            <ul
              className="flex flex-col gap-1"
              aria-label="Verification results"
            >
              {item.verification.map((check, index) => (
                <li
                  key={`${check.commandOrCheck}:${index}`}
                  className="flex items-start gap-2"
                >
                  <StatusIcon
                    status={check.status}
                    className="mt-0.5 shrink-0"
                  />
                  <span>
                    <span className="font-mono text-xs">
                      {check.commandOrCheck}
                    </span>
                    {check.detail ? (
                      <span className="block text-xs text-muted-foreground">
                        {check.detail}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {item.remainingWork.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {item.remainingWork.map((work, index) => (
                <li key={`${work.description}:${index}`}>
                  {work.description}
                  {work.blocksCompletion ? " · blocks completion" : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {item.artifacts.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {item.artifacts.map((artifact) => (
                <span
                  key={`${artifact.kind}:${artifact.ref}`}
                  className="rounded-sm border border-border px-2 py-1 font-mono text-xs"
                >
                  {artifact.title ?? artifact.ref}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </CardShell>
  );
}

function TerminalCard({
  item,
}: {
  item: Extract<TaskChatProtocolItem, { surface: "run_terminal" }>;
}) {
  return (
    <CardShell
      icon={TerminalSquare}
      title="Run ended"
      status={item.runState}
      summary={[item.disposition.replaceAll("_", " "), item.stopReason]
        .filter(Boolean)
        .join(" · ")}
      testId="task-chat-run-terminal"
    />
  );
}

function ResourceCard({
  item,
}: {
  item: Extract<TaskChatProtocolItem, { surface: "resource" }>;
}) {
  const { enabled: artifactsV1 } = useArtifactsV1Enabled();
  if (artifactsV1) {
    // Artifacts V1 (doc/plans/2026-10-22-artifacts-mvp-v1.md): one full-width row named after the file. A
    // registered file keeps the shipped card's actions (gallery, text tab, open raw, download, CSV preview);
    // any other deliverable is a link that opens in a new tab with its state — "Unhealthy" first — beside it.
    const href = item.href ?? undefined;
    const testId = `task-chat-resource-${item.resourceKind}`;
    if (item.resourceKind === "deliverable" && item.workProduct) {
      const workProduct = item.workProduct;
      const statusBadge = workProductStateBadge(workProduct);
      const file = fileRowSourceFromWorkProduct(workProduct);
      if (file) {
        return <ArtifactFileRow subject={subjectFromWorkProduct(workProduct)} source={file} statusBadge={statusBadge} updatedAtLabel={item.timestamp ?? ""} testId={testId} />;
      }
      return <ArtifactRow subject={subjectFromWorkProduct(workProduct)} href={href} external trailing={statusBadge} testId={testId} />;
    }
    if (item.resourceKind === "attachment" && item.attachment) {
      return <ArtifactFileRow subject={subjectFromAttachment(item.attachment)} source={fileRowSourceFromAttachment(item.attachment)} updatedAtLabel={item.timestamp ?? ""} testId={testId} />;
    }
    const subject = item.document
      ? subjectFromDocumentSummary(item.document)
      : { kind: item.resourceKind === "document" ? ("document" as const) : ("file" as const), title: item.title };
    return <ArtifactRow subject={subject} href={href} external={item.resourceKind === "attachment"} testId={testId} />;
  }
  if (item.resourceKind === "deliverable" && item.workProduct) {
    return <RichWorkProductCard workProduct={item.workProduct} href={item.href} />;
  }
  const Icon =
    item.resourceKind === "document"
      ? FileText
      : item.resourceKind === "attachment"
        ? FileCode2
        : PackageCheck;
  const body = (
    <CardShell
      icon={Icon}
      title={item.title}
      status={null}
      summary={item.subtitle}
      testId={`task-chat-resource-${item.resourceKind}`}
    />
  );
  return item.href ? (
    <a
      className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href={item.href}
    >
      {body}
    </a>
  ) : (
    body
  );
}

export function TaskChatProtocolCard({
  item,
  onRuntimeRequestDecision,
  presentation = "timeline",
  draftKey,
  imageUploadHandler,
  mentions,
}: TaskChatProtocolCardProps) {
  switch (item.surface) {
    case "provider_activity":
      return <ProviderActivityCard item={item} />;
    case "workspace_change":
      return <WorkspaceChangeCard item={item} />;
    case "workspace_file":
      return <WorkspaceFileCard item={item} />;
    case "runtime_request":
      return (
        <RuntimeRequestCard
          item={item}
          onDecision={onRuntimeRequestDecision}
          presentation={presentation}
          draftKey={draftKey}
          imageUploadHandler={imageUploadHandler}
          mentions={mentions}
        />
      );
    case "run_result":
      return <ResultCard item={item} />;
    case "run_terminal":
      return <TerminalCard item={item} />;
    case "resource":
      return <ResourceCard item={item} />;
    default: {
      const unreachable: never = item;
      return unreachable;
    }
  }
}
