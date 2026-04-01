import { usePluginData, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps, PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { DATA_KEYS, TOOL_NAMES } from "../constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DecisionItem =
  | { kind: "approval"; companyId: string; data: { id: string; type: string; payload: Record<string, unknown>; requestedAt: string } }
  | { kind: "blocked_issue"; companyId: string; data: { id: string; identifier: string; title: string; updatedAt: string } };

type QueueData = {
  items: DecisionItem[];
  totalApprovals: number;
  totalBlockedIssues: number;
  fetchedAt?: string;
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ApprovalRow({ item }: { item: Extract<DecisionItem, { kind: "approval" }> }) {
  const plan = (item.data.payload as { plan?: string }).plan ?? "(no description)";
  return (
    <li style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
      <strong>Approval</strong> — {item.data.type}
      <div style={{ color: "#555", fontSize: 13, marginTop: 2 }}>{plan.slice(0, 120)}{plan.length > 120 ? "…" : ""}</div>
      <div style={{ color: "#888", fontSize: 11, marginTop: 2 }}>
        {new Date(item.data.requestedAt).toLocaleString()}
      </div>
    </li>
  );
}

function BlockedIssueRow({ item }: { item: Extract<DecisionItem, { kind: "blocked_issue" }> }) {
  const unblock = usePluginAction(TOOL_NAMES.UNBLOCK_ISSUE);
  const handleUnblock = () => {
    unblock({
      issueId: item.data.id,
      companyId: item.companyId,
      reason: "Manually unblocked via Decision Surface",
    });
  };
  return (
    <li style={{ padding: "8px 0", borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
      <div>
        <strong>{item.data.identifier}</strong> — {item.data.title}
        <div style={{ color: "#888", fontSize: 11, marginTop: 2 }}>
          Updated {new Date(item.data.updatedAt).toLocaleString()}
        </div>
      </div>
      <button
        onClick={handleUnblock}
        style={{ marginLeft: 12, padding: "4px 10px", fontSize: 12, cursor: "pointer", borderRadius: 4, border: "1px solid #ccc", background: "#f5f5f5" }}
      >
        Unblock
      </button>
    </li>
  );
}

function QueueList({ data, companyId }: { data: QueueData; companyId: string }) {
  const items = data.items ?? [];
  if (items.length === 0) {
    return <p style={{ color: "#888" }}>Nothing requires action right now.</p>;
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {items.map((item, i) =>
        item.kind === "approval" ? (
          <ApprovalRow key={`a-${item.data.id}-${i}`} item={item} />
        ) : (
          <BlockedIssueRow key={`b-${item.data.id}-${i}`} item={{ ...item, companyId }} />
        ),
      )}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget (compact)
// ---------------------------------------------------------------------------

export function DecisionSurfaceWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<QueueData>(DATA_KEYS.QUEUE, {
    companyId: context.companyId,
  });

  return (
    <section style={{ fontFamily: "inherit", fontSize: 14 }}>
      <strong style={{ fontSize: 15 }}>Decision Queue</strong>
      {loading && <p style={{ color: "#888" }}>Loading…</p>}
      {error && <p style={{ color: "red" }}>Error loading queue.</p>}
      {data && (
        <>
          <div style={{ color: "#555", marginBottom: 8, fontSize: 12 }}>
            {data.totalApprovals} approval{data.totalApprovals !== 1 ? "s" : ""} · {data.totalBlockedIssues} blocked issue{data.totalBlockedIssues !== 1 ? "s" : ""}
          </div>
          <QueueList data={data} companyId={context.companyId ?? ""} />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Full page (/decisions)
// ---------------------------------------------------------------------------

export function DecisionSurfacePage({ context }: PluginPageProps) {
  const { data, loading, error, refresh } = usePluginData<QueueData>(DATA_KEYS.QUEUE, {
    companyId: context.companyId,
  });

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px", fontFamily: "inherit" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Decision Queue</h1>
        <button
          onClick={() => refresh?.()}
          style={{ padding: "6px 14px", fontSize: 13, cursor: "pointer", borderRadius: 4, border: "1px solid #ccc", background: "#f5f5f5" }}
        >
          Refresh
        </button>
      </div>

      {loading && <p style={{ color: "#888" }}>Loading…</p>}
      {error && <p style={{ color: "red" }}>Failed to load queue. Check plugin health.</p>}

      {data && (
        <>
          <div style={{ color: "#555", marginBottom: 16 }}>
            <strong>{data.items?.length ?? 0}</strong> item{(data.items?.length ?? 0) !== 1 ? "s" : ""} requiring action
            {data.fetchedAt && (
              <span style={{ marginLeft: 8, fontSize: 12, color: "#aaa" }}>
                (as of {new Date(data.fetchedAt).toLocaleTimeString()})
              </span>
            )}
          </div>

          {data.totalApprovals > 0 && (
            <section style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 16, marginBottom: 8 }}>Pending Approvals ({data.totalApprovals})</h2>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {data.items.filter((i) => i.kind === "approval").map((item, idx) => (
                  <ApprovalRow key={idx} item={item as Extract<DecisionItem, { kind: "approval" }>} />
                ))}
              </ul>
            </section>
          )}

          {data.totalBlockedIssues > 0 && (
            <section>
              <h2 style={{ fontSize: 16, marginBottom: 8 }}>Blocked Issues ({data.totalBlockedIssues})</h2>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {data.items.filter((i) => i.kind === "blocked_issue").map((item, idx) => (
                  <BlockedIssueRow
                    key={idx}
                    item={item as Extract<DecisionItem, { kind: "blocked_issue" }>}
                  />
                ))}
              </ul>
            </section>
          )}

          {(data.items?.length ?? 0) === 0 && (
            <p style={{ color: "#888" }}>Nothing requires action right now. ✓</p>
          )}
        </>
      )}
    </main>
  );
}
