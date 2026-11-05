import { useId, useState, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Circle,
  ExternalLink,
  Loader2,
  X,
} from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { WorkspaceFileLink } from "@/components/WorkspaceFileLink";
import { useSecondTick } from "@/hooks/useSecondTick";
import { cn } from "@/lib/utils";
import { useTaskChatShimmer } from "./TaskChatShimmer";
import type {
  TaskChatProtocolDetail,
  TaskChatProtocolItem,
  TaskChatProtocolStep,
  TaskChatProviderActivityItem,
  TaskChatWorkspaceChangeItem,
  TaskChatWorkspaceFileItem,
} from "./task-chat-model";
import {
  durationLabel,
  protocolActivityIsRunning,
  protocolActivityLabel,
  protocolActivityPresentation,
  providerNoticeSeverity,
} from "./task-chat-activity-presentation";

const COMPACT_RESEARCH_RESULT_LIMIT = 5;
const COMPACT_WORKSPACE_FILE_LIMIT = 8;
const RESEARCH_SOURCE_PREVIEW_LIMIT = 3;

function StatusIcon({ status }: { status: "running" | "completed" | "failed" | "interrupted" | "informational" }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-(--status-agent-running)" aria-hidden />;
  if (status === "failed" || status === "interrupted") return <X className="h-3.5 w-3.5 text-destructive" aria-hidden />;
  if (status === "completed") return <Check className="h-3.5 w-3.5 text-(--status-task-icon-done)" aria-hidden />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />;
}

function stepStatusIcon(status: TaskChatProtocolStep["status"], neutral = false) {
  if (neutral && (status === "blocked" || status === "failed")) return <Circle className="h-3 w-3 text-muted-foreground" aria-hidden />;
  if (status === "in_progress") return <Loader2 className="h-3 w-3 animate-spin text-(--status-agent-running)" aria-hidden />;
  if (status === "completed") return <Check className="h-3 w-3 text-(--status-task-icon-done)" aria-hidden />;
  if (status === "blocked" || status === "failed") return <X className="h-3 w-3 text-destructive" aria-hidden />;
  return <Circle className="h-3 w-3 text-muted-foreground" aria-hidden />;
}

export function DetailList({ details }: { details: readonly TaskChatProtocolDetail[] }) {
  if (details.length === 0) return null;
  return (
    <dl className="flex min-w-0 flex-col gap-1.5" data-testid="task-chat-provider-detail-list">
      {details.map((detail) => (
        <div className="grid min-w-0 grid-cols-1 gap-0.5 sm:grid-cols-(--gtc-task-chat-details) sm:gap-3" key={`${detail.label}:${detail.value}`}>
          <dt className="text-muted-foreground">{detail.label}</dt>
          <dd className={cn("min-w-0 break-words text-foreground", detail.mono && "font-mono")}>{detail.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function sourceHostname(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

function ResearchDetails({ item }: { item: TaskChatProviderActivityItem }) {
  const [showAllResults, setShowAllResults] = useState(false);
  const query = item.details.find((detail) => detail.label.toLowerCase() === "query");
  const additionalDetails = item.details.filter((detail) => !["action", "query", "status"].includes(detail.label.toLowerCase()));
  const visibleLinks = showAllResults ? item.links : item.links.slice(0, COMPACT_RESEARCH_RESULT_LIMIT);
  const hiddenResultCount = item.links.length - visibleLinks.length;

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {query ? (
        <div className="min-w-0 rounded-sm bg-muted/40 px-2.5 py-2" data-testid="task-chat-research-query">
          <p className="text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">Query</p>
          <p className="mt-0.5 min-w-0 break-words font-mono text-(length:--text-micro) text-foreground">{query.value}</p>
        </div>
      ) : null}
      {item.links.length > 0 ? (
        <div className="min-w-0">
          <p className="mb-1 text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">
            {item.links.length} {item.links.length === 1 ? "result" : "results"}
          </p>
          <ol className="divide-y divide-border/60" aria-label="Research sources">
            {visibleLinks.map((link, index) => (
              <li className="min-w-0 py-1.5 first:pt-0 last:pb-0" key={`${link.href}:${index}`}>
                <a className="flex min-w-0 items-center gap-1 font-medium text-foreground hover:underline" href={link.href} target="_blank" rel="noreferrer">
                  <span className="truncate">{link.label}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                </a>
                <p className="mt-0.5 flex min-w-0 gap-2 text-muted-foreground">
                  <span className="shrink-0">{sourceHostname(link.href)}</span>
                  {link.description ? <span className="min-w-0 truncate">{link.description}</span> : null}
                </p>
              </li>
            ))}
          </ol>
          {hiddenResultCount > 0 ? (
            <button
              type="button"
              className="mt-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => setShowAllResults(true)}
            >
              Show {hiddenResultCount} more {hiddenResultCount === 1 ? "result" : "results"}
            </button>
          ) : showAllResults && item.links.length > COMPACT_RESEARCH_RESULT_LIMIT ? (
            <button
              type="button"
              className="mt-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => setShowAllResults(false)}
            >
              Show fewer results
            </button>
          ) : null}
        </div>
      ) : null}
      <DetailList details={additionalDetails} />
      {item.output || item.outputTruncated ? (
        <p className="text-muted-foreground">Additional provider output is available in Runner Inspector.</p>
      ) : null}
    </div>
  );
}

function ProviderDetails({ item, neutral = false }: { item: TaskChatProviderActivityItem; neutral?: boolean }) {
  if (item.family === "research") return <ResearchDetails item={item} />;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {item.steps.length > 0 ? (
        <ol className="flex flex-col gap-1" aria-label="Plan steps">
          {item.steps.map((step) => (
            <li className="flex min-w-0 items-start gap-2" key={step.id}>
              <span className="mt-0.5 shrink-0">{stepStatusIcon(step.status, neutral)}</span>
              <span className={cn("min-w-0", step.status === "completed" && "text-muted-foreground line-through")}>{step.label}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {item.links.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Research sources">
          {item.links.map((link) => (
            <li key={link.href}>
              <a className="inline-flex min-w-0 items-center gap-1 font-medium text-primary hover:underline" href={link.href} target="_blank" rel="noreferrer">
                <span className="truncate">{link.label}</span>
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              </a>
              {link.description ? <p className="mt-0.5 text-muted-foreground">{link.description}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {item.children.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Delegated agents">
          {item.children.map((child) => (
            <li className="flex min-w-0 flex-col gap-0.5" key={child.id}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="font-medium text-foreground">{child.title}</span>
                <span className="capitalize text-muted-foreground">{child.status}</span>
                {child.metadata ? <span className="min-w-0 truncate font-mono text-(length:--text-micro)">{child.metadata}</span> : null}
              </span>
              {child.summary ? <span className="text-muted-foreground">{child.summary}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {item.details.length > 0 ? (
        <DetailList details={item.details} />
      ) : null}
      {item.output ? (
        <pre className="max-h-(--sz-64) overflow-auto whitespace-pre-wrap rounded-sm bg-muted/50 p-2 font-mono text-(length:--text-micro) text-foreground">{item.output}</pre>
      ) : null}
      {item.outputTruncated ? <p className="text-muted-foreground">Output truncated to 8 KiB.</p> : null}
    </div>
  );
}

function WorkspaceChangeDetails({ item }: { item: TaskChatWorkspaceChangeItem }) {
  if (item.files.length === 0) return <p className="text-muted-foreground">No changed-file details were reported.</p>;
  const visibleFiles = item.files.slice(0, COMPACT_WORKSPACE_FILE_LIMIT);
  const hiddenFileCount = item.files.length - visibleFiles.length;
  return (
    <div className="min-w-0" data-testid="task-chat-workspace-change-details">
      <ul className="flex min-w-0 flex-col divide-y divide-border/60" aria-label="Changed files">
        {visibleFiles.map((file) => (
          <li className="flex min-w-0 items-center gap-2 py-1.5 first:pt-0 last:pb-0" key={`${file.operation}:${file.path}`}>
            <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}>
              {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
            </span>
            <span className="shrink-0 capitalize text-muted-foreground">{file.operation.replaceAll("_", " ")}</span>
            {file.additions != null || file.deletions != null ? (
              <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
                {file.additions == null ? "" : `+${file.additions}`} {file.deletions == null ? "" : `−${file.deletions}`}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {hiddenFileCount > 0 ? <p className="mt-1.5 text-muted-foreground">{hiddenFileCount} more {hiddenFileCount === 1 ? "file" : "files"} not shown</p> : null}
    </div>
  );
}

function WorkspaceFileDetails({ item }: { item: TaskChatWorkspaceFileItem }) {
  const workspaceFileRef = {
    path: item.path,
    resourceKind: "file" as const,
    line: item.line,
    column: null,
    raw: item.path,
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <WorkspaceFileLink workspaceFileRef={workspaceFileRef} label={item.path} />
      {item.preview ? (
        item.presentation === "document" ? (
          <div className="max-h-(--sz-64) overflow-auto rounded-sm bg-muted/30 p-2 text-foreground"><MarkdownBody>{item.preview}</MarkdownBody></div>
        ) : (
          <pre className="max-h-(--sz-64) overflow-auto whitespace-pre-wrap rounded-sm bg-muted/50 p-2 font-mono text-(length:--text-micro) text-foreground">{item.preview}</pre>
        )
      ) : <p className="text-muted-foreground">Preview unavailable.</p>}
      {item.previewTruncated ? <p className="text-muted-foreground">Preview truncated by the runner.</p> : null}
    </div>
  );
}

/** One-line outcome for a check: its detail, or why it did not run. */
export function verificationOutcome(item: TaskChatProviderActivityItem): string | undefined {
  const detail = item.details.find((entry) => entry.label === "Detail")?.value;
  if (detail) return detail;
  const reason = item.details.find((entry) => entry.label === "Reason Code")?.value;
  return reason ? reason.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase()) : undefined;
}

/** The full check: command and untruncated outcome, wrapped. */
function VerificationDetails({ item }: { item: TaskChatProviderActivityItem }) {
  const outcome = verificationOutcome(item);
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="task-chat-verification-details">
      {item.summary ? <p className="min-w-0 break-all font-mono text-foreground">{item.summary}</p> : null}
      {outcome ? <p className="min-w-0 whitespace-pre-wrap break-words">{outcome}</p> : null}
    </div>
  );
}

function detailContent(item: TaskChatProtocolItem, neutral = false): ReactNode | null {
  switch (item.surface) {
    case "provider_activity": {
      if (item.family === "verification") return verificationOutcome(item) ? <VerificationDetails item={item} /> : null;
      const expandable = item.details.length > 0 || item.steps.length > 0 || item.links.length > 0 || item.children.length > 0 || Boolean(item.output) || Boolean(item.outputTruncated);
      return expandable ? <ProviderDetails item={item} neutral={neutral} /> : null;
    }
    case "workspace_change": return <WorkspaceChangeDetails item={item} />;
    case "workspace_file": return <WorkspaceFileDetails item={item} />;
    case "resource":
    case "runtime_request":
    case "run_result":
    case "run_terminal":
      return null;
  }
}

function safeActivityHref(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    // A fixed HTTPS base accepts relative app paths and fragments as well as
    // external HTTP(S) resources, but never executable or local-file schemes.
    const url = new URL(value, "https://paperclip.invalid");
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function hasTaskChatProtocolActivityDetails(item: TaskChatProtocolItem): boolean {
  // A check expands only when it has an outcome that may not fit on one line.
  if (item.surface === "provider_activity" && item.family === "verification") return detailContent(item) !== null;
  if (item.surface === "resource") return Boolean(safeActivityHref(item.href));
  return detailContent(item) !== null || (item.surface === "provider_activity" && Boolean(item.summary?.trim()));
}

export function TaskChatProtocolActivityDetails({ item, neutral = false }: { item: TaskChatProtocolItem; neutral?: boolean }) {
  const detail = detailContent(item, neutral);
  if (item.surface === "resource") {
    const href = safeActivityHref(item.href);
    return href ? <a href={href} className="text-foreground underline">{item.title}</a> : <p>{item.title}</p>;
  }
  return <>{item.surface === "provider_activity" && item.family !== "verification" && item.summary ? <p className="whitespace-pre-wrap break-words">{item.summary}</p> : null}{detail}</>;
}

/** Source domains under a finished web search, so results are visible without expanding. */
export function ResearchSourceStrip({ item }: { item: TaskChatProviderActivityItem }) {
  const seen = new Set<string>();
  const sources = item.links.flatMap((link) => {
    const host = sourceHostname(link.href);
    if (seen.has(host)) return [];
    seen.add(host);
    return [{ ...link, host }];
  });
  if (sources.length === 0) return null;
  const visible = sources.slice(0, RESEARCH_SOURCE_PREVIEW_LIMIT);
  const hidden = item.links.length - visible.length;
  return (
    <div className="ml-7 flex min-w-0 flex-wrap items-center gap-1 pb-0.5" data-testid="task-chat-research-sources">
      {visible.map((source) => (
        <a
          key={source.href}
          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-(length:--text-nano) text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          href={source.href}
          target="_blank"
          rel="noreferrer"
          title={source.label}
        >
          <span className="truncate">{source.host}</span>
        </a>
      ))}
      {hidden > 0 ? <span className="text-(length:--text-nano) text-muted-foreground">+{hidden} more</span> : null}
    </div>
  );
}

/** Live "12s left" for an intentional wait with a planned duration. */
export function WaitCountdown({ item }: { item: TaskChatProviderActivityItem }) {
  useSecondTick(true);
  const planned = Number(item.details.find((detail) => detail.label === "Planned Duration Ms")?.value);
  const startedAtMs = item.startedAt ? Date.parse(item.startedAt) : Number.NaN;
  if (!Number.isFinite(planned) || !Number.isFinite(startedAtMs)) return null;
  const remaining = Math.max(0, planned - (Date.now() - startedAtMs));
  return <span className="shrink-0 tabular-nums" data-testid="task-chat-wait-countdown">{durationLabel(String(remaining))} left</span>;
}

export function verificationTone(item: TaskChatProviderActivityItem): string | undefined {
  const status = item.details.find((detail) => detail.label === "Status")?.value;
  if (status === "passed") return "text-(--status-task-icon-done)";
  if (status === "failed") return "text-destructive";
  return undefined;
}

function itemStatus(item: TaskChatProtocolItem): "running" | "completed" | "failed" | "interrupted" | "informational" {
  if (item.surface === "provider_activity") return item.status;
  if (item.surface === "workspace_change") return item.complete ? "completed" : "running";
  return "completed";
}

export function TaskChatProtocolActivityRow({ item }: { item: TaskChatProtocolItem }) {
  const shimmer = useTaskChatShimmer(item.id);
  const [open, setOpen] = useState(false);
  const detailId = `task-chat-protocol-activity-${useId().replaceAll(":", "")}`;
  const presentation = protocolActivityPresentation(item);
  if (!presentation) return null;
  if (item.surface === "provider_activity" && item.family === "provider_notice") {
    const NoticeIcon = presentation.icon;
    const severity = providerNoticeSeverity(item);
    const summary = item.summary
      ?? item.details.find((entry) => entry.label === "Summary")?.value
      ?? "The provider reported a notice without a message.";
    return (
      <div className="flex min-w-0 flex-col gap-1.5 py-1 text-xs" data-testid="task-chat-protocol-activity-row" data-activity-family="provider_notice">
        <div className="flex items-center gap-2 text-muted-foreground">
          <NoticeIcon className="size-(--sz-protocol-notice-icon) shrink-0" aria-hidden data-testid="task-chat-protocol-activity-icon" />
          <span className="font-medium">{severity === "error" ? "Error" : severity === "info" ? "Provider update" : "Warning"}</span>
        </div>
        <p className="min-w-0 whitespace-pre-wrap break-words text-foreground">{summary}</p>
        {item.details.some(detail => detail.label !== "Summary") ? (
          <details className="text-muted-foreground">
            <summary className="cursor-pointer">Details</summary>
            <DetailList details={item.details.filter(detail => detail.label !== "Summary")} />
          </details>
        ) : null}
      </div>
    );
  }
  const verification = item.surface === "provider_activity" && item.family === "verification" ? item : null;
  const runningWait = item.surface === "provider_activity" && item.family === "wait" && item.status === "running" ? item : null;
  const research = item.surface === "provider_activity" && item.family === "research" && item.status !== "running" ? item : null;
  const detail = detailContent(item);
  const expandable = detail !== null;
  const Icon = presentation.icon;
  const label = protocolActivityLabel(item, presentation);
  const active = protocolActivityIsRunning(item);
  const status = itemStatus(item);
  const row = (
    <>
      <span className="flex w-5 shrink-0 items-center justify-center">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", verification && verificationTone(verification))} aria-hidden data-testid="task-chat-protocol-activity-icon" />
      </span>
      <span data-conversation-tool-running={active && shimmer && item.surface === "provider_activity" && item.family === "tool_execution" ? "true" : undefined} className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <span className={cn("shrink-0 font-medium", active && shimmer && "shimmer-text shimmer-text-muted")}>{label}{active ? "…" : ""}</span>
        {presentation.detail ? <span className="task-chat-collapsed-line-fade min-w-0 flex-1 font-mono text-(length:--text-micro)">{presentation.detail}</span> : null}
        {verification && verificationOutcome(verification) ? (
          <span className="min-w-0 shrink truncate" data-testid="task-chat-verification-detail">
            {verificationOutcome(verification)}
          </span>
        ) : null}
        {runningWait ? <WaitCountdown item={runningWait} /> : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {expandable ? (
          <ChevronRight
            className={cn("tc-hover-disclosure-caret h-3 w-3 transition-[opacity,transform] group-hover/activity:opacity-80 group-focus-visible/activity:opacity-80", open ? "rotate-90 opacity-80" : "opacity-0")}
            aria-hidden
          />
        ) : null}
        {verification ? null : <StatusIcon status={status} />}
      </span>
    </>
  );

  const resourceHref = item.surface === "resource" ? safeActivityHref(item.href) : undefined;
  if (resourceHref) {
    return (
      <a className="group/activity -mx-1.5 flex min-h-6 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-sm px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" href={resourceHref} data-testid="task-chat-protocol-activity-row">
        {row}
      </a>
    );
  }

  const activityRow = expandable ? (
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      aria-controls={detailId}
      className="group/activity -mx-1.5 flex min-h-6 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-sm px-1.5 py-1 text-left text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {row}
    </button>
  ) : (
    <div className="group/activity -mx-1.5 flex min-h-6 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-sm px-1.5 py-1 text-muted-foreground">
      {row}
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col text-xs" data-testid="task-chat-protocol-activity-row" data-activity-family={item.surface === "provider_activity" ? item.family : item.surface}>
      {activityRow}
      {research && !open ? <ResearchSourceStrip item={research} /> : null}
      {open && detail ? (
        <div id={detailId} className="ml-2.5 mt-0.5 border-l-2 border-border py-1 pl-2.5" data-testid="task-chat-protocol-activity-detail">
          {detail}
        </div>
      ) : null}
    </div>
  );
}
