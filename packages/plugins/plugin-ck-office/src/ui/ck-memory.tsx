import { useMemo, useState } from "react";
import {
  usePluginData,
  usePluginAction,
  StatusBadge,
  MetricCard,
  Spinner,
  type PluginPageProps,
  type StatusBadgeVariant,
} from "@paperclipai/plugin-sdk/ui";
import { DATA_MEMORY, ACTION_MEMORY_CURATE } from "../manifest.js";

interface Mem {
  id: string;
  scope: string;
  store: string;
  key: string;
  value: string;
  source: string;
  status: string;
  confidence: number | null;
  reason: string | null;
  updatedAt: string;
}
interface MemData {
  memories: Mem[];
  counts: Record<string, number>;
  total: number;
  page: number;
  pageSize: number;
  generatedAt: string;
}

type MemoryFilter = "needs_review" | "verified" | "all";
const PAGE_SIZE = 25;
const MOBILE_PAGE_SIZE = 10;

function statusVariant(s: string): StatusBadgeVariant {
  switch (s) {
    case "verified": return "ok";
    case "unverified": return "pending";
    case "contested": return "warning";
    case "quarantined": return "error";
    case "expired": return "info";
    default: return "pending";
  }
}

const page: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 16, padding: 16, color: "#0f172a" };
const th: React.CSSProperties = { textAlign: "left", fontSize: 12, opacity: 0.6, padding: "6px 8px", borderBottom: "1px solid #e2e8f0" };
const td: React.CSSProperties = { fontSize: 13, padding: "8px", borderBottom: "1px solid #f1f5f9", verticalAlign: "top" };
const btn = (bg: string): React.CSSProperties => ({
  padding: "3px 8px", borderRadius: 6, border: "none", background: bg, color: "#fff",
  cursor: "pointer", fontSize: 11, fontWeight: 600, marginRight: 4,
});

export function CkMemoryPage(_props: PluginPageProps) {
  const [filter, setFilter] = useState<MemoryFilter>("needs_review");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [requestedPageSize] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches
      ? MOBILE_PAGE_SIZE
      : PAGE_SIZE,
  );
  const params = useMemo(
    () => ({ filter, query, page: currentPage, pageSize: requestedPageSize }),
    [filter, query, currentPage, requestedPageSize],
  );
  const { data, loading, error, refresh } = usePluginData<MemData>(DATA_MEMORY, params);
  const curate = usePluginAction(ACTION_MEMORY_CURATE);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, op: string) {
    setBusy(id);
    try {
      await curate({ id, op });
      refresh();
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) return <div style={page}><Spinner /></div>;
  if (error) return <div style={page}><StatusBadge label={`Error: ${error.message}`} status="error" /></div>;

  const mems = data?.memories ?? [];
  const c = data?.counts ?? {};
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? PAGE_SIZE;
  const pageNumber = data?.page ?? currentPage;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstResult = total === 0 ? 0 : (pageNumber - 1) * pageSize + 1;
  const lastResult = total === 0 ? 0 : Math.min(pageNumber * pageSize, total);

  function changeFilter(next: MemoryFilter) {
    setFilter(next);
    setCurrentPage(1);
  }

  function applySearch(event: React.FormEvent) {
    event.preventDefault();
    setQuery(queryInput.trim());
    setCurrentPage(1);
  }

  return (
    <div style={page}>
      <style>{`
        @media (max-width: 640px) {
          .ck-memory-table,
          .ck-memory-table tbody,
          .ck-memory-table tr,
          .ck-memory-table td {
            display: block;
            width: 100%;
          }
          .ck-memory-table thead {
            display: none;
          }
          .ck-memory-table tr {
            box-sizing: border-box;
            padding: 10px;
            border-bottom: 1px solid #e2e8f0;
          }
          .ck-memory-table tr:last-child {
            border-bottom: 0;
          }
          .ck-memory-table td {
            box-sizing: border-box;
            padding: 4px 0 !important;
            border-bottom: 0 !important;
          }
          .ck-memory-table td:not(:first-child)::before {
            content: attr(data-label);
            display: block;
            margin-bottom: 2px;
            color: #64748b;
            font-size: 10px;
            font-weight: 700;
            letter-spacing: .04em;
            text-transform: uppercase;
          }
          .ck-memory-table td[data-label="Curate"] {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            padding-top: 8px !important;
          }
          .ck-memory-table td[data-label="Curate"]::before {
            flex-basis: 100%;
          }
          .ck-memory-table td[data-label="Curate"] button {
            min-height: 34px;
          }
        }
      `}</style>
      <div>
        <h1 style={{ margin: 0, fontSize: 20 }}>CK Memory</h1>
        <span style={{ opacity: 0.7, fontSize: 13 }}>
          What the agents have learned across tasks — <strong>verify</strong> what's true, <strong>quarantine</strong> what's wrong,
          <strong> forget</strong> what's stale. "unverified" = one agent's claim, not yet corroborated.
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {(["needs_review", "verified", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => changeFilter(f)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: filter === f ? "2px solid #2563eb" : "1px solid #cbd5e1",
              background: filter === f ? "#eff6ff" : "#fff",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {f === "needs_review" ? "Needs review" : f === "verified" ? "Verified" : "All"}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <MetricCard label="Verified" value={c.verified || 0} />
        <MetricCard label="Unverified" value={c.unverified || 0} />
        <MetricCard label="Contested" value={c.contested || 0} />
        <MetricCard label="Quarantined" value={c.quarantined || 0} />
      </div>

      <form
        onSubmit={applySearch}
        style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
      >
        <label htmlFor="ck-memory-search" style={{ fontSize: 12, fontWeight: 600 }}>
          Search memories
        </label>
        <input
          id="ck-memory-search"
          type="search"
          value={queryInput}
          onChange={(event) => setQueryInput(event.target.value)}
          placeholder="Fact, key, or source"
          style={{
            minWidth: 220,
            flex: "1 1 280px",
            maxWidth: 520,
            padding: "7px 9px",
            border: "1px solid #cbd5e1",
            borderRadius: 8,
            fontSize: 13,
          }}
        />
        <button type="submit" style={btn("#2563eb")}>Search</button>
        {query && (
          <button
            type="button"
            onClick={() => {
              setQueryInput("");
              setQuery("");
              setCurrentPage(1);
            }}
            style={btn("#64748b")}
          >
            Clear
          </button>
        )}
        <span style={{ fontSize: 12, opacity: 0.65 }}>
          Showing {firstResult}–{lastResult} of {total}
        </span>
      </form>

      <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, overflowX: "auto", background: "#ffffff" }}>
        <table className="ck-memory-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Fact</th>
              <th style={th}>Scope</th>
              <th style={th}>Status</th>
              <th style={th}>Conf</th>
              <th style={th}>Source</th>
              <th style={th}>Curate</th>
            </tr>
          </thead>
          <tbody>
            {mems.map((m) => (
              <tr key={m.id}>
                <td data-label="Fact" style={td}>
                  <div style={{ fontWeight: 600 }}>{m.value}</div>
                  <div style={{ opacity: 0.5, fontSize: 11 }}>{m.key}{m.reason ? ` · ${m.reason}` : ""}</div>
                </td>
                <td data-label="Scope" style={td}>{m.scope}</td>
                <td data-label="Status" style={td}><StatusBadge label={m.status} status={statusVariant(m.status)} /></td>
                <td data-label="Confidence" style={td}>{m.confidence != null ? `${Math.round(m.confidence * 100)}%` : "—"}</td>
                <td data-label="Source" style={{ ...td, fontSize: 11, opacity: 0.6 }}>{String(m.source || "").slice(0, 24)}</td>
                <td data-label="Curate" style={td}>
                  {m.status !== "verified" && (
                    <button disabled={busy === m.id} onClick={() => act(m.id, "verify")} style={btn("#22c55e")}>Verify</button>
                  )}
                  {m.status !== "quarantined" && (
                    <button disabled={busy === m.id} onClick={() => act(m.id, "quarantine")} style={btn("#ef4444")}>Quarantine</button>
                  )}
                  <button disabled={busy === m.id} onClick={() => act(m.id, "forget")} style={btn("#64748b")}>Forget</button>
                </td>
              </tr>
            ))}
            {mems.length === 0 && (
              <tr><td style={td} colSpan={6}>No memories yet. Agents write durable facts here as they work.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <nav aria-label="Memory pages" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            disabled={pageNumber <= 1 || loading}
            onClick={() => setCurrentPage((value) => Math.max(1, value - 1))}
            style={btn(pageNumber <= 1 ? "#94a3b8" : "#334155")}
          >
            Previous
          </button>
          <span style={{ fontSize: 12 }}>Page {pageNumber} of {totalPages}</span>
          <button
            type="button"
            disabled={pageNumber >= totalPages || loading}
            onClick={() => setCurrentPage((value) => Math.min(totalPages, value + 1))}
            style={btn(pageNumber >= totalPages ? "#94a3b8" : "#334155")}
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
