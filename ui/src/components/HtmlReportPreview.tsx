import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

interface HtmlReportPreviewProps {
  src: string;
  filename?: string;
  defaultExpanded?: boolean;
  className?: string;
}

export function HtmlReportPreview({ src, filename, defaultExpanded = true, className }: HtmlReportPreviewProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const label = filename ?? src.split("/").pop() ?? "report.html";

  return (
    <div className={cn("border border-border rounded-md overflow-hidden", className)}>
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/40 hover:bg-muted/70 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <FileText className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
        <span className="text-xs font-medium truncate flex-1">{label}</span>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={(e) => e.stopPropagation()}
          title="Open in new tab"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      </button>

      {expanded && (
        <iframe
          src={src}
          title={label}
          className="w-full border-0 bg-[#0a0a0f]"
          style={{ height: 480 }}
          loading="lazy"
        />
      )}
    </div>
  );
}

/** Bare filename pattern for an html_report skill report: YYYY-MM-DD-slug.html */
const REPORT_FILENAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.html?$/i;

/**
 * Returns the filename if the string looks like an html_report skill output, otherwise null.
 * Accepts both bare filenames and paths containing "reports/".
 */
export function extractReportFilename(url: string): string | null {
  const basename = url.split("/").pop() ?? "";
  if (!REPORT_FILENAME_RE.test(basename)) return null;
  // Accept if it has reports/ in the path OR if it's just a bare matching filename
  return basename;
}

/**
 * Build the API URL for fetching an HTML report from an issue's execution workspace.
 * Returns null when companyId or issueId are not available.
 */
export function buildReportApiUrl(
  filename: string,
  companyId: string | null | undefined,
  issueId: string | null | undefined,
): string | null {
  if (!companyId || !issueId) return null;
  return `/api/companies/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issueId)}/reports/${encodeURIComponent(filename)}`;
}

/**
 * Extract report filenames from a markdown/text string.
 * Handles markdown links, bare paths, and backtick-wrapped paths.
 */
export function extractReportFilenames(text: string): string[] {
  const seen = new Set<string>();
  const push = (candidate: string) => {
    const fn = extractReportFilename(candidate);
    if (fn && !seen.has(fn)) { seen.add(fn); }
  };

  // Markdown links: [text](url)
  for (const m of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    push(m[2] ?? "");
  }

  // Backtick spans: `reports/...html`
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    push(m[1] ?? "");
  }

  // Bare paths (preceded by space/newline/start)
  for (const m of text.matchAll(/(?:^|[\s(])([^\s()"'<>`]+\.html?)/gim)) {
    push(m[1] ?? "");
  }

  return [...seen];
}
