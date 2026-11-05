import { t, useTranslation, Trans } from "@/i18n";
import { enumDisplayLabel } from "./task-chat-display";
import { detailDisplayLabel } from "./task-chat-display";
import { useContext, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
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
  useTranslation("task-components");
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
  useTranslation("task-components");
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
          {enumDisplayLabel(status, status.replaceAll("_", " "))}
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
                {enumDisplayLabel(status, status.replaceAll("_", " "))}
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
  useTranslation("task-components");
  if (steps.length === 0) return null;
  return (
    <ol className="flex flex-col gap-1.5" aria-label={t("task-components:planSteps_3fa02f98")}>
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

function ProviderActivityCard({
  item,
}: {
  item: TaskChatProviderActivityItem;
}) {
  useTranslation("task-components");
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
        <ul className="flex flex-col gap-2" aria-label={t("task-components:delegatedAgents_a3a4ad04")}>
          {item.children.map((child) => (
            <li
              key={child.id}
              className="rounded-sm bg-muted/40 px-2.5 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <StatusIcon status={enumDisplayLabel(child.status)} className="shrink-0" />
                <strong className="font-medium">{child.title}</strong>
                <span
                  className={cn(
                    "ml-auto text-xs capitalize",
                    statusTone(child.status),
                  )}
                >
                  {enumDisplayLabel(child.status)}
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
        <ul className="flex flex-col gap-2" aria-label={t("task-components:researchSources_6891cd22")}>
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
            <ChevronDown aria-hidden className="h-3.5 w-3.5" />{" "}{t("task-components:details_45989de4")}</summary>
          {item.details.length > 0 ? (
            <dl className="mt-2 flex min-w-0 flex-col gap-1.5 text-xs">
              {item.details.map((detail) => (
                <div
                  key={`${detail.label}:${detail.value}`}
                  className="grid min-w-0 grid-cols-1 gap-0.5 sm:grid-cols-(--gtc-task-chat-details) sm:gap-3"
                >
                  <dt className="text-muted-foreground">{detailDisplayLabel(detail)}</dt>
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
            <p className="mt-1 text-xs text-muted-foreground">{t("task-components:outputTruncatedTo8Kib_71045c3c")}</p>
          ) : null}
        </details>
      ) : null}
    </CardShell>
  );
}

function diffStats(file: TaskChatWorkspaceChangeItem["files"][number]) {
  return (
    <span className="shrink-0 font-mono text-xs text-muted-foreground">
      {file.additions == null ? "" : `+${file.additions}`}
      {file.additions != null && file.deletions != null ? " " : ""}
      {file.deletions == null ? "" : `−${file.deletions}`}
    </span>
  );
}

function WorkspaceChangeCard({ item }: { item: TaskChatWorkspaceChangeItem }) {
  useTranslation("task-components");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const selected =
    item.files.find((file) => file.path === selectedPath) ?? null;
  const visibleFiles = expanded ? item.files : item.files.slice(0, 3);
  const fileCount = item.totals.files || item.files.length;
  const stats = [
    item.totals.additions == null ? null : `+${item.totals.additions}`,
    item.totals.deletions == null ? null : `−${item.totals.deletions}`,
  ].filter(Boolean).join(" ");
  const summary = item.complete
    ? fileCount === 1 ? t("task-chat-ui:oneFileChanged", { count: fileCount, stats: stats ? ` · ${stats}` : "" }) : t("task-chat-ui:filesChanged", { count: fileCount, stats: stats ? ` · ${stats}` : "" })
    : t("task-chat-ui:workspaceInProgress");
  return (
    <>
      <CardShell
        icon={GitBranch}
        title={t("task-components:workspaceChanges_1ac656d5")}
        status={item.complete ? "completed" : "running"}
        summary={summary}
        testId="task-chat-workspace-change"
      >
        <div className="flex flex-col gap-1">
          {visibleFiles.map((file) => (
            <button
              key={`${file.operation}:${file.path}`}
              type="button"
              className="flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted/60"
              onClick={() => setSelectedPath(file.path)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono">
                  {file.previousPath
                    ? `${file.previousPath} → ${file.path}`
                    : file.path}
                </span>
                <span className="text-xs capitalize text-muted-foreground">
                  {file.binary ? (t("task-components:binary_a10eca32") + " ") : ""}
                  {enumDisplayLabel(file.operation, file.operation.replaceAll("_", " "))}
                </span>
              </span>
              {diffStats(file)}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {item.files.length > 3 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? t("task-components:showFewerFiles_17fe4047")
                : t("task-components:showMoreFiles_c4abcf78", { value1: item.files.length - 3 })}
            </Button>
          ) : null}
          {item.files.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSelectedPath(item.files[0].path)}
            >{t("task-components:reviewDiff_61468276")}</Button>
          ) : null}
        </div>
      </CardShell>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedPath(null);
        }}
      >
        <DialogContent className="w-full max-w-(--pct-90) overflow-hidden">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {selected?.path ?? t("task-components:workspaceDiff_a4472b52")}
            </DialogTitle>
          </DialogHeader>
          {item.files.length > 1 ? (
            <div
              className="flex max-w-full gap-1 overflow-x-auto pb-1"
              aria-label={t("task-components:changedFiles_5d4041aa")}
            >
              {item.files.map((file) => (
                <Button
                  key={file.path}
                  type="button"
                  size="sm"
                  variant={file.path === selected?.path ? "secondary" : "ghost"}
                  onClick={() => setSelectedPath(file.path)}
                >
                  {file.path}
                </Button>
              ))}
            </div>
          ) : null}
          {selected?.binary ? (
            <p className="rounded-sm bg-muted/50 p-3 text-sm text-muted-foreground">{t("task-components:binaryFileTextDiffIsUnavailable_98cd1b4b")}</p>
          ) : selected?.diff ? (
            <pre className="max-h-(--sz-70vh) overflow-auto whitespace-pre rounded-sm bg-muted/50 p-3 font-mono text-xs">
              {selected.diff}
            </pre>
          ) : (
            <p className="rounded-sm bg-muted/50 p-3 text-sm text-muted-foreground">{t("task-components:noInlinePatchWasRecordedForThis_009e7b89")}</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function WorkspaceFileCard({ item }: { item: TaskChatWorkspaceFileItem }) {
  useTranslation("task-components");
  const [open, setOpen] = useState(false);
  const extension = item.displayName.includes(".")
    ? item.displayName.split(".").at(-1)?.toUpperCase()
    : t("task-chat-ui:fileExtensionFallback");
  const label =
    item.presentation === "generic" ? t("task-chat-ui:attachment.File") : enumDisplayLabel(item.presentation, titleCaseKey(item.presentation));
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
        summary={item.line ? t("task-chat-ui:fileSummaryLine", { kind: label, extension, line: item.line }) : t("task-chat-ui:fileSummary", { kind: label, extension })}
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
          >{t("task-components:preview_324b134f")}</Button>
        </div>
      </CardShell>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-full max-w-(--pct-90) overflow-hidden">
          <DialogHeader>
            <DialogTitle>{item.displayName}</DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground">{item.path}</p>
          {item.preview == null ? (
            <p className="rounded-sm bg-muted/50 p-3 text-sm text-muted-foreground">{t("task-components:previewUnavailableTheVerifiedWorkspaceReferenceIs_adcad82d")}</p>
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
            <p className="text-xs text-muted-foreground">{t("task-components:previewTruncatedByTheRunner_c8a44a1e")}</p>
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
  useTranslation("task-components");
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
              ? t("task-components:answerDetailsWereNotRecordedByThis_43dc6c77")
              : t("task-components:noAnswersWereSubmittedThisRequestWas_32c4768d", { value1: item.status })}
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
  useTranslation("task-components");
  const label =
    item.status === "resolved"
      ? t("task-chat-ui:questionsAnswered")
      : item.status === "cancelled"
        ? t("task-chat-ui:questionsCancelled")
        : item.status === "expired"
          ? t("task-chat-ui:questionsExpired")
          : t("task-chat-ui:questionsResolved");
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
            {item.questionSet?.title ?? t("task-components:runtimeInput_b73049f7")}
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
  useTranslation("task-components");
  const historyIssueId = useContext(TaskChatRequestHistoryContext);
  const draftKey = requestedDraftKey ?? (historyIssueId
    ? `paperclip:task-input:${historyIssueId}:runtime:${item.runId}:${item.requestId}`
    : undefined);
  const title =
    item.questionSet?.title ??
    (item.requestType === "permission"
      ? t("task-chat-ui:runtimePermission")
      : t("task-components:runtimeInput_b73049f7"));
  const fields =
    item.fields.length > 0
      ? item.fields
      : [{ name: "answer", label: t("task-components:response_9061383b"), placeholder: null }];
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
          : t("task-chat-ui:runtimeResolutionFailed"),
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
              {submitting ? t("task-components:submitting_49195f55") : t("task-components:submitResponse_2b35561b")}
            </Button>
            {item.choices.some((choice) => choice.key === "decline") ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!onDecision || submitting}
                onClick={() => void submit({ action: "decline" })}
              >{t("task-components:deny_05a2d733")}</Button>
            ) : null}
            {presentation === "timeline" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!onDecision || submitting}
                onClick={() => void submit({ action: "cancel" })}
              >{t("task-components:cancel_19766ed6")}</Button>
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
                {submitting ? t("task-components:submitting_49195f55") : choice.label}
              </Button>
            ))}
        </div>
      ) : null}
      {item.status === "pending" && !onDecision ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("task-components:resolveThisRequestInTheActiveRuntime_a855c7a3")}</p>
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
  useTranslation("task-components");
  const hasDetails =
    item.verification.length > 0 ||
    item.remainingWork.length > 0 ||
    item.artifacts.length > 0 ||
    item.blocker;
  return (
    <CardShell
      icon={PackageCheck}
      title={t("task-components:runResult_916788b6")}
      status={item.disposition}
      summary={item.summary}
      testId="task-chat-run-result"
    >
      {hasDetails ? (
        <div className="flex flex-col gap-3 text-sm">
          {item.blocker ? (
            <div className="rounded-sm bg-muted/50 p-2">
              <strong><Trans ns="task-components" i18nKey="sentence_2b4a488ac17c" components={{ part1: <>{item.blocker.reasonCode}</> }} /></strong>
              <p className="mt-1 text-muted-foreground">
                {item.blocker.unblockAction}
              </p>
            </div>
          ) : null}
          {item.verification.length > 0 ? (
            <ul
              className="flex flex-col gap-1"
              aria-label={t("task-components:verificationResults_14a01310")}
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
                  {work.blocksCompletion ? (" " + t("task-components:blocksCompletion_935d5b7e")) : ""}
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
  useTranslation("task-components");
  return (
    <CardShell
      icon={TerminalSquare}
      title={t("task-components:runEnded_65ad5d90")}
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
  useTranslation("task-components");
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
  useTranslation("task-components");
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
