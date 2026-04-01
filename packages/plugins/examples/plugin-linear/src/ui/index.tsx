import { useState, type CSSProperties, type ReactNode } from "react";
import { usePluginData, usePluginAction, type PluginWidgetProps, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { LinearSnapshot, LinearSummaryResult, IssueRow, CycleSnapshot, ProjectSnapshot } from "../types.js";

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

const C: CSSProperties = { padding: "12px 14px", borderRadius: 8, border: "1px solid var(--border,#2a2a2a)", background: "var(--card,#111)" };
const muted = "var(--muted-foreground,#888)";
const accent = "#5e6ad2";

function M({ label, value, detail, color }: { label: string; value: string | number; detail?: ReactNode; color?: string }) {
  return (
    <div style={C}>
      <div style={{ fontSize: 11, color: muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: "tabular-nums", color }}>{value}</div>
      {detail && <div style={{ fontSize: 11, color: "var(--muted-foreground,#999)", marginTop: 4 }}>{detail}</div>}
    </div>
  );
}

function Bar({ value, color = accent, h = 6 }: { value: number; color?: string; h?: number }) {
  return (
    <div style={{ height: h, borderRadius: h / 2, background: "var(--border,#2a2a2a)", overflow: "hidden", width: "100%" }}>
      <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, value))}%`, background: color, borderRadius: h / 2, transition: "width .3s" }} />
    </div>
  );
}

function Spin({ label }: { label?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: muted }}>
      <svg width="16" height="16" viewBox="0 0 16 16" style={{ animation: "spin 1s linear infinite" }}>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" />
      </svg>
      {label && <span style={{ fontSize: 13 }}>{label}</span>}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

const Dot = ({ p }: { p: number }) => {
  const c = { 1: "#ef4444", 2: "#f59e0b", 3: accent, 4: "#6b7280" }[p] ?? "#404040";
  return <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: c, flexShrink: 0 }} />;
};

const Bdg = ({ children, bg }: { children: ReactNode; bg: string }) =>
  <span style={{ display: "inline-block", padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: bg, color: "#fff" }}>{children}</span>;

const ago = (iso: string) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

const fmtH = (h: number) => h < 1 ? `${Math.round(h * 60)}m` : h < 24 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;

const stColor = (s: string) => {
  const l = s.toLowerCase();
  if (l.includes("done") || l.includes("complete")) return "#22c55e";
  if (l.includes("progress") || l.includes("started") || l.includes("review")) return accent;
  if (l.includes("cancel")) return "#ef4444";
  return "#6b7280";
};

const pjColor = (s: string) => ({ started: accent, planned: "#f59e0b", paused: "#6b7280", completed: "#22c55e", cancelled: "#ef4444" }[s.toLowerCase()] ?? "#888");

const btn: CSSProperties = { padding: "6px 14px", borderRadius: 6, border: "1px solid var(--border,#333)", background: "var(--card,#111)", color: "var(--foreground,#eee)", cursor: "pointer", fontSize: 12, fontWeight: 500 };
const btnP: CSSProperties = { ...btn, border: "none", background: accent, color: "#fff" };
const th: CSSProperties = { textAlign: "left", padding: "8px 12px", borderBottom: "2px solid var(--border,#2a2a2a)", fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: muted, letterSpacing: ".06em" };
const td: CSSProperties = { padding: "8px 12px", borderBottom: "1px solid var(--border,#2a2a2a)", verticalAlign: "top" };
const secTitle: CSSProperties = { fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: muted, marginBottom: 10 };

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

export function LinearDashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<LinearSummaryResult>("linear-summary", { companyId: context.companyId ?? "" });
  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 24 }}><Spin label="Loading Linear" /></div>;
  if (error) return <div style={{ padding: 12, borderRadius: 6, border: "1px solid var(--destructive,#e55)", color: "var(--destructive,#e55)", fontSize: 13 }}>{error.message}</div>;
  if (!data?.snapshot) return <div style={{ textAlign: "center", padding: 24, color: muted, fontSize: 11 }}><LIcon /><br />{data?.message ?? "Waiting for first sync…"}</div>;

  const s = data.snapshot;
  const cy = s.activeCycles[0];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: 6 }}><LIcon /> Linear</h3>
        <span style={{ fontSize: 11, color: muted, fontFamily: "monospace" }}>{s.workspace}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <M label="Completed (7d)" value={s.issuesCompletedThisWeek} color="#22c55e" detail={`${s.issuesCreatedThisWeek} created`} />
        <M label="Open Issues" value={s.totalOpenIssues} detail={`${s.teamCount} teams`} />
        <M label="Avg Resolution" value={fmtH(s.avgResolutionHours)} detail="create → done" />
        {cy ? <M label={`Cycle — ${cy.teamKey}`} value={`${cy.progress}%`} color={accent} detail={<Bar value={cy.progress} />} /> : <M label="Cycles" value={s.activeCycles.length} />}
      </div>
      <div style={{ fontSize: 10, color: "var(--muted-foreground,#999)" }}>Synced {ago(s.syncedAt)} · {s.activeProjects.length} projects · {s.activeCycles.length} cycles</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Tab = "overview" | "issues" | "cycles" | "projects";

export function LinearPage({ context }: PluginPageProps) {
  const { data, loading, error, refresh } = usePluginData<LinearSummaryResult>("linear-summary", { companyId: context.companyId ?? "" });
  const { data: issues, loading: iLoad } = usePluginData<IssueRow[]>("issue-list", { companyId: context.companyId ?? "" });
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const doSync = usePluginAction("sync-now");

  const handleSync = async () => { setSyncing(true); try { await doSync({ companyId: context.companyId ?? "" }); refresh(); } finally { setSyncing(false); } };

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 24 }}><Spin label="Loading Linear" /></div>;
  if (error) return <div style={{ padding: 12, color: "var(--destructive,#e55)", fontSize: 13 }}>{error.message}</div>;
  if (!data?.snapshot) return (
    <div style={{ maxWidth: 1200 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}><LIcon size={22} /> Linear</h2>
      <div style={{ textAlign: "center", padding: 24, color: muted }}>{data?.message ?? "No data yet."}<br /><button onClick={handleSync} disabled={syncing} style={btnP}>{syncing ? "Syncing…" : "Sync Now"}</button></div>
    </div>
  );

  const s = data.snapshot;
  const tabs: Tab[] = ["overview", "issues", "cycles", "projects"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1200 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <LIcon size={22} /> Linear — <span style={{ fontWeight: 400, fontFamily: "monospace" }}>{s.workspace}</span>
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "var(--muted-foreground,#999)" }}>Synced {ago(s.syncedAt)}</span>
          <button onClick={handleSync} disabled={syncing} style={btn}>{syncing ? "Syncing…" : "Sync Now"}</button>
        </div>
      </div>

      <div style={{ display: "flex" }}>
        {tabs.map((t, i) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "7px 18px", border: "1px solid var(--border,#333)", cursor: "pointer", fontSize: 13, fontWeight: 500,
            background: tab === t ? accent : "transparent", color: tab === t ? "#fff" : muted,
            borderRadius: i === 0 ? "6px 0 0 6px" : i === tabs.length - 1 ? "0 6px 6px 0" : 0,
          }}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>

      {tab === "overview" && <Overview s={s} />}
      {tab === "issues" && <Issues rows={issues ?? []} loading={iLoad} />}
      {tab === "cycles" && <Cycles cycles={s.activeCycles} />}
      {tab === "projects" && <Projects projects={s.activeProjects} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function Overview({ s }: { s: LinearSnapshot }) {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 }}>
        <M label="Open Issues" value={s.totalOpenIssues} />
        <M label="Created (7d)" value={s.issuesCreatedThisWeek} />
        <M label="Completed (7d)" value={s.issuesCompletedThisWeek} color="#22c55e" />
        <M label="Avg Resolution" value={fmtH(s.avgResolutionHours)} detail="create → done" />
        <M label="Active Cycles" value={s.activeCycles.length} />
        <M label="Active Projects" value={s.activeProjects.length} />
      </div>

      {/* Priority bars */}
      <div style={{ marginTop: 20 }}>
        <h4 style={secTitle}>Priority Distribution</h4>
        <div style={{ ...C, padding: 16, display: "flex", gap: 8, alignItems: "flex-end", height: 100 }}>
          {Object.entries(s.priorityDistribution).map(([label, count]) => {
            const max = Math.max(...Object.values(s.priorityDistribution), 1);
            const c: Record<string, string> = { urgent: "#ef4444", high: "#f59e0b", medium: accent, low: "#6b7280", none: "#404040" };
            return (
              <div key={label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: c[label] ?? "#888", fontVariantNumeric: "tabular-nums" }}>{count}</span>
                <div style={{ width: "100%", height: `${Math.max(4, (count / max) * 100)}%`, background: c[label] ?? "#888", borderRadius: 3 }} />
                <span style={{ fontSize: 9, color: "#888", textTransform: "capitalize" }}>{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Teams + Assignees */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 20 }}>
        <div>
          <h4 style={secTitle}>Teams</h4>
          <div style={{ ...C, padding: "8px 14px" }}>
            {s.teams.map((t) => (
              <div key={t.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid var(--border,#2a2a2a)", fontSize: 13 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Bdg bg={accent}>{t.key}</Bdg> {t.name}</span>
                <span style={{ fontFamily: "monospace", fontSize: 12 }}><span style={{ color: "#22c55e" }}>{t.completedThisWeek}✓</span> <span style={{ color: "#888" }}>{t.openIssues} open</span></span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h4 style={secTitle}>Top Assignees (7d)</h4>
          <div style={{ ...C, padding: "8px 14px" }}>
            {s.topAssignees.map((a) => (
              <div key={a.name} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--border,#2a2a2a)", fontSize: 13 }}>
                <span>{a.name}</span>
                <span style={{ fontFamily: "monospace", fontSize: 12 }}><span style={{ color: "#22c55e" }}>{a.completedThisWeek}✓</span> <span style={{ color: accent }}>{a.inProgress} wip</span></span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Cycles preview */}
      {s.activeCycles.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h4 style={secTitle}>Active Cycles</h4>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 10 }}>
            {s.activeCycles.map((c) => (
              <div key={c.teamKey + c.number} style={{ ...C, padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{c.teamKey} — Cycle {c.number}</span>
                  <span style={{ fontSize: 11, color: "#888" }}>{c.daysRemaining}d left</span>
                </div>
                <Bar value={c.progress} />
                <div style={{ fontSize: 11, color: "#888", marginTop: 6 }}>{c.progress}%</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Issues({ rows, loading }: { rows: IssueRow[]; loading: boolean }) {
  const [q, setQ] = useState("");
  const filtered = q ? rows.filter((i) => [i.title, i.identifier, i.assignee, i.team].some((f) => f?.toLowerCase().includes(q.toLowerCase()))) : rows;

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h4 style={{ ...secTitle, margin: 0 }}>Issues ({filtered.length})</h4>
        <input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border,#333)", background: "var(--card,#111)", color: "var(--foreground,#eee)", fontSize: 12, width: 260, outline: "none" }} />
      </div>
      {loading ? <Spin label="Loading issues" /> : !filtered.length ? <div style={{ ...C, textAlign: "center", padding: 24, color: "#888" }}>No issues found</div> : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>{["ID", "P", "Title", "Status", "Assignee", "Team", "Updated"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {filtered.slice(0, 100).map((i) => (
                <tr key={i.identifier}>
                  <td style={td}><span style={{ fontFamily: "monospace", fontSize: 12 }}>{i.identifier}</span></td>
                  <td style={td}><Dot p={i.priority} /></td>
                  <td style={td}>{i.title}</td>
                  <td style={td}><span style={{ color: stColor(i.state), fontSize: 12 }}>{i.state}</span></td>
                  <td style={td}>{i.assignee ?? <span style={{ color: "#666" }}>—</span>}</td>
                  <td style={td}><Bdg bg="#333">{i.team}</Bdg></td>
                  <td style={td}><span style={{ fontSize: 11, color: "#888" }}>{ago(i.updatedAt)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 100 && <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: "#888" }}>Showing 100 of {filtered.length}</div>}
        </div>
      )}
    </div>
  );
}

function Cycles({ cycles }: { cycles: CycleSnapshot[] }) {
  if (!cycles.length) return <div style={{ ...C, textAlign: "center", padding: 24, color: "#888", marginTop: 16 }}>No active cycles</div>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 16, marginTop: 16 }}>
      {cycles.map((c) => (
        <div key={c.teamKey + c.number} style={{ ...C, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}><Bdg bg={accent}>{c.teamKey}</Bdg> {c.name ?? `Cycle ${c.number}`}</div>
              <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>{new Date(c.startsAt).toLocaleDateString()} — {new Date(c.endsAt).toLocaleDateString()}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: accent, fontVariantNumeric: "tabular-nums" }}>{c.progress}%</div>
              <div style={{ fontSize: 11, color: "#888" }}>{c.daysRemaining}d left</div>
            </div>
          </div>
          <Bar value={c.progress} h={8} />
        </div>
      ))}
    </div>
  );
}

function Projects({ projects }: { projects: ProjectSnapshot[] }) {
  if (!projects.length) return <div style={{ ...C, textAlign: "center", padding: 24, color: "#888", marginTop: 16 }}>No active projects</div>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 12, marginTop: 16 }}>
      {projects.map((p) => (
        <div key={p.name} style={{ ...C, padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
              <div style={{ fontSize: 11, color: "#888", marginTop: 2, display: "flex", gap: 8 }}>
                <span style={{ color: pjColor(p.state) }}>{p.state}</span>
                {p.lead && <span>Lead: {p.lead}</span>}
              </div>
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: accent, fontVariantNumeric: "tabular-nums" }}>{p.progress}%</div>
          </div>
          <Bar value={p.progress} color={pjColor(p.state)} />
          {p.targetDate && <div style={{ fontSize: 10, color: "#888", marginTop: 6 }}>Target: {new Date(p.targetDate).toLocaleDateString()}</div>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function LIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M1.22541 61.5228c-.97022 1.7064-.56784 3.8469.97308 5.0916l31.1807 25.1456c1.211.9768 2.9532 1.0577 4.2536.1975l59.5794-39.398c2.4562-1.6236 2.2959-5.2726-.2885-6.6632L32.5233.459C30.8476-.4927 28.7639.0286 27.5756 1.5433L1.22541 61.5228z" />
    </svg>
  );
}
