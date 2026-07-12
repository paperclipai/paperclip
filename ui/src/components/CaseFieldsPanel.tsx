import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { Link, useCaseHref } from "@/lib/router";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

// -----------------------------------------------------------------------------
// CaseFieldsPanel (PAP-12968 §3) — the generic key-value renderer for a case's
// `fields` JSON blob. The server stores arbitrary agent-authored JSON, so the UI
// renders by *value type* (Postel's law: never crash on unexpected shapes) and
// preserves the skill's key insertion order (does NOT alphabetize).
// -----------------------------------------------------------------------------

const URL_RE = /^https?:\/\/\S+$/i;
const CASE_ID_RE = /^[A-Z][A-Z0-9]*-C\d+$/;
const ISSUE_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const ISSUE_ID_IN_TEXT_RE = /\b[A-Z][A-Z0-9]*-\d+\b/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A muted em-dash for null / empty / missing values. */
function EmptyValue() {
  return <span className="text-muted-foreground">—</span>;
}

function isIssueIdentifierField(fieldKey: string | undefined): boolean {
  if (!fieldKey) return false;
  const normalized = fieldKey.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.includes("issueidentifier") || normalized.includes("taskidentifier");
}

function stringifyCopyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function extractIssueIdentifiers(value: unknown, fieldKey?: string): string[] {
  if (!isIssueIdentifierField(fieldKey)) {
    return typeof value === "string" && ISSUE_ID_RE.test(value.trim()) ? [value.trim()] : [];
  }

  const identifiers: string[] = [];
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    for (const match of candidate.matchAll(ISSUE_ID_IN_TEXT_RE)) identifiers.push(match[0]);
  };

  if (Array.isArray(value)) value.forEach(add);
  else add(value);

  return [...new Set(identifiers)];
}

function IssueIdentifierValue({ identifiers }: { identifiers: string[] }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {identifiers.map((identifier) => (
        <IssueReferencePill
          key={identifier}
          issue={{ id: identifier, identifier, title: identifier }}
        />
      ))}
    </span>
  );
}

function CopyableCompactValue({
  value,
  children,
  className,
}: {
  value: unknown;
  children: ReactNode;
  className?: string;
}) {
  const text = stringifyCopyValue(value);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(text).then(() => {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <span className="relative inline-flex min-w-0 max-w-full">
      <button
        type="button"
        className={cn("min-w-0 max-w-full cursor-copy truncate text-left transition-colors hover:text-foreground", className)}
        title={text}
        onClick={handleCopy}
      >
        {children}
      </button>
      {copied ? (
        <span
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 inline-flex -translate-x-1/2 items-center gap-1 rounded-md bg-foreground px-2 py-1 text-xs whitespace-nowrap text-background"
        >
          <Check className="h-3 w-3 shrink-0" />
          Copied
        </span>
      ) : null}
    </span>
  );
}

function StringValue({ value, variant }: { value: string; variant: "compact" | "full" }) {
  const caseHref = useCaseHref();
  const trimmed = value.trim();
  if (trimmed === "") return <EmptyValue />;
  if (URL_RE.test(trimmed)) {
    return (
      <a
        href={trimmed}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "inline-flex max-w-full items-center gap-0.5 text-sm text-primary hover:underline",
          variant === "compact" ? "truncate" : "break-all",
        )}
        title={trimmed}
      >
        <span className={variant === "compact" ? "truncate" : "break-all"}>{trimmed}</span>
        <span aria-hidden>↗</span>
      </a>
    );
  }
  if (CASE_ID_RE.test(trimmed)) {
    return (
      <Link to={caseHref(trimmed)} className="font-mono text-sm text-primary hover:underline">
        {trimmed}
      </Link>
    );
  }
  if (variant === "compact") {
    return (
      <CopyableCompactValue value={value} className="text-sm">
        {value}
      </CopyableCompactValue>
    );
  }
  return <span className="text-sm break-words">{value}</span>;
}

export function CaseFieldValue({
  value,
  fieldKey,
  variant = "full",
}: {
  value: unknown;
  fieldKey?: string;
  variant?: "compact" | "full";
}) {
  if (value === null || value === undefined) return <EmptyValue />;

  const issueIdentifiers = extractIssueIdentifiers(value, fieldKey);
  if (issueIdentifiers.length > 0) return <IssueIdentifierValue identifiers={issueIdentifiers} />;

  if (typeof value === "string") return <StringValue value={value} variant={variant} />;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return <span className="text-sm">{String(value)}</span>;
    if (variant === "compact") {
      return (
        <CopyableCompactValue value={value} className="text-sm tabular-nums">
          {value.toLocaleString()}
        </CopyableCompactValue>
      );
    }
    return <span className="text-sm tabular-nums">{value.toLocaleString()}</span>;
  }

  if (typeof value === "boolean") {
    return value ? (
      <Check className="h-4 w-4 text-green-600 dark:text-green-400" aria-label="true" />
    ) : (
      <EmptyValue />
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <EmptyValue />;
    if (variant === "compact") {
      return (
        <CopyableCompactValue value={value} className="text-sm text-muted-foreground">
          {stringifyCopyValue(value)}
        </CopyableCompactValue>
      );
    }
    return (
      <div className="flex flex-wrap justify-start gap-1">
        {value.map((item, index) => (
          <Badge key={index} variant="secondary" className="font-normal">
            {typeof item === "string" || typeof item === "number" || typeof item === "boolean"
              ? String(item)
              : JSON.stringify(item)}
          </Badge>
        ))}
      </div>
    );
  }

  if (isPlainObject(value)) {
    const snippet = JSON.stringify(value);
    if (variant === "compact") {
      return (
        <CopyableCompactValue value={value} className="font-mono text-xs text-muted-foreground">
          {snippet}
        </CopyableCompactValue>
      );
    }
    return (
      <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }

  return <span className="text-sm">{String(value)}</span>;
}

export function CaseFieldsPanel({ fields }: { fields: Record<string, unknown> }) {
  const entries = Object.entries(fields ?? {});

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">Fields</h2>
        <span className="text-xs text-muted-foreground">from the skill&apos;s schema — rendered generically</span>
      </div>
      <Card className="gap-0 py-0">
        {entries.length === 0 ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">No fields set</div>
        ) : (
          <dl className="divide-y divide-border">
            {entries.map(([key, value]) => (
              <div key={key} className="flex items-start justify-between gap-4 px-4 py-1.5">
                <dt className="shrink-0 text-xs text-muted-foreground">{key}</dt>
                <dd className="min-w-0 max-w-(--pct-70) text-right">
                  <CaseFieldValue value={value} fieldKey={key} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
    </section>
  );
}
