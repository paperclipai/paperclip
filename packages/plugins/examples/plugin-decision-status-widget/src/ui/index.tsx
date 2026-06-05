import { useEffect, useState, useCallback } from "react";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Approval {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  payload?: {
    title?: string;
    summary?: string;
  };
}

interface IssueInteraction {
  id: string;
  kind: "request_confirmation" | "ask_user_questions" | "suggest_tasks";
  status: "pending" | "accepted" | "rejected" | "expired";
  payload?: {
    title?: string;
    prompt?: string;
    questions?: Array<{ id: string; text: string }>;
    tasks?: Array<{ title: string }>;
  };
  createdAt: string;
}

interface InReviewIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  executionState: unknown;
  updatedAt: string;
  pendingInteractions?: IssueInteraction[];
}

interface DecisionData {
  approvals: Approval[];
  inReviewIssues: InReviewIssue[];
  loadedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function interactionLabel(kind: IssueInteraction["kind"]): string {
  switch (kind) {
    case "request_confirmation": return "Bestätigung erwartet";
    case "ask_user_questions": return "Fragen ausstehend";
    case "suggest_tasks": return "Aufgaben vorgeschlagen";
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "gerade eben";
  if (mins < 60) return `vor ${mins} Min.`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.floor(hours / 24);
  return `vor ${days} Tag${days !== 1 ? "en" : ""}`;
}

async function fetchDecisionData(companyId: string): Promise<DecisionData> {
  const [approvalsRes, issuesRes] = await Promise.all([
    fetch(`/api/companies/${companyId}/approvals?status=pending`),
    fetch(`/api/companies/${companyId}/issues?status=in_review`),
  ]);

  if (!approvalsRes.ok) throw new Error(`Approvals ${approvalsRes.status}`);
  if (!issuesRes.ok) throw new Error(`Issues ${issuesRes.status}`);

  const approvals: Approval[] = await approvalsRes.json();
  const allIssues: InReviewIssue[] = await issuesRes.json();

  const recentIssues = [...allIssues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 15);

  const withInteractions = await Promise.all(
    recentIssues.map(async (issue) => {
      try {
        const res = await fetch(`/api/issues/${issue.id}/interactions`);
        if (!res.ok) return { ...issue, pendingInteractions: [] };
        const all: IssueInteraction[] = await res.json();
        return { ...issue, pendingInteractions: all.filter((i) => i.status === "pending") };
      } catch {
        return { ...issue, pendingInteractions: [] };
      }
    }),
  );

  return {
    approvals: approvals.filter((a) => a.status === "pending"),
    inReviewIssues: withInteractions,
    loadedAt: new Date().toISOString(),
  };
}

// ─── Sub-components ──────────────────────────────────────────────────────────

const sectionStyle: React.CSSProperties = { marginBottom: "14px" };

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  marginBottom: "8px",
};

const labelStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--muted-foreground, #888)",
};

function Badge({ count }: { count: number }) {
  return (
    <span style={{
      fontSize: "10px",
      fontWeight: 700,
      background: count > 0 ? "var(--destructive, #ef4444)" : "var(--muted, #e5e7eb)",
      color: count > 0 ? "white" : "var(--muted-foreground, #888)",
      borderRadius: "9999px",
      padding: "1px 6px",
      lineHeight: "1.4",
    }}>
      {count}
    </span>
  );
}

function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      style={{
        display: "block",
        padding: "7px 10px",
        borderRadius: "6px",
        border: "1px solid var(--border, #e2e8f0)",
        background: "var(--card, #fff)",
        color: "inherit",
        textDecoration: "none",
        marginBottom: "5px",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "var(--accent, #f1f5f9)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "var(--card, #fff)"; }}
    >
      {children}
    </a>
  );
}

function CardRow({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
      <div style={{ flex: 1, minWidth: 0 }}>{left}</div>
      <span style={{ fontSize: "11px", color: "var(--muted-foreground, #888)", flexShrink: 0 }}>{right}</span>
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "12px", color: "var(--foreground, #111)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {children}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: "10px", fontWeight: 600, color: "var(--primary, #6366f1)", marginRight: "4px" }}>
      {children}
    </span>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: "10px", fontFamily: "monospace", color: "var(--muted-foreground, #888)", marginRight: "6px" }}>
      {children}
    </span>
  );
}

// ─── Main Widget ──────────────────────────────────────────────────────────────

export function DecisionStatusWidget({ context }: PluginWidgetProps) {
  const [data, setData] = useState<DecisionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const companyId = context.companyId ?? "";
  const prefix = context.companyPrefix ?? "RENA";

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchDecisionData(companyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fehler beim Laden");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => { void load(); }, 90_000);
    return () => clearInterval(interval);
  }, [load]);

  const interactionItems: Array<{ issue: InReviewIssue; interaction: IssueInteraction }> =
    (data?.inReviewIssues ?? []).flatMap((issue) =>
      (issue.pendingInteractions ?? []).map((interaction) => ({ issue, interaction })),
    );

  const reviewIssues = (data?.inReviewIssues ?? []).filter(
    (issue) =>
      (issue.pendingInteractions ?? []).length === 0 &&
      (issue.executionState != null || issue.assigneeUserId != null),
  );

  const totalCount = (data?.approvals.length ?? 0) + interactionItems.length + reviewIssues.length;

  if (loading && !data) {
    return <div style={{ fontSize: "13px", color: "var(--muted-foreground, #888)", padding: "4px 0" }}>Lade…</div>;
  }

  if (error) {
    return (
      <div style={{ fontSize: "12px", color: "var(--destructive, #ef4444)" }}>
        Fehler: {error}{" "}
        <button onClick={() => { void load(); }} style={{ cursor: "pointer", textDecoration: "underline", background: "none", border: "none", color: "inherit", fontSize: "11px" }}>
          Neu laden
        </button>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* Widget header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 600, display: "flex", alignItems: "center", gap: "8px" }}>
          Ausstehende Entscheidungen
          {totalCount > 0 && (
            <span style={{ fontSize: "11px", fontWeight: 700, background: "var(--destructive, #ef4444)", color: "white", borderRadius: "9999px", padding: "2px 7px" }}>
              {totalCount}
            </span>
          )}
        </h3>
        <button
          onClick={() => { void load(); }}
          title="Aktualisieren"
          style={{ fontSize: "13px", cursor: "pointer", background: "none", border: "1px solid var(--border, #e2e8f0)", borderRadius: "4px", padding: "2px 6px", color: "var(--muted-foreground, #888)", lineHeight: 1 }}
        >
          ↺
        </button>
      </div>

      {totalCount === 0 && (
        <div style={{ fontSize: "13px", color: "var(--muted-foreground, #888)" }}>
          ✅ Keine ausstehenden Entscheidungen
        </div>
      )}

      {/* Approvals */}
      {(data?.approvals.length ?? 0) > 0 && (
        <div style={sectionStyle}>
          <div style={headerRowStyle}>
            <span style={{ fontSize: "13px" }}>🔐</span>
            <span style={labelStyle}>Genehmigungen</span>
            <Badge count={data!.approvals.length} />
          </div>
          {data!.approvals.map((approval) => (
            <CardLink key={approval.id} href={`/${prefix}/approvals/${approval.id}`}>
              <CardRow
                left={
                  <>
                    <Title>{approval.payload?.title ?? approval.type ?? "Approval"}</Title>
                    {approval.payload?.summary && (
                      <div style={{ fontSize: "11px", color: "var(--muted-foreground, #888)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {approval.payload.summary}
                      </div>
                    )}
                  </>
                }
                right={timeAgo(approval.createdAt)}
              />
            </CardLink>
          ))}
        </div>
      )}

      {/* Pending Interactions */}
      {interactionItems.length > 0 && (
        <div style={sectionStyle}>
          <div style={headerRowStyle}>
            <span style={{ fontSize: "13px" }}>💬</span>
            <span style={labelStyle}>Antwort erforderlich</span>
            <Badge count={interactionItems.length} />
          </div>
          {interactionItems.map(({ issue, interaction }) => {
            const issueRef = issue.identifier ?? issue.id.slice(0, 8);
            return (
              <CardLink key={`${issue.id}:${interaction.id}`} href={`/${prefix}/issues/${issueRef}`}>
                <CardRow
                  left={
                    <>
                      <div>
                        <Tag>{interactionLabel(interaction.kind)}</Tag>
                        <Mono>{issueRef}</Mono>
                      </div>
                      <Title>{issue.title}</Title>
                    </>
                  }
                  right={timeAgo(issue.updatedAt)}
                />
              </CardLink>
            );
          })}
        </div>
      )}

      {/* In-Review with exec policy or user-assigned */}
      {reviewIssues.length > 0 && (
        <div style={sectionStyle}>
          <div style={headerRowStyle}>
            <span style={{ fontSize: "13px" }}>👁</span>
            <span style={labelStyle}>Prüfung ausstehend</span>
            <Badge count={reviewIssues.length} />
          </div>
          {reviewIssues.map((issue) => {
            const issueRef = issue.identifier ?? issue.id.slice(0, 8);
            return (
              <CardLink key={issue.id} href={`/${prefix}/issues/${issueRef}`}>
                <CardRow
                  left={
                    <>
                      <div>
                        <Mono>{issueRef}</Mono>
                        {issue.executionState != null && <Tag>[Execution Policy]</Tag>}
                        {issue.assigneeUserId && <Tag>[User-Review]</Tag>}
                      </div>
                      <Title>{issue.title}</Title>
                    </>
                  }
                  right={timeAgo(issue.updatedAt)}
                />
              </CardLink>
            );
          })}
        </div>
      )}

      {data && (
        <div style={{ fontSize: "10px", color: "var(--muted-foreground, #888)", textAlign: "right", marginTop: "4px" }}>
          Zuletzt: {new Date(data.loadedAt).toLocaleTimeString("de-DE")}
        </div>
      )}
    </div>
  );
}
