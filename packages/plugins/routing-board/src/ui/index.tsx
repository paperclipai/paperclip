import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import {
  usePluginData,
  usePluginToast,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { SLOT_IDS } from "../constants.js";
type Routing = {
  id: string;
  label: string;
  orchestrator: "claude_code" | "opencode";
  adapterType: string;
  command?: string;
  model?: string | null;
  effort?: string;
  engine?: string;
  free?: boolean;
  badges?: string[];
  note?: string;
  builtin?: boolean;
  available?: boolean;
  reason?: string;
};

type Agent = {
  id: string;
  name: string;
  role: string;
  status: string;
  adapterType: string;
};

type Overview = {
  freeLanesOnly: boolean;
  defaultRouting: string;
  routings: Routing[];
  agents: Agent[];
};

const styles: Record<string, CSSProperties> = {
  page: { display: "grid", gap: "20px", padding: "20px 28px", maxWidth: 1100 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 22, fontWeight: 700, margin: 0 },
  badge: { fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 20, border: "1px solid #263040" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "12px" },
  card: { border: "1px solid #263040", borderRadius: 12, padding: "14px", background: "#11161d" },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
  cardId: { fontFamily: "monospace", fontWeight: 700, fontSize: 13 },
  pill: { fontSize: 10.5, background: "#1b232e", border: "1px solid #263040", padding: "2px 7px", borderRadius: 12, color: "#818cf8" },
  muted: { color: "#8b98a9", fontSize: 12 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #263040", color: "#8b98a9", fontSize: 11.5, textTransform: "uppercase" as const, letterSpacing: ".05em" },
  td: { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #263040" },
  chip: { fontFamily: "monospace", fontSize: 11, padding: "2px 8px", borderRadius: 12, background: "#0f1f2a", color: "#38bdf8", border: "1px solid #1e4a63" },
  ok: { color: "#34d399" },
  bad: { color: "#f87171" },
  select: { padding: "8px 10px", background: "#0b0f14", color: "#d7e0ea", border: "1px solid #263040", borderRadius: 8, fontSize: 13 },
  input: { padding: "8px 10px", background: "#0b0f14", color: "#d7e0ea", border: "1px solid #263040", borderRadius: 8, fontSize: 13, width: "100%" },
  btn: { padding: "8px 14px", background: "#1b232e", color: "#d7e0ea", border: "1px solid #263040", borderRadius: 8, fontSize: 13, cursor: "pointer" },
  btnPrimary: { padding: "8px 14px", background: "#38bdf8", color: "#04121a", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" },
  formRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 },
  field: { display: "flex", flexDirection: "column", gap: 5, fontSize: 13, color: "#8b98a9" },
};

function RoutingPageBody({ context }: { context: PluginPageProps["context"] }) {
  const { companyId } = context;
  const overview = usePluginData<Overview>("routing-board-overview", {
    companyId: companyId ?? undefined,
  });
  const toast = usePluginToast();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [routings, setRoutings] = useState<Routing[]>([]);
  const [freeLanesOnly, setFreeLanesOnly] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<Partial<Routing>>({});

  useEffect(() => {
    if (overview?.data) {
      setAgents(overview.data.agents ?? []);
      setRoutings(overview.data.routings ?? []);
      setFreeLanesOnly(overview.data.freeLanesOnly ?? true);
    }
  }, [overview?.data]);

  const runTool = async (name: string, params: Record<string, unknown>) => {
    // NOTE: the plugin UI has no direct worker tool channel; usePluginAction is
    // the supported path. This helper is a no-op placeholder kept for call sites
    // that record intent; the actual apply/heartbeat calls go through
    // applyRoutingToAgent (Paperclip REST API, same-origin).
    return { recorded: true, name, params };
  };

  // Apply a routing to an agent via Paperclip's own REST API. The plugin UI
  // runs inside the authenticated board session, so same-origin fetch carries
  // the session auth. PATCH /agents/:id with replaceAdapterConfig:true swaps
  // the agent's adapter config; this is the exact mechanism validated for the
  // routing board. Sensitive env values are passed as secret-ref bindings
  // (see resolveEnv in the worker / bootstrap) — never plaintext keys.
  const applyRoutingToAgent = async (agentId: string, routingId: string, opts: { heartbeat?: boolean } = {}) => {
    const routing = routings.find((r) => r.id === routingId);
    if (!routing) return;
    const adapterConfig: Record<string, unknown> = {
      ...(routing.model ? { model: routing.model } : {}),
      ...(routing.command ? { command: routing.command } : {}),
      ...(routing.effort ? { effort: routing.effort } : {}),
      ...(routing.engine ? { engine: routing.engine } : {}),
    };
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adapterType: routing.adapterType,
          replaceAdapterConfig: true,
          adapterConfig,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`PATCH agent failed: ${res.status} ${body.slice(0, 200)}`);
      }
      if (opts.heartbeat) {
        const hb = await fetch(`/api/agents/${encodeURIComponent(agentId)}/heartbeat/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!hb.ok) throw new Error(`heartbeat invoke failed: ${hb.status}`);
      }
      toast?.({ title: `Routing '${routingId}' applied to ${agentId}${opts.heartbeat ? " + heartbeat" : ""}` });
    } catch (e) {
      toast?.({ title: `Apply failed: ${(e as Error).message}` });
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.id || !form.label) return;
    await runTool("routing-create", {
      id: form.id,
      label: form.label,
      adapterType: form.adapterType ?? "opencode_local",
      orchestrator: form.orchestrator ?? "opencode",
      model: form.model || undefined,
      command: form.command || undefined,
      badges: form.badges ?? [],
      free: form.free !== false,
      note: form.note,
    });
    setFormOpen(false);
    setForm({});
  };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Routing</h1>
        <span style={{ ...styles.badge, ...(freeLanesOnly ? styles.ok : styles.bad) }}>
          {freeLanesOnly ? "FREE LANES ONLY" : "all lanes allowed"}
        </span>
      </div>

      <section>
        <h2 style={{ fontSize: 15, marginBottom: 10 }}>Agents</h2>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Agent</th>
              <th style={styles.th}>Role</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Adapter</th>
              <th style={styles.th}>Run with routing</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td style={styles.td}>{a.name}</td>
                <td style={styles.td}>{a.role}</td>
                <td style={styles.td}>{a.status}</td>
                <td style={styles.td}>{a.adapterType}</td>
                <td style={styles.td}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <RoutingPicker
                      routings={routings}
                      value=""
                      onChange={(rid) => applyRoutingToAgent(a.id, rid, { heartbeat: true })}
                    />
                    <button
                      style={{ ...styles.btn, fontSize: 12 }}
                      title="Apply routing to the agent's adapter config (no heartbeat)"
                      onClick={() => {
                        const rid = window.prompt("Routing id to set as agent default:");
                        if (rid) applyRoutingToAgent(a.id, rid);
                      }}
                    >
                      set default
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <div style={{ ...styles.header, marginBottom: 10 }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Routing registry</h2>
          <button style={styles.btn} onClick={() => setFormOpen((v) => !v)}>
            {formOpen ? "Cancel" : "+ Add routing"}
          </button>
        </div>

        {formOpen && (
          <form onSubmit={onSubmit} style={{ border: "1px solid #263040", borderRadius: 12, padding: 16, marginBottom: 16 }}>
            <div style={styles.formRow}>
              <label style={styles.field}>ID
                <input style={styles.input} value={form.id ?? ""} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="oc-gemini" />
              </label>
              <label style={styles.field}>Label
                <input style={styles.input} value={form.label ?? ""} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="OpenCode + Gemini" />
              </label>
            </div>
            <div style={styles.formRow}>
              <label style={styles.field}>Adapter
                <select style={styles.select} value={form.adapterType ?? "opencode_local"} onChange={(e) => setForm({ ...form, adapterType: e.target.value })}>
                  <option value="opencode_local">opencode_local</option>
                  <option value="claude_local">claude_local</option>
                </select>
              </label>
              <label style={styles.field}>Model
                <input style={styles.input} value={form.model ?? ""} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="opencode-go/deepseek-v4-flash" />
              </label>
            </div>
            <div style={styles.formRow}>
              <label style={styles.field}>Command
                <input style={styles.input} value={form.command ?? ""} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="opencode | claude | ccb" />
              </label>
              <label style={styles.field}>Badges (comma sep)
                <input style={styles.input} value={(form.badges ?? []).join(",")} onChange={(e) => setForm({ ...form, badges: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
              </label>
            </div>
            <button type="submit" style={styles.btnPrimary}>Save routing</button>
          </form>
        )}

        <div style={styles.grid}>
          {routings.map((r) => (
            <div key={r.id} style={styles.card}>
              <div style={styles.cardHead}>
                <span style={styles.cardId}>{r.id}</span>
                <span style={{ fontSize: 11, fontWeight: 700, ...(r.available ? styles.ok : styles.bad) }}>
                  {r.available ? "available" : "blocked"}
                </span>
              </div>
              <div style={{ ...styles.muted, margin: "4px 0" }}>{r.label}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, margin: "6px 0" }}>
                {(r.badges ?? []).map((b) => <span key={b} style={styles.pill}>{b}</span>)}
                {r.free && <span style={{ ...styles.pill, color: "#34d399" }}>free</span>}
              </div>
              {!r.available && r.reason && <div style={{ ...styles.muted, fontSize: 11 }}>{r.reason}</div>}
              {r.note && <div style={{ ...styles.muted, fontSize: 11, marginTop: 4 }}>{r.note}</div>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function RoutingPicker({ routings, value, onChange }: { routings: Routing[]; value: string; onChange: (rid: string) => void }) {
  return (
    <select style={styles.select} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">routing…</option>
      {routings.filter((r) => r.available).map((r) => (
        <option key={r.id} value={r.id}>{r.id}</option>
      ))}
    </select>
  );
}

export function RoutingPage({ context }: PluginPageProps) {
  return <RoutingPageBody context={context} />;
}

export function RoutingSidebarLink(_props: PluginSidebarProps) {
  // The host renders the sidebar label from the slot's displayName; this export
  // exists so the sidebar slot resolves to a real component if the host mounts
  // custom content for sidebar links.
  return null;
}

export const __routeMap = { [SLOT_IDS.page]: "routing" };
