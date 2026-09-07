import { t, useTranslation } from "@/i18n";
import { memo, type ComponentType, type SVGProps } from "react";
import { Bot, FileText, Hexagon, MessageSquare, Paperclip, Quote } from "lucide-react";
import type { Agent, CompanySearchResult } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { StatusIcon } from "../StatusIcon";
import { Identity } from "../Identity";
import { HighlightedText, type HighlightedTextProps } from "./HighlightedText";

type SnippetStyle = {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  labelKey: string;
};

const SNIPPET_STYLES: Record<string, SnippetStyle> = {
  title: { Icon: Quote, labelKey: "localizationFilters.sourcetitle" },
  identifier: { Icon: Quote, labelKey: "localizationFilters.sourceidentifier" },
  comment: { Icon: MessageSquare, labelKey: "localizationFilters.sourcecomment" },
  document: { Icon: FileText, labelKey: "localizationFilters.sourcedocument" },
  artifact: { Icon: Paperclip, labelKey: "localizationFilters.sourceartifact" },
  description: { Icon: Quote, labelKey: "localizationFilters.sourcedescription" },
};

function snippetStyle(field: string, fallbackLabel: string) {
  const style = SNIPPET_STYLES[field];
  return style ? { Icon: style.Icon, label: t(style.labelKey) } : { Icon: Quote, label: fallbackLabel };
}

function formatRelativeTime(input: string | null): string {
  if (!input) return "";
  const value = new Date(input);
  if (Number.isNaN(value.getTime())) return "";
  const diffMs = Date.now() - value.getTime();
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return t("common.formatting.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("localizationFilters.relativeminutes", { defaultValue: "{{count}}m", count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("localizationFilters.relativehours", { defaultValue: "{{count}}h", count: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return t("localizationFilters.relativedays", { defaultValue: "{{count}}d", count: days });
  const weeks = Math.round(days / 7);
  if (weeks < 5) return t("localizationFilters.relativeweeks", { defaultValue: "{{count}}w", count: weeks });
  const months = Math.round(days / 30);
  if (months < 12) return t("localizationFilters.relativemonths", { defaultValue: "{{count}}mo", count: months });
  const years = Math.round(days / 365);
  return t("localizationFilters.relativeyears", { defaultValue: "{{count}}y", count: years });
}

export interface SearchResultRowProps {
  result: CompanySearchResult;
  agentsById?: ReadonlyMap<string, Pick<Agent, "id" | "name">>;
  isActive?: boolean;
  className?: string;
}

const ROW_BASE =
  "group flex items-start gap-3 rounded-md px-3 transition-colors no-underline text-inherit hover:bg-muted/40";

function SearchResultRowImpl({
  result,
  agentsById,
  isActive,
  className,
}: SearchResultRowProps) {
  const { t } = useTranslation();
  if (result.type === "agent") {
    return (
      <Link
        to={result.href}
        className={cn(ROW_BASE, "py-3", isActive && "bg-muted/40", className)}
        data-result-type="agent"
      >
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Bot className="h-3 w-3" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{result.title}</span>
          </div>
          {result.snippet ? (
            <SnippetLine
              text={result.snippets[0]?.text ?? result.snippet}
              highlights={result.snippets[0]?.highlights}
              field="agent"
              fallbackLabel={t("localizationFilters.agent", { defaultValue: "Agent" })}
            />
          ) : null}
        </div>
      </Link>
    );
  }

  if (result.type === "project") {
    return (
      <Link
        to={result.href}
        className={cn(ROW_BASE, "py-3", isActive && "bg-muted/40", className)}
        data-result-type="project"
      >
        <Hexagon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <span className="truncate text-sm font-medium">{result.title}</span>
          {result.snippet ? (
            <SnippetLine
              text={result.snippets[0]?.text ?? result.snippet}
              highlights={result.snippets[0]?.highlights}
              field="project"
              fallbackLabel={t("localizationFilters.project", { defaultValue: "Project" })}
            />
          ) : null}
        </div>
      </Link>
    );
  }

  if (result.type === "artifact") {
    const artifact = result.artifact;
    if (!artifact) return null;
    const updated = formatRelativeTime(result.updatedAt ?? artifact.updatedAt);
    return (
      <Link
        to={result.href}
        disableIssueQuicklook
        className={cn(ROW_BASE, "py-4", isActive && "bg-muted/40", className)}
        data-result-type="artifact"
      >
        <Paperclip className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="truncate text-sm font-medium text-foreground">{result.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {artifact.issueIdentifier}
            </span>
          </div>
          {result.snippet ? (
            <SnippetLine
              text={result.snippets[0]?.text ?? result.snippet}
              highlights={result.snippets[0]?.highlights}
              field="artifact"
              fallbackLabel={t("localizationFilters.sourceartifact", { defaultValue: "Artifact" })}
              multiline
            />
          ) : null}
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground sm:hidden">
            <span className="truncate">{artifact.issueTitle}</span>
            {updated ? <span className="ml-auto shrink-0 tabular-nums">{updated}</span> : null}
          </div>
        </div>
        <div className="ml-2 hidden shrink-0 flex-col items-end gap-2 sm:flex">
          {updated ? <span className="text-xs tabular-nums text-muted-foreground">{updated}</span> : null}
          {result.previewImageUrl ? (
            <img
              src={result.previewImageUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-(--sz-88px) w-(--sz-88px) shrink-0 rounded-md border border-border bg-muted object-cover"
            />
          ) : null}
        </div>
      </Link>
    );
  }

  const issue = result.issue;
  if (!issue) return null;
  const assigneeName = issue.assigneeAgentId
    ? agentsById?.get(issue.assigneeAgentId)?.name ?? null
    : null;
  const updated = formatRelativeTime(result.updatedAt ?? issue.updatedAt);
  const titleHighlights = result.snippets.find((snippet) => snippet.field === "title")?.highlights;
  const bodySnippets = result.snippets.filter((snippet) => snippet.field !== "title").slice(0, 2);
  const previewImageUrl = result.previewImageUrl;
  const hasRightRail = previewImageUrl || assigneeName || updated;

  return (
    <Link
      to={result.href}
      disableIssueQuicklook
      className={cn(ROW_BASE, "py-4", isActive && "bg-muted/40", className)}
      data-result-type="issue"
    >
      <div className="mt-1 shrink-0">
        <StatusIcon status={issue.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
          {issue.identifier ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              {issue.identifier}
            </span>
          ) : null}
          <HighlightedText
            text={issue.title}
            highlights={titleHighlights}
            className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground"
          />
        </div>
        {bodySnippets.map((snippet, index) => (
          <SnippetLine
            key={`${snippet.field}-${index}`}
            text={snippet.text}
            highlights={snippet.highlights}
            field={snippet.field}
            fallbackLabel={snippet.label}
            multiline
          />
        ))}
        {hasRightRail ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground sm:hidden">
            {assigneeName ? <span className="truncate">{assigneeName}</span> : null}
            {updated ? <span className="ml-auto tabular-nums">{updated}</span> : null}
          </div>
        ) : null}
      </div>
      {hasRightRail ? (
        <div className="ml-2 hidden shrink-0 flex-col items-end gap-2 sm:flex">
          {assigneeName || updated ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {assigneeName ? <Identity name={assigneeName} size="sm" /> : null}
              {updated ? <span className="tabular-nums">{updated}</span> : null}
            </div>
          ) : null}
          {previewImageUrl ? (
            <img
              src={previewImageUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-(--sz-88px) w-(--sz-88px) shrink-0 rounded-md border border-border bg-muted object-cover"
            />
          ) : null}
        </div>
      ) : null}
    </Link>
  );
}

export const SearchResultRow = memo(SearchResultRowImpl);

interface SnippetLineProps {
  text: string;
  highlights?: HighlightedTextProps["highlights"];
  field: string;
  fallbackLabel: string;
  multiline?: boolean;
}

function SnippetLine({ text, highlights, field, fallbackLabel, multiline = false }: SnippetLineProps) {
  useTranslation();
  const { Icon, label } = snippetStyle(field, fallbackLabel);
  return (
    <div
      className={cn(
        "mt-2.5 flex min-w-0 gap-1.5 text-xs text-muted-foreground",
        multiline ? "items-start" : "items-center",
      )}
    >
      <Icon
        className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground/60", multiline && "mt-0.5")}
        aria-hidden
      />
      <span
        className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground"
      >
        {label}
      </span>
      <HighlightedText
        text={text}
        highlights={highlights}
        className={multiline ? "line-clamp-2 leading-relaxed" : "line-clamp-1 truncate"}
      />
    </div>
  );
}
