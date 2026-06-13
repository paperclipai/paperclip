import { useState, useEffect, useRef } from "react";
import { useHostContext, usePluginAction, usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";

interface IssueSummary {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
}

interface SearchResult {
  issues: IssueSummary[];
}

export function IssueLinkerToolbarButton() {
  const ctx = useHostContext();
  const toast = usePluginToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce the search query
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Focus input when modal opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const searchResult = usePluginData<SearchResult>(
    "searchIssues",
    ctx.companyId ? { companyId: ctx.companyId, query: debouncedQuery } : {},
  );

  const linkIssue = usePluginAction("linkIssue");

  async function handleSelect(targetIssueId: string, targetIdentifier: string) {
    if (!ctx.companyId || !ctx.entityId) return;
    try {
      await linkIssue({ companyId: ctx.companyId, sourceIssueId: ctx.entityId, targetIssueId });
      toast({ title: "Issue linked", body: `${targetIdentifier} added as blocker.`, tone: "success" });
      setOpen(false);
      setQuery("");
    } catch (err) {
      toast({ title: "Link failed", body: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: "4px 10px",
          fontSize: "12px",
          borderRadius: "4px",
          border: "1px solid #ccc",
          background: "#fff",
          cursor: "pointer",
        }}
      >
        Link related issue
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: "360px",
            background: "#fff",
            border: "1px solid #ddd",
            borderRadius: "6px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            zIndex: 9999,
            padding: "12px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
            <strong style={{ fontSize: "13px" }}>Link a related issue</strong>
            <button
              type="button"
              onClick={() => { setOpen(false); setQuery(""); }}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: "14px", color: "#666" }}
            >
              ✕
            </button>
          </div>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search issues…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "6px 8px",
              fontSize: "13px",
              border: "1px solid #ccc",
              borderRadius: "4px",
              marginBottom: "8px",
            }}
          />
          {searchResult.loading && (
            <div style={{ fontSize: "12px", color: "#888", padding: "4px 0" }}>Searching…</div>
          )}
          {searchResult.error && (
            <div style={{ fontSize: "12px", color: "#c00", padding: "4px 0" }}>
              {String(searchResult.error)}
            </div>
          )}
          {searchResult.data && searchResult.data.issues.length === 0 && (
            <div style={{ fontSize: "12px", color: "#888", padding: "4px 0" }}>No issues found.</div>
          )}
          {searchResult.data && searchResult.data.issues.length > 0 && (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: "240px", overflowY: "auto" }}>
              {searchResult.data.issues.map((issue) => (
                <li key={issue.id}>
                  <button
                    type="button"
                    onClick={() => void handleSelect(issue.id, issue.identifier)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      width: "100%",
                      textAlign: "left",
                      padding: "6px 8px",
                      border: "none",
                      borderRadius: "4px",
                      background: "none",
                      cursor: "pointer",
                      fontSize: "12px",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#f5f5f5"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
                  >
                    <span style={{ fontWeight: 500, color: "#555" }}>{issue.identifier}</span>
                    <span style={{ color: "#222" }}>{issue.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
