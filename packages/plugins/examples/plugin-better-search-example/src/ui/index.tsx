import { useEffect, useState, type CSSProperties } from "react";
import {
  useHostContext,
  usePluginData,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import type { SearchResult } from "../worker.js";

type SearchData = {
  results: SearchResult[];
  query: string;
  error?: string;
};

type AuthorFilter = "all" | "human" | "agent";

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "8px",
  fontSize: "13px",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  borderRadius: "6px",
  border: "1px solid var(--border)",
  background: "var(--background)",
  color: "var(--foreground)",
  fontSize: "13px",
  boxSizing: "border-box",
  outline: "none",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  gap: "4px",
  flexWrap: "wrap",
};

function chipStyle(active: boolean): CSSProperties {
  return {
    padding: "2px 8px",
    borderRadius: "12px",
    border: `1px solid ${active ? "var(--primary, #6366f1)" : "var(--border)"}`,
    background: active ? "var(--primary, #6366f1)" : "transparent",
    color: active ? "var(--primary-foreground, #fff)" : "var(--foreground)",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: active ? 600 : 400,
  };
}

const resultListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  maxHeight: "420px",
  overflowY: "auto",
};

function resultItemStyle(hovered: boolean): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "6px 8px",
    borderRadius: "6px",
    background: hovered
      ? "color-mix(in srgb, var(--accent, #6366f1) 15%, transparent)"
      : "transparent",
    cursor: "pointer",
    textDecoration: "none",
    color: "inherit",
    border: "1px solid transparent",
    transition: "background 0.1s",
  };
}

function authorBadgeStyle(type: SearchResult["latestAuthorType"]): CSSProperties {
  const colors: Record<SearchResult["latestAuthorType"], { bg: string; color: string }> = {
    human: { bg: "color-mix(in srgb, #22c55e 20%, transparent)", color: "#15803d" },
    agent: { bg: "color-mix(in srgb, #6366f1 20%, transparent)", color: "#4338ca" },
    unknown: { bg: "color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--muted-foreground)" },
  };
  const { bg, color } = colors[type];
  return {
    display: "inline-block",
    padding: "1px 5px",
    borderRadius: "4px",
    background: bg,
    color,
    fontSize: "10px",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
  };
}

const statusDotColors: Record<string, string> = {
  done: "#22c55e",
  cancelled: "#94a3b8",
  in_progress: "#6366f1",
  in_review: "#f59e0b",
  blocked: "#ef4444",
  todo: "#64748b",
  backlog: "#94a3b8",
};

function StatusDot({ status }: { status: string }) {
  const color = statusDotColors[status] ?? "#94a3b8";
  return (
    <span
      style={{
        display: "inline-block",
        width: "7px",
        height: "7px",
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        marginTop: "1px",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Result row
// ---------------------------------------------------------------------------

function ResultRow({
  result,
  issuesPath,
}: {
  result: SearchResult;
  issuesPath: (id: string) => string;
}) {
  const [hovered, setHovered] = useState(false);
  const authorLabel =
    result.latestAuthorType === "human"
      ? "Human"
      : result.latestAuthorType === "agent"
      ? "AI"
      : "?";

  return (
    <a
      href={issuesPath(result.identifier ?? result.id)}
      style={resultItemStyle(hovered)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "6px" }}>
        <StatusDot status={result.status} />
        <span
          style={{
            flex: 1,
            fontWeight: 500,
            lineHeight: "1.3",
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical" as const,
          }}
        >
          {result.title}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", paddingLeft: "13px" }}>
        {result.identifier && (
          <span style={{ color: "var(--muted-foreground)", fontSize: "11px" }}>
            {result.identifier}
          </span>
        )}
        <span style={authorBadgeStyle(result.latestAuthorType)}>{authorLabel}</span>
      </div>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function BetterSearchPanel() {
  const context = useHostContext();
  const [inputValue, setInputValue] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filter, setFilter] = useState<AuthorFilter>("all");

  // Debounce input → query
  useEffect(() => {
    if (!inputValue.trim()) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(inputValue.trim()), 350);
    return () => clearTimeout(timer);
  }, [inputValue]);

  const searchData = usePluginData<SearchData>(
    "searchIssues",
    debouncedQuery && context.companyId
      ? { companyId: context.companyId, q: debouncedQuery }
      : undefined
  );

  const allResults = searchData.data?.results ?? [];
  const filtered =
    filter === "all"
      ? allResults
      : allResults.filter((r) => r.latestAuthorType === filter);

  function issuesPath(identifier: string): string {
    return context.companyPrefix
      ? `/${context.companyPrefix}/issues/${identifier}`
      : `/issues/${identifier}`;
  }

  const isSearching = searchData.loading && debouncedQuery.length > 0;
  const hasError = !!searchData.error;
  const hasQuery = debouncedQuery.length > 0;

  return (
    <div style={panelStyle}>
      <input
        type="search"
        placeholder="Search issues…"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        style={inputStyle}
        autoComplete="off"
        spellCheck={false}
      />

      {hasQuery && (
        <div style={chipRowStyle}>
          {(["all", "human", "agent"] as AuthorFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              style={chipStyle(filter === f)}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f === "human" ? "Human" : "AI Agent"}
            </button>
          ))}
        </div>
      )}

      {isSearching && (
        <div style={{ color: "var(--muted-foreground)", fontSize: "12px", padding: "4px 0" }}>
          Searching…
        </div>
      )}

      {hasError && (
        <div style={{ color: "#ef4444", fontSize: "12px", padding: "4px 0" }}>
          Search error. Try again.
        </div>
      )}

      {!isSearching && hasQuery && !hasError && (
        <>
          {filtered.length === 0 ? (
            <div style={{ color: "var(--muted-foreground)", fontSize: "12px", padding: "4px 0" }}>
              No results
              {filter !== "all" ? ` for ${filter === "human" ? "Human" : "AI Agent"} filter` : ""}
            </div>
          ) : (
            <div style={resultListStyle}>
              {filtered.map((result) => (
                <ResultRow key={result.id} result={result} issuesPath={issuesPath} />
              ))}
            </div>
          )}
          <div
            style={{
              color: "var(--muted-foreground)",
              fontSize: "11px",
              borderTop: "1px solid var(--border)",
              paddingTop: "6px",
            }}
          >
            {filtered.length} result{filtered.length !== 1 ? "s" : ""}
            {allResults.length !== filtered.length
              ? ` of ${allResults.length} total`
              : ""}
          </div>
        </>
      )}

      {!hasQuery && (
        <div style={{ color: "var(--muted-foreground)", fontSize: "12px", padding: "4px 0" }}>
          Deep search across titles, descriptions, and comments.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar nav entry
// ---------------------------------------------------------------------------

export function BetterSearchSidebar({ context }: PluginSidebarProps) {
  const companyPrefix = context.companyPrefix;
  const href = companyPrefix ? `/${companyPrefix}` : "/";

  return (
    <a
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 8px",
        borderRadius: "6px",
        textDecoration: "none",
        color: "var(--foreground)",
        fontSize: "13px",
        fontWeight: 500,
      }}
      title="Better Search"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="6.5" cy="6.5" r="4.5" />
        <line x1="10.5" y1="10.5" x2="14" y2="14" />
      </svg>
      <span>Search</span>
    </a>
  );
}
