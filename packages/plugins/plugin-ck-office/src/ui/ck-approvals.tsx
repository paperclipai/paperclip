import { useEffect, useState } from "react";
import {
  usePluginData,
  usePluginAction,
  StatusBadge,
  MetricCard,
  Spinner,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { DATA_APPROVALS, ACTION_APPROVAL_SEND, ACTION_APPROVAL_CANCEL } from "../manifest.js";

interface Pending {
  id: string;
  issueId: string;
  accountId: string;
  venue: string;
  to: string;
  subject: string;
  body: string;
  draftBody: string;
  edited: boolean;
  createdAt: string;
}
interface ApprovalsData {
  pending: Pending[];
  count: number;
  generatedAt: string;
}

const page: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 16, padding: 16, color: "#0f172a", maxWidth: 820 };
const card: React.CSSProperties = { border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 8, background: "#fff" };
const label: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.55 };
const input: React.CSSProperties = { width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid #cbd5e1", fontSize: 13, boxSizing: "border-box" };
const textarea: React.CSSProperties = { ...input, minHeight: 190, fontFamily: "inherit", lineHeight: 1.5, resize: "vertical" };
const btn = (bg: string, disabled?: boolean): React.CSSProperties => ({
  padding: "8px 14px", borderRadius: 8, border: "none", background: disabled ? "#94a3b8" : bg, color: "#fff",
  cursor: disabled ? "default" : "pointer", fontSize: 13, fontWeight: 600,
});

export function CkApprovalsPage(_props: PluginPageProps) {
  const { data, loading, error, refresh } = usePluginData<ApprovalsData>(DATA_APPROVALS);
  const send = usePluginAction(ACTION_APPROVAL_SEND);
  const cancel = usePluginAction(ACTION_APPROVAL_CANCEL);
  const [edits, setEdits] = useState<Record<string, { subject: string; body: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Native task-card decisions happen outside the plugin page. Poll the small
  // pending queue so a Hold/accept in another tab is reflected here without a
  // manual reload. The data handler also reconciles rejected/expired cards.
  useEffect(() => {
    const timer = window.setInterval(() => refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const pending = data?.pending ?? [];
  const val = (p: Pending) => edits[p.id] ?? { subject: p.subject, body: p.body };
  const setVal = (id: string, patch: Partial<{ subject: string; body: string }>, base: Pending) =>
    setEdits((e) => ({ ...e, [id]: { ...(e[id] ?? { subject: base.subject, body: base.body }), ...patch } }));

  async function approveSend(p: Pending) {
    const v = val(p);
    // eslint-disable-next-line no-alert
    if (!confirm(`Approve & Send for ${p.venue}?\n\nRequested: ${p.to}\nWithout CK_ESPO_SEND_LIVE=1 on the host, delivery goes to alan@treshermanos.ch (test-lock). Test/experiment wording is refused to venues.`)) return;
    setBusy(p.id); setMsg(null);
    try {
      const r = (await send({ id: p.id, subject: v.subject, body: v.body })) as { edited?: boolean; test_lock?: boolean; live_send?: boolean; delivered_to?: string } | undefined;
      const dest = r?.delivered_to || p.to;
      setMsg(`Delivered to ${dest}${r?.test_lock ? " (test-lock)" : r?.live_send ? " (LIVE)" : ""}${r?.edited ? " — your edit was saved as a lesson" : ""}.`);
      setEdits((e) => { const n = { ...e }; delete n[p.id]; return n; });
      refresh();
    } catch (e) {
      setMsg(`Send failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }
  async function drop(p: Pending) {
    // eslint-disable-next-line no-alert
    if (!confirm(`Cancel the outreach to ${p.venue}? It will not be sent.`)) return;
    setBusy(p.id);
    try { await cancel({ id: p.id }); refresh(); } finally { setBusy(null); }
  }

  if (loading && !data) return <div style={page}><Spinner /></div>;
  if (error) return <div style={page}><StatusBadge label={`Error: ${error.message}`} status="error" /></div>;

  return (
    <div style={page}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Outreach outbox</h1>
        <span style={{ opacity: 0.7, fontSize: 13 }}>Outreach emails waiting to send. Edit the wording if you like, then Approve &amp; Send. Any edit teaches the drafting agent.</span>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <MetricCard label="Pending" value={pending.length} />
      </div>
      {msg ? <div style={{ ...card, background: "#f0fdf4", borderColor: "#86efac", fontSize: 13 }}>{msg}</div> : null}

      {pending.length === 0 ? (
        <div style={{ ...card, alignItems: "center", opacity: 0.7 }}>Nothing to approve right now.</div>
      ) : pending.map((p) => {
        const v = val(p);
        const changed = v.body.trim() !== p.draftBody.trim() || v.subject.trim() !== p.subject.trim();
        const working = busy === p.id;
        return (
          <div key={p.id} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: 15 }}>{p.venue || p.accountId}</strong>
              {changed ? <StatusBadge label="edited" status="warning" /> : null}
            </div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>To: {p.to}</div>
            <div>
              <div style={label}>Betreff</div>
              <input style={input} value={v.subject} onChange={(e) => setVal(p.id, { subject: e.target.value }, p)} />
            </div>
            <div>
              <div style={label}>Nachricht</div>
              <textarea style={textarea} value={v.body} onChange={(e) => setVal(p.id, { body: e.target.value }, p)} />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button style={btn("#16a34a", working)} disabled={working} onClick={() => approveSend(p)}>{working ? "Sending…" : "Approve & Send"}</button>
              <button style={btn("#64748b", working)} disabled={working} onClick={() => drop(p)}>Cancel</button>
              {changed ? (
                <button style={{ ...btn("#e2e8f0"), color: "#334155" }} disabled={working} onClick={() => setEdits((e) => { const n = { ...e }; delete n[p.id]; return n; })}>Revert edits</button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
