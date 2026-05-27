import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  useHostNavigation,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  ACTION_KEYS,
  DATA_KEYS,
  ROUTES,
} from "../constants.js";

// ── Styles ────────────────────────────────────────────────────────────────────

const stack: CSSProperties = { display: "grid", gap: "12px" };
const card: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "16px",
  background: "var(--card, transparent)",
};
const subtleCard: CSSProperties = {
  ...card,
  border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
  padding: "12px",
};
const h1Style: CSSProperties = { fontSize: "20px", fontWeight: 700, margin: 0 };
const h2Style: CSSProperties = { fontSize: "15px", fontWeight: 600, margin: 0 };
const smallMuted: CSSProperties = { fontSize: "12px", color: "var(--muted-foreground)" };
const row: CSSProperties = { display: "flex", alignItems: "center", gap: "8px" };
const badge = (color: string): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "9999px",
  fontSize: "11px",
  fontWeight: 600,
  background: color,
  color: "#fff",
});

// ── Shared types ──────────────────────────────────────────────────────────────

type Feature = {
  id?: string;
  titulo?: string;
  prioridade?: string;
  status?: string;
  tasks_pendentes?: string[];
  projeto?: string;
};

type FeaturesData = {
  versao?: string;
  features?: Feature[];
  missao?: {
    titulo?: string;
    status?: string;
    horizon_horas?: number;
  };
};

type Handoff = {
  papel?: string;
  inicio?: string;
  fim?: string;
  concluido?: boolean;
  tokens?: number;
  pendente?: string;
  _legacy?: boolean;
};

type MissionStatus = {
  missao?: { titulo?: string; status?: string };
  totalFeatures?: number;
  doneFeatures?: number;
  pendingFeatures?: number;
  activeHandoffs?: number;
  totalHandoffs?: number;
};

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useFeatures(companyId: string) {
  return usePluginData<FeaturesData>(DATA_KEYS.features, { companyId });
}

function useHandoffs(companyId: string) {
  return usePluginData<Handoff[]>(DATA_KEYS.handoffs, { companyId });
}

function useBrainDump(companyId: string) {
  return usePluginData<{ content: string }>(DATA_KEYS.brainDumpNotes, { companyId });
}

function useMissionStatus(companyId: string) {
  return usePluginData<MissionStatus>(DATA_KEYS.missionStatus, { companyId });
}

// ── Priority color mapping ────────────────────────────────────────────────────

function prioColor(p: string | undefined) {
  if (p === "P0") return "#dc2626";
  if (p === "P1") return "#d97706";
  if (p === "P2") return "#2563eb";
  return "#6b7280";
}

function statusColor(s: string | undefined) {
  if (s === "done" || s === "concluido") return "#16a34a";
  if (s === "em_progresso") return "#d97706";
  if (s === "pendente") return "#6b7280";
  return "#6b7280";
}

function StatusBadge({ status }: { status?: string }) {
  const label =
    status === "done" ? "done"
    : status === "concluido" ? "concluído"
    : status === "em_progresso" ? "em progresso"
    : status ?? "—";
  return <span style={badge(statusColor(status))}>{label}</span>;
}

// ── Sidebar link helper ───────────────────────────────────────────────────────

function SidebarLink({
  route,
  label,
  icon,
}: {
  route: string;
  label: string;
  icon: ReactNode;
}) {
  const hostNavigation = useHostNavigation();
  const href = hostNavigation.resolveHref(`/${route}`);
  const isActive =
    typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      {...hostNavigation.linkProps(`/${route}`)}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      <span className="relative shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </a>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const IconBrainDump = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.44-4.66Z" />
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.44-4.66Z" />
  </svg>
);

const IconInbox = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);

const IconEisenhower = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="8" height="8" rx="1" />
    <rect x="13" y="3" width="8" height="8" rx="1" />
    <rect x="3" y="13" width="8" height="8" rx="1" />
    <rect x="13" y="13" width="8" height="8" rx="1" />
  </svg>
);

const IconAutopilot = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
  </svg>
);

const IconPriorityMatrix = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="2" x2="12" y2="22" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <circle cx="7" cy="7" r="2" fill="currentColor" stroke="none" opacity="0.7" />
    <circle cx="17" cy="7" r="2.5" fill="currentColor" stroke="none" opacity="0.5" />
    <circle cx="7" cy="17" r="1.5" fill="currentColor" stroke="none" opacity="0.4" />
    <circle cx="17" cy="17" r="1" fill="currentColor" stroke="none" opacity="0.3" />
  </svg>
);

// ═══════════════════════════════════════════════════════════════════════════════
// BRAIN DUMP
// ═══════════════════════════════════════════════════════════════════════════════

export function BrainDumpSidebarLink(_: PluginSidebarProps) {
  return <SidebarLink route={ROUTES.brainDump} label="Brain Dump" icon={<IconBrainDump />} />;
}

export function BrainDumpPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const brainDump = useBrainDump(companyId);
  const saveAction = usePluginAction(ACTION_KEYS.saveBrainDump);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (brainDump.data?.content !== undefined) {
      setText(brainDump.data.content);
    }
  }, [brainDump.data?.content]);

  async function handleSave() {
    setSaving(true);
    await saveAction({ content: text });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={{ ...stack, padding: "24px", maxWidth: "800px" }}>
      <div style={row}>
        <h1 style={h1Style}>Brain Dump</h1>
        {saved && <span style={{ ...smallMuted, color: "#16a34a" }}>✓ Salvo</span>}
      </div>
      <p style={smallMuted}>
        Capture ideias, pensamentos e notas sem filtro. Salvo em ~/state/brain-dump.md.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{
          width: "100%",
          minHeight: "400px",
          padding: "12px",
          borderRadius: "8px",
          border: "1px solid var(--border)",
          background: "var(--background)",
          color: "var(--foreground)",
          fontSize: "14px",
          fontFamily: "monospace",
          resize: "vertical",
          outline: "none",
          boxSizing: "border-box",
        }}
        placeholder="Dump seus pensamentos aqui..."
      />
      <div style={row}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: "8px 16px",
            borderRadius: "6px",
            border: "none",
            background: "var(--primary)",
            color: "var(--primary-foreground)",
            fontWeight: 600,
            cursor: saving ? "not-allowed" : "pointer",
            fontSize: "13px",
          }}
        >
          {saving ? "Salvando…" : "Salvar"}
        </button>
        <span style={smallMuted}>{text.length} caracteres</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INBOX
// ═══════════════════════════════════════════════════════════════════════════════

export function InboxSidebarLink(_: PluginSidebarProps) {
  return <SidebarLink route={ROUTES.inbox} label="app1n Inbox" icon={<IconInbox />} />;
}

export function InboxPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const featuresResult = useFeatures(companyId);
  const features = (featuresResult.data?.features ?? []) as Feature[];
  const pending = features.filter((f) => f.status !== "done" && f.status !== "concluido");

  return (
    <div style={{ ...stack, padding: "24px", maxWidth: "900px" }}>
      <h1 style={h1Style}>app1n Inbox</h1>
      <p style={smallMuted}>
        Features pendentes do backlog ({pending.length} de {features.length})
      </p>

      {featuresResult.loading && <p style={smallMuted}>Carregando…</p>}
      {!featuresResult.loading && pending.length === 0 && (
        <div style={{ ...card, textAlign: "center", color: "var(--muted-foreground)" }}>
          🎉 Inbox zerado! Todas as features estão concluídas.
        </div>
      )}

      {pending.map((f, i) => (
        <div key={f.id ?? i} style={card}>
          <div style={{ ...row, justifyContent: "space-between", marginBottom: "8px" }}>
            <div style={row}>
              <span style={badge(prioColor(f.prioridade))}>{f.prioridade ?? "—"}</span>
              <span style={{ ...smallMuted, fontWeight: 600 }}>{f.projeto}</span>
            </div>
            <StatusBadge status={f.status} />
          </div>
          <p style={{ margin: 0, fontWeight: 600, fontSize: "14px" }}>{f.titulo}</p>
          {f.tasks_pendentes && f.tasks_pendentes.length > 0 && (
            <ul style={{ margin: "8px 0 0 0", paddingLeft: "16px", ...smallMuted }}>
              {f.tasks_pendentes.map((t, ti) => (
                <li key={ti}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EISENHOWER
// ═══════════════════════════════════════════════════════════════════════════════

export function EisenhowerSidebarLink(_: PluginSidebarProps) {
  return <SidebarLink route={ROUTES.eisenhower} label="Eisenhower" icon={<IconEisenhower />} />;
}

type EisenhowerQuadrant = "do" | "schedule" | "delegate" | "eliminate";

function eisenhowerQuadrant(f: Feature): EisenhowerQuadrant {
  const prio = f.prioridade;
  const status = f.status;
  const isUrgent = prio === "P0" || status === "em_progresso";
  const isImportant = prio === "P0" || prio === "P1";
  if (isUrgent && isImportant) return "do";
  if (!isUrgent && isImportant) return "schedule";
  if (isUrgent && !isImportant) return "delegate";
  return "eliminate";
}

const quadrantLabels: Record<EisenhowerQuadrant, { label: string; sub: string; color: string }> = {
  do: { label: "Fazer Agora", sub: "Urgente + Importante", color: "#dc2626" },
  schedule: { label: "Agendar", sub: "Importante, não urgente", color: "#2563eb" },
  delegate: { label: "Delegar", sub: "Urgente, não importante", color: "#d97706" },
  eliminate: { label: "Eliminar", sub: "Não urgente, não importante", color: "#6b7280" },
};

export function EisenhowerPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const featuresResult = useFeatures(companyId);
  const features = (featuresResult.data?.features ?? []).filter(
    (f) => f.status !== "done" && f.status !== "concluido"
  ) as Feature[];

  const quadrants: Record<EisenhowerQuadrant, Feature[]> = {
    do: [],
    schedule: [],
    delegate: [],
    eliminate: [],
  };
  for (const f of features) {
    quadrants[eisenhowerQuadrant(f)].push(f);
  }

  return (
    <div style={{ ...stack, padding: "24px" }}>
      <h1 style={h1Style}>Matriz de Eisenhower</h1>
      <p style={smallMuted}>Classificação automática por prioridade e status de execução</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        {(["do", "schedule", "delegate", "eliminate"] as EisenhowerQuadrant[]).map((q) => {
          const meta = quadrantLabels[q];
          return (
            <div key={q} style={{ ...card, borderTop: `3px solid ${meta.color}` }}>
              <h2 style={{ ...h2Style, color: meta.color, marginBottom: "2px" }}>{meta.label}</h2>
              <p style={{ ...smallMuted, marginBottom: "12px" }}>{meta.sub}</p>
              {quadrants[q].length === 0 ? (
                <p style={{ ...smallMuted, fontStyle: "italic" }}>Nenhuma feature</p>
              ) : (
                <div style={stack}>
                  {quadrants[q].map((f, i) => (
                    <div key={f.id ?? i} style={{ ...subtleCard, padding: "8px" }}>
                      <div style={row}>
                        <span style={badge(prioColor(f.prioridade))}>{f.prioridade}</span>
                        <span style={{ fontSize: "13px", fontWeight: 500 }}>{f.titulo}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOPILOT
// ═══════════════════════════════════════════════════════════════════════════════

export function AutopilotSidebarLink(_: PluginSidebarProps) {
  return <SidebarLink route={ROUTES.autopilot} label="Autopilot" icon={<IconAutopilot />} />;
}

export function AutopilotPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const handoffsResult = useHandoffs(companyId);
  const missionResult = useMissionStatus(companyId);
  const handoffs = (handoffsResult.data ?? []) as Handoff[];
  const mission = missionResult.data;

  const activeHandoffs = handoffs.filter((h) => !h.concluido && !h._legacy);
  const completedHandoffs = handoffs.filter((h) => h.concluido && !h._legacy);

  return (
    <div style={{ ...stack, padding: "24px", maxWidth: "900px" }}>
      <div style={row}>
        <h1 style={h1Style}>Autopilot</h1>
        <span style={badge(activeHandoffs.length > 0 ? "#16a34a" : "#6b7280")}>
          {activeHandoffs.length > 0 ? "ATIVO" : "IDLE"}
        </span>
      </div>

      {mission && (
        <div style={card}>
          <h2 style={{ ...h2Style, marginBottom: "8px" }}>Missão atual</h2>
          <p style={{ margin: 0, fontWeight: 500 }}>{mission.missao?.titulo}</p>
          <div style={{ ...row, marginTop: "12px", gap: "16px" }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "24px", fontWeight: 700 }}>{mission.totalFeatures}</div>
              <div style={smallMuted}>Total</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "#16a34a" }}>{mission.doneFeatures}</div>
              <div style={smallMuted}>Done</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "#d97706" }}>{mission.pendingFeatures}</div>
              <div style={smallMuted}>Pendentes</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "#2563eb" }}>{mission.activeHandoffs}</div>
              <div style={smallMuted}>Handoffs ativos</div>
            </div>
          </div>
        </div>
      )}

      <h2 style={h2Style}>Handoffs ativos ({activeHandoffs.length})</h2>
      {activeHandoffs.length === 0 && (
        <p style={smallMuted}>Nenhum handoff ativo no momento.</p>
      )}
      {activeHandoffs.map((h, i) => (
        <div key={i} style={card}>
          <div style={{ ...row, justifyContent: "space-between" }}>
            <span style={{ fontWeight: 600 }}>{h.papel ?? "—"}</span>
            <span style={badge("#2563eb")}>em progresso</span>
          </div>
          {h.pendente && <p style={{ ...smallMuted, marginTop: "4px" }}>{h.pendente}</p>}
          {h.inicio && <p style={smallMuted}>Início: {h.inicio}</p>}
        </div>
      ))}

      <h2 style={h2Style}>Histórico ({completedHandoffs.length})</h2>
      {completedHandoffs.slice(-5).reverse().map((h, i) => (
        <div key={i} style={{ ...subtleCard, opacity: 0.8 }}>
          <div style={row}>
            <span style={{ fontWeight: 500 }}>{h.papel ?? "—"}</span>
            <span style={badge("#16a34a")}>✓</span>
            {h.tokens && <span style={smallMuted}>{h.tokens.toLocaleString()} tokens</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIORITY MATRIX
// ═══════════════════════════════════════════════════════════════════════════════

export function PriorityMatrixSidebarLink(_: PluginSidebarProps) {
  return <SidebarLink route={ROUTES.priorityMatrix} label="Priority Matrix" icon={<IconPriorityMatrix />} />;
}

export function PriorityMatrixPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const featuresResult = useFeatures(companyId);
  const features = (featuresResult.data?.features ?? []) as Feature[];

  const groups: Record<string, Feature[]> = { P0: [], P1: [], P2: [], other: [] };
  for (const f of features) {
    const p = f.prioridade ?? "other";
    if (p in groups) groups[p].push(f);
    else groups.other.push(f);
  }

  const priorities = [
    { key: "P0", label: "P0 — Crítico", color: "#dc2626" },
    { key: "P1", label: "P1 — Alto", color: "#d97706" },
    { key: "P2", label: "P2 — Médio", color: "#2563eb" },
    { key: "other", label: "Outros", color: "#6b7280" },
  ];

  return (
    <div style={{ ...stack, padding: "24px", maxWidth: "900px" }}>
      <h1 style={h1Style}>Priority Matrix</h1>
      <p style={smallMuted}>Visão agregada de todas as features por prioridade</p>

      {priorities.map(({ key, label, color }) => {
        const items = groups[key] ?? [];
        if (items.length === 0) return null;
        return (
          <div key={key} style={{ ...card, borderLeft: `4px solid ${color}` }}>
            <h2 style={{ ...h2Style, color, marginBottom: "12px" }}>
              {label} ({items.length})
            </h2>
            <div style={stack}>
              {items.map((f, i) => (
                <div key={f.id ?? i} style={{ ...row, justifyContent: "space-between" }}>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: "13px", fontWeight: 500 }}>{f.titulo}</span>
                    {f.projeto && (
                      <span style={{ ...smallMuted, marginLeft: "8px" }}>{f.projeto}</span>
                    )}
                  </div>
                  <StatusBadge status={f.status} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD WIDGET
// ═══════════════════════════════════════════════════════════════════════════════

export function App1nDashboardWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const mission = useMissionStatus(companyId);
  const nav = useHostNavigation();
  const m = mission.data;

  return (
    <div style={{ ...stack, fontSize: "13px" }}>
      <div style={{ ...row, justifyContent: "space-between" }}>
        <strong>app1n</strong>
        {m?.missao?.status && (
          <span style={badge(m.missao.status === "em_execucao" ? "#16a34a" : "#6b7280")}>
            {m.missao.status}
          </span>
        )}
      </div>
      {m?.missao?.titulo && (
        <p style={{ ...smallMuted, margin: 0 }}>{m.missao.titulo}</p>
      )}
      {m && (
        <div style={{ ...row, gap: "12px" }}>
          <span>✅ {m.doneFeatures}/{m.totalFeatures}</span>
          <span style={smallMuted}>|</span>
          <span>🔄 {m.activeHandoffs} handoffs</span>
        </div>
      )}
      <a {...nav.linkProps(`/${ROUTES.autopilot}`)} style={{ ...smallMuted, textDecoration: "underline" }}>
        Ver autopilot →
      </a>
    </div>
  );
}
