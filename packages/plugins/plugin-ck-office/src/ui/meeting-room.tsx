import { useState } from "react";
import {
  usePluginData,
  StatusBadge,
  Spinner,
  type PluginPageProps,
  type StatusBadgeVariant,
} from "@paperclipai/plugin-sdk/ui";

// ── data shapes (mirror the worker's `ck-meeting-room` endpoint) ────────────────
interface RedTeam {
  opposing_hypothesis?: string;
  evidence?: string;
  observation?: string;
  model?: string;
}
interface MeetingIssue {
  id: string;
  sourceKind: string;
  title: string;
  impactScore: number;
  believability: number;
  identifiedRoot?: string | null;
  decision?: string | null;
  ownerUnit?: string | null;
  dueAt?: string | null;
  status: "open" | "solved" | "deferred";
  goldenCaseId?: string | null;
  redteam?: RedTeam | null;
  evidence?: Record<string, unknown>;
}
interface ScLine {
  name: string;
  pairedWith?: string | null;
  latest?: number | null;
  target?: number;
  better?: string;
  red?: boolean;
  outcome?: string;
}
interface Packet {
  kind?: string;
  constraint?: string;
  segue?: { wins?: string[] };
  scorecard?: ScLine[];
  okrs?: { id: string; name: string; objective: number; onTrack: boolean }[];
  rocks?: { id: string; name: string; status: string }[];
  headlines?: { text: string; actionNeeded: boolean }[];
  todos?: { total: number; done: number; donePct: number; stuck: string[] };
  spc_dropped?: { metric: string; reason: string }[];
  units_considered?: number;
  reds?: number;
  note?: string;
}
interface Selected {
  id: string;
  kind: string;
  companyName?: string;
  startedAt: string;
  finishedAt?: string | null;
  rating?: number | null;
  spendCents?: number | null;
  budgetCapCents?: number | null;
  packet: Packet;
  issues: MeetingIssue[];
}
interface MeetingSummary {
  id: string;
  kind: string;
  companyName?: string;
  startedAt: string;
  rating: number | null;
  issueCount: number;
  solvedCount: number;
}
interface MeetingRoomData {
  company: string;
  found: boolean;
  meetings: MeetingSummary[];
  selected: Selected | null;
}

const DATA_KEY = "ck-meeting-room";

// The seats around the table (meeting-flow.md "Roles in the room").
const SEATS = [
  { unit: "GOV-24", role: "Chair · Issues-Manager", tone: "#6366f1" },
  { unit: "GOV-04/05", role: "Scorecard", tone: "#0ea5e9" },
  { unit: "GOV-21", role: "Rock / OKR", tone: "#0ea5e9" },
  { unit: "Red-Team", role: "Mandated to disagree", tone: "#ef4444" },
  { unit: "GOV-12", role: "Believability", tone: "#a855f7" },
  { unit: "GOV-17", role: "Scribe · audit log", tone: "#64748b" },
];

function outcomeVariant(o?: string): StatusBadgeVariant {
  switch (o) {
    case "green":
      return "ok";
    case "promoted_signal":
      return "error";
    case "dropped_noise":
      return "info";
    default:
      return "pending";
  }
}
function statusVariant(s: string): StatusBadgeVariant {
  return s === "solved" ? "ok" : s === "deferred" ? "warning" : "pending";
}
function fmtDate(s?: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString();
  } catch {
    return String(s);
  }
}

// ── styles ──────────────────────────────────────────────────────────────────────
const page: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 16, padding: 16, color: "#0f172a" };
const card: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 14,
  background: "#ffffff",
  color: "#0f172a",
};
const sectionTitle: React.CSSProperties = { margin: "0 0 8px", fontSize: 13, letterSpacing: 0.4, textTransform: "uppercase", opacity: 0.7 };

function Segment({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: 6,
            background: "#6366f1",
            color: "#fff",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {n}
        </span>
        <h2 style={{ margin: 0, fontSize: 15 }}>{title}</h2>
      </div>
      {children}
    </div>
  );
}

export function MeetingRoomPage(_props: PluginPageProps) {
  const [meetingId, setMeetingId] = useState<string | undefined>(undefined);
  const { data, loading, error } = usePluginData<MeetingRoomData>(DATA_KEY, meetingId ? { meetingId } : {});

  if (loading && !data) return <div style={page}><Spinner /></div>;
  if (error) return <div style={page}><StatusBadge label={`Error: ${error.message}`} status="error" /></div>;

  const meetings = data?.meetings ?? [];
  const sel = data?.selected ?? null;
  const pkt = sel?.packet ?? {};
  const issues = sel?.issues ?? [];
  const solved = issues.filter((i) => i.status === "solved");
  const open = issues.filter((i) => i.status !== "solved");
  const wins = pkt.segue?.wins ?? [];
  const spcDropped = pkt.spc_dropped ?? [];
  const scorecard = pkt.scorecard ?? [];

  return (
    <div style={page}>
      {/* header + meeting picker */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>CK Meeting Room</h1>
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            {sel ? `${sel.companyName ?? "—"} · ${String(sel.kind).replace("_", " ")} · ${fmtDate(sel.startedAt)}` : "no meetings yet"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {sel?.rating != null && (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, color: sel.rating >= 8 ? "#22c55e" : sel.rating >= 5 ? "#eab308" : "#ef4444" }}>
                {sel.rating}<span style={{ fontSize: 13, opacity: 0.5 }}>/10</span>
              </div>
              <div style={{ fontSize: 11, opacity: 0.6 }}>self-rating</div>
            </div>
          )}
          <select
            value={sel?.id ?? ""}
            onChange={(e) => setMeetingId(e.target.value)}
            style={{ padding: "6px 8px", borderRadius: 8, background: "#ffffff", color: "#0f172a", border: "1px solid #e2e8f0" }}
          >
            {meetings.map((m) => (
              <option key={m.id} value={m.id}>
                {m.companyName ?? "—"} · {fmtDate(m.startedAt)} · {m.solvedCount}/{m.issueCount} solved{m.rating != null ? ` · ${m.rating}/10` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!sel && <div style={card}>No meeting to show yet. Run the <strong>CK Weekly Tactical</strong> job (or the budgeted IDS runner) and it will appear here.</div>}

      {sel && (
        <>
          {/* the table — seats around the room */}
          <div style={{ ...card, background: "radial-gradient(ellipse at center, #f8fafc 0%, #eef2f7 100%)" }}>
            <div style={sectionTitle}>Around the table</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {SEATS.map((s) => (
                <div key={s.unit} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 10px", borderRadius: 8, border: `1px solid ${s.tone}55`, background: `${s.tone}14`, minWidth: 120 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: s.tone }}>{s.unit}</span>
                  <span style={{ fontSize: 11, opacity: 0.75 }}>{s.role}</span>
                </div>
              ))}
            </div>
            {pkt.constraint && (
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
                🎯 Named constraint (Goldratt): <strong>{pkt.constraint}</strong>
              </div>
            )}
          </div>

          {/* 1 · Segue */}
          <Segment n="1" title="Segue / Good news">
            {wins.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>{wins.map((w, i) => <li key={i} style={{ fontSize: 14 }}>{w}</li>)}</ul>
            ) : (
              <span style={{ opacity: 0.6 }}>—</span>
            )}
          </Segment>

          {/* 2 · Scorecard + SPC */}
          <Segment n="2" title="Scorecard review · the SPC noise-vs-signal filter">
            {scorecard.length > 0 ? (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", opacity: 0.6 }}>
                    <th style={{ padding: "4px 6px" }}>Metric</th>
                    <th style={{ padding: "4px 6px" }}>Latest</th>
                    <th style={{ padding: "4px 6px" }}>Target</th>
                    <th style={{ padding: "4px 6px" }}>Paired with</th>
                    <th style={{ padding: "4px 6px" }}>SPC verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {scorecard.map((s, i) => (
                    <tr key={i} style={{ borderTop: "1px solid #e2e8f0" }}>
                      <td style={{ padding: "5px 6px" }}>{s.name}</td>
                      <td style={{ padding: "5px 6px" }}>{s.latest ?? "—"}</td>
                      <td style={{ padding: "5px 6px", opacity: 0.7 }}>{s.target ?? "—"}</td>
                      <td style={{ padding: "5px 6px", opacity: 0.7 }}>{s.pairedWith ?? "—"}</td>
                      <td style={{ padding: "5px 6px" }}>
                        <StatusBadge label={(s.outcome ?? "—").replace("_", " ")} status={outcomeVariant(s.outcome)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ fontSize: 13, opacity: 0.8 }}>
                SPC filter applied to {pkt.units_considered ?? "?"} unit(s): {pkt.reds ?? 0} red →{" "}
                {issues.length} promoted, {spcDropped.length} dropped as noise.
              </div>
            )}
            {spcDropped.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                <StatusBadge label="dropped as common-cause noise" status="info" />{" "}
                {spcDropped.map((d) => d.metric).join(", ")} — <em>not promoted to IDS (Deming: don't tune on noise).</em>
              </div>
            )}
          </Segment>

          {/* 3/4/5 — only when the full packet is present */}
          {(pkt.okrs?.length || pkt.rocks?.length) ? (
            <Segment n="3" title="Rock / OKR review">
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                {(pkt.okrs ?? []).map((o) => (
                  <div key={o.id} style={{ fontSize: 13 }}>
                    <StatusBadge label={o.onTrack ? "on track" : "off track"} status={o.onTrack ? "ok" : "error"} /> {o.name} ({o.objective.toFixed(2)})
                  </div>
                ))}
                {(pkt.rocks ?? []).map((r) => (
                  <div key={r.id} style={{ fontSize: 13 }}>
                    <StatusBadge label={r.status.replace("_", " ")} status={r.status === "on_track" ? "ok" : "error"} /> {r.name}
                  </div>
                ))}
              </div>
            </Segment>
          ) : null}

          {pkt.todos ? (
            <Segment n="5" title="To-Do review">
              <div style={{ fontSize: 13 }}>
                {pkt.todos.done}/{pkt.todos.total} done ({pkt.todos.donePct}%).{" "}
                {pkt.todos.stuck.length ? <span>Stuck → IDS: {pkt.todos.stuck.join(", ")}</span> : <span style={{ opacity: 0.6 }}>nothing stuck.</span>}
              </div>
            </Segment>
          ) : null}

          {/* 6 · IDS — the heart */}
          <Segment n="6" title="IDS — Identify · Discuss (Red-Team) · Solve">
            {issues.length === 0 && <span style={{ opacity: 0.6 }}>No issues on the list — clean week.</span>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {issues.map((it) => (
                <div key={it.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                    <strong style={{ fontSize: 14 }}>{it.title}</strong>
                    <StatusBadge label={it.status} status={statusVariant(it.status)} />
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.6, margin: "2px 0 8px" }}>
                    impact {it.impactScore.toFixed(2)} · believability {it.believability.toFixed(2)} · {it.sourceKind.replace("_", " ")}
                  </div>

                  {it.identifiedRoot && (
                    <div style={{ marginBottom: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#6366f1" }}>IDENTIFY · root cause</span>
                      <div style={{ fontSize: 13 }}>{it.identifiedRoot}</div>
                    </div>
                  )}

                  {it.redteam?.opposing_hypothesis && (
                    <div style={{ marginBottom: 8, padding: "8px 10px", borderLeft: "3px solid #ef4444", background: "#ef444412", borderRadius: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#ef4444" }}>DISCUSS · Red-Team objection{it.redteam.model ? ` (${it.redteam.model})` : ""}</span>
                      <div style={{ fontSize: 13 }}>{it.redteam.opposing_hypothesis}</div>
                      {it.redteam.evidence && <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>evidence: {it.redteam.evidence}</div>}
                    </div>
                  )}

                  {it.decision && (
                    <div style={{ marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#22c55e" }}>SOLVE · decision</span>
                      <div style={{ fontSize: 13 }}>{it.decision}</div>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
                    {it.ownerUnit && <StatusBadge label={`owner: ${it.ownerUnit}`} status="info" />}
                    {it.dueAt && <StatusBadge label={`due ${fmtDate(it.dueAt).slice(0, 10)}`} status="pending" />}
                    {it.goldenCaseId && <StatusBadge label="✓ golden case written" status="ok" />}
                  </div>
                </div>
              ))}
            </div>
          </Segment>

          {/* 7 · Conclude */}
          <Segment n="7" title="Conclude">
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
              <div>Decisions: <strong>{solved.length}</strong></div>
              <div>Deferred / open: <strong>{open.length}</strong></div>
              <div>Golden cases written: <strong>{solved.filter((s) => s.goldenCaseId).length}</strong></div>
              <div>Spend: <strong>{sel.spendCents ?? 0}¢</strong> / cap {sel.budgetCapCents ?? 0}¢</div>
              <div>Finished: <strong>{fmtDate(sel.finishedAt)}</strong></div>
            </div>
          </Segment>
        </>
      )}
    </div>
  );
}
