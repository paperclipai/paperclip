import { useCallback, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../../lib/utils";

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

interface ToolPayloadViewProps {
  /** Raw value – string (possibly JSON-encoded), object, or anything. */
  value: unknown;
  /** Extra class for the outer wrapper. */
  className?: string;
  /** When true the text uses the error colour scheme. */
  isError?: boolean;
  /** Placeholder shown when value is falsy. */
  placeholder?: string;
}

/**
 * Renders a tool-call payload (input or result) with:
 * - JSON syntax highlighting (keys, strings, numbers, booleans, null)
 * - A copy-to-clipboard button
 * - Semantic detection for file paths & URLs shown as highlights
 */
export function ToolPayloadView({
  value,
  className,
  isError = false,
  placeholder = "<empty>",
}: ToolPayloadViewProps) {
  const text = normalizePayload(value);
  const displayText = text || placeholder;

  return (
    <div className={cn("group/payload relative", className)}>
      {text && <CopyButton text={text} />}
      <pre
        className={cn(
          "overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.6]",
          isError ? "text-red-700 dark:text-red-300" : "text-foreground/80",
        )}
      >
        {text ? <HighlightedJson text={text} isError={isError} /> : placeholder}
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Copy button                                                        */
/* ------------------------------------------------------------------ */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // clipboard access denied – fail silently
    });
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/payload:opacity-100"
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  JSON syntax highlighting (zero-dependency, render-time only)       */
/* ------------------------------------------------------------------ */

/**
 * Parses `text` as JSON and returns highlighted <span> elements.
 * Falls back to plain text with path/url highlights if not valid JSON.
 */
function HighlightedJson({ text, isError }: { text: string; isError: boolean }): ReactNode {
  // Attempt JSON parse for structured highlighting.
  try {
    const parsed = JSON.parse(text);
    // Only highlight objects/arrays – plain scalars stay as-is.
    if (typeof parsed === "object" && parsed !== null) {
      return renderJsonValue(parsed, 0, isError);
    }
  } catch {
    // Not JSON – fall through to plain-text path.
  }

  return highlightPlainText(text, isError);
}

/** Recursively render a parsed JSON value with syntax colours. */
function renderJsonValue(value: unknown, depth: number, isError: boolean): ReactNode {
  if (value === null) return <span className={nullClass(isError)}>null</span>;
  if (typeof value === "boolean") return <span className={boolClass(isError)}>{String(value)}</span>;
  if (typeof value === "number") return <span className={numClass(isError)}>{String(value)}</span>;

  if (typeof value === "string") {
    const escaped = JSON.stringify(value);
    // Detect file paths & URLs for semantic highlighting.
    if (looksLikePath(value) || looksLikeUrl(value)) {
      return <span className={pathClass(isError)}>{escaped}</span>;
    }
    return <span className={strClass(isError)}>{escaped}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <>{"[]"}</>;
    const indent = "  ".repeat(depth + 1);
    const closing = "  ".repeat(depth);
    return (
      <>
        {"[\n"}
        {value.map((item, i) => (
          <span key={i}>
            {indent}
            {renderJsonValue(item, depth + 1, isError)}
            {i < value.length - 1 ? ",\n" : "\n"}
          </span>
        ))}
        {closing}{"]"}
      </>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <>{"{}"}</>;
    const indent = "  ".repeat(depth + 1);
    const closing = "  ".repeat(depth);
    return (
      <>
        {"{\n"}
        {entries.map(([key, val], i) => (
          <span key={key}>
            {indent}
            <span className={keyClass(isError)}>{JSON.stringify(key)}</span>
            {": "}
            {renderJsonValue(val, depth + 1, isError)}
            {i < entries.length - 1 ? ",\n" : "\n"}
          </span>
        ))}
        {closing}{"}"}
      </>
    );
  }

  return <>{String(value)}</>;
}

/** Highlight file paths and URLs in non-JSON plain text. */
function highlightPlainText(text: string, isError: boolean): ReactNode {
  // Match absolute/relative file paths and http(s) URLs.
  const pattern = /(?:\/[\w./-]+(?:\.\w+)?)|(?:https?:\/\/[^\s)]+)/g;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={match.index} className={pathClass(isError)}>
        {match[0]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? <>{parts}</> : <>{text}</>;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function normalizePayload(value: unknown): string {
  if (!value && value !== 0 && value !== false) return "";
  if (typeof value === "string") {
    // If the string is itself JSON-encoded, pretty-print it.
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function looksLikePath(value: string): boolean {
  return /^[./~].*\//.test(value) || /^[a-zA-Z]:\\/.test(value);
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

/* Colour classes – vary based on error state so they remain legible. */
const keyClass = (e: boolean) =>
  e ? "text-red-500 dark:text-red-400" : "text-sky-700 dark:text-sky-300";
const strClass = (e: boolean) =>
  e ? "text-red-600 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300";
const numClass = (e: boolean) =>
  e ? "text-red-600 dark:text-red-300" : "text-amber-700 dark:text-amber-300";
const boolClass = (e: boolean) =>
  e ? "text-red-600 dark:text-red-300" : "text-violet-700 dark:text-violet-300";
const nullClass = (e: boolean) =>
  e ? "text-red-500/70 dark:text-red-400/70" : "text-muted-foreground";
const pathClass = (e: boolean) =>
  e ? "text-red-500 dark:text-red-300 underline decoration-red-500/30" : "text-sky-600 dark:text-sky-400 underline decoration-sky-500/30";
