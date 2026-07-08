import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Link, useCaseHref } from "@/lib/router";

// -----------------------------------------------------------------------------
// CaseFieldsPanel (PAP-12968 §3) — the generic key-value renderer for a case's
// `fields` JSON blob. The server stores arbitrary agent-authored JSON, so the UI
// renders by *value type* (Postel's law: never crash on unexpected shapes) and
// preserves the skill's key insertion order (does NOT alphabetize).
// -----------------------------------------------------------------------------

const URL_RE = /^https?:\/\/\S+$/i;
const CASE_ID_RE = /^[A-Z][A-Z0-9]*-C\d+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A muted em-dash for null / empty / missing values. */
function EmptyValue() {
  return <span className="text-muted-foreground">—</span>;
}

function StringValue({ value }: { value: string }) {
  const caseHref = useCaseHref();
  const trimmed = value.trim();
  if (trimmed === "") return <EmptyValue />;
  if (URL_RE.test(trimmed)) {
    return (
      <a
        href={trimmed}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-0.5 truncate text-sm text-primary hover:underline"
        title={trimmed}
      >
        <span className="truncate">{trimmed}</span>
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
  return <span className="text-sm break-words">{value}</span>;
}

export function CaseFieldValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <EmptyValue />;

  if (typeof value === "string") return <StringValue value={value} />;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return <span className="text-sm">{String(value)}</span>;
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
    return (
      <div className="flex flex-wrap justify-end gap-1">
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
    return (
      <span
        className="block max-w-full truncate font-mono text-xs text-muted-foreground"
        title={snippet}
      >
        {snippet}
      </span>
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
                  <CaseFieldValue value={value} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
    </section>
  );
}
