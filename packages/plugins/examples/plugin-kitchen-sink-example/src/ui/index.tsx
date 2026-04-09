import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  usePluginStream,
  usePluginToast,
  type PluginCommentAnnotationProps,
  type PluginCommentContextMenuItemProps,
  type PluginDetailTabProps,
  type PluginPageProps,
  type PluginProjectSidebarItemProps,
  type PluginSettingsPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  DEFAULT_CONFIG,
  JOB_KEYS,
  PAGE_ROUTE,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_ID,
  SAFE_COMMANDS,
  SLOT_IDS,
  STREAM_CHANNELS,
  TOOL_NAMES,
  WEBHOOK_KEYS,
} from "../constants.js";
import { AsciiArtAnimation } from "./AsciiArtAnimation.js";

type CompanyRecord = { id: string; name: string; issuePrefix?: string | null; status?: string | null };
type ProjectRecord = { id: string; name: string; status?: string; path?: string | null };
type IssueRecord = { id: string; title: string; status: string; projectId?: string | null };
type GoalRecord = { id: string; title: string; status: string };
type AgentRecord = { id: string; name: string; status: string };
type HostIssueRecord = {
  id: string;
  title: string;
  status: string;
  priority?: string | null;
  createdAt?: string;
};
type HostHeartbeatRunRecord = {
  id: string;
  status: string;
  invocationSource?: string | null;
  triggerDetail?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  agentId?: string | null;
};
type HostLiveRunRecord = HostHeartbeatRunRecord & {
  agentName?: string | null;
  issueId?: string | null;
};

type OverviewData = {
  pluginId: string;
  version: string;
  capabilities: string[];
  config: Record<string, unknown>;
  runtimeLaunchers: Array<{ id: string; displayName: string; placementZone: string }>;
  recentRecords: Array<{ id: string; source: string; message: string; createdAt: string; level: string; data?: unknown }>;
  counts: {
    companies: number;
    projects: number;
    issues: number;
    goals: number;
    agents: number;
    entities: number;
  };
  lastJob: unknown;
  lastWebhook: unknown;
  lastWebhookIssue?: unknown;
  lastProcessResult: unknown;
  streamChannels: Record<string, string>;
  safeCommands: Array<{ key: string; label: string; description: string }>;
  manifest: {
    jobs: Array<{ jobKey: string; displayName: string; schedule?: string }>;
    webhooks: Array<{ endpointKey: string; displayName: string }>;
    tools: Array<{ name: string; displayName: string; description: string }>;
  };
};

type EntityRecord = {
  id: string;
  entityType: string;
  title: string | null;
  status: string | null;
  scopeKind: string;
  scopeId: string | null;
  externalId: string | null;
  data: unknown;
};

type StateValueData = {
  scope: {
    scopeKind: string;
    scopeId?: string;
    namespace?: string;
    stateKey: string;
  };
  value: unknown;
};

type PluginConfigData = {
  showSidebarEntry?: boolean;
  showSidebarPanel?: boolean;
  showProjectSidebarItem?: boolean;
  showCommentAnnotation?: boolean;
  showCommentContextMenuItem?: boolean;
  enableWorkspaceDemos?: boolean;
  enableProcessDemos?: boolean;
};

type CommentContextData = {
  commentId: string;
  issueId: string;
  preview: string;
  length: number;
  copiedCount: number;
} | null;

type ProcessResult = {
  commandKey: string;
  cwd: string;
  code: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
};

const layoutStack: CSSProperties = {
  display: "grid",
  gap: "12px",
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "14px",
  background: "var(--card, transparent)",
};

const subtleCardStyle: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--border) 75%, transparent)",
  borderRadius: "10px",
  padding: "12px",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  marginBottom: "10px",
};

const buttonStyle: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  borderRadius: "999px",
  background: "transparent",
  color: "inherit",
  padding: "6px 12px",
  fontSize: "12px",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--foreground)",
  color: "var(--background)",
  borderColor: "var(--foreground)",
};

function toneButtonStyle(tone: "success" | "warn" | "info"): CSSProperties {
  if (tone === "success") {
    return {
      ...buttonStyle,
      background: "color-mix(in srgb, #16a34a 18%, transparent)",
      borderColor: "color-mix(in srgb, #16a34a 60%, var(--border))",
      color: "#86efac",
    };
  }
  if (tone === "warn") {
    return {
      ...buttonStyle,
      background: "color-mix(in srgb, #d97706 18%, transparent)",
      borderColor: "color-mix(in srgb, #d97706 60%, var(--border))",
      color: "#fcd34d",
    };
  }
  return {
    ...buttonStyle,
    background: "color-mix(in srgb, #2563eb 18%, transparent)",
    borderColor: "color-mix(in srgb, #2563eb 60%, var(--border))",
    color: "#93c5fd",
  };
}

const inputStyle: CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "8px 10px",
  background: "transparent",
  color: "inherit",
  fontSize: "12px",
};

const codeStyle: CSSProperties = {
  margin: 0,
  padding: "10px",
  borderRadius: "8px",
  border: "1px solid var(--border)",
  background: "color-mix(in srgb, var(--muted, #888) 16%, transparent)",
  overflowX: "auto",
  fontSize: "11px",
  lineHeight: 1.45,
};

const widgetGridStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
};

const widgetStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "14px",
  padding: "14px",
  display: "grid",
  gap: "8px",
  background: "color-mix(in srgb, var(--card, transparent) 72%, transparent)",
};

const mutedTextStyle: CSSProperties = {
  fontSize: "12px",
  opacity: 0.72,
  lineHeight: 1.45,
};

const TOKEN_LABELS: Record<string, string> = {
  active: "ativo",
  agent: "agente",
  archived: "arquivado",
  assignment: "atribuição",
  automation: "automação",
  backlog: "backlog",
  blocked: "bloqueado",
  cancelled: "cancelado",
  comment: "comentário",
  company: "empresa",
  done: "concluído",
  failed: "falhou",
  goal: "meta",
  in_progress: "em andamento",
  in_review: "em revisão",
  instance: "instância",
  issue: "issue",
  manual: "manual",
  none: "nenhum",
  on_demand: "sob demanda",
  paused: "pausado",
  planned: "planejado",
  project: "projeto",
  queued: "na fila",
  running: "executando",
  schedule: "agendado",
  task: "task",
  timer: "temporizador",
  todo: "a fazer",
  unknown: "desconhecido",
  workspace: "workspace",
};

function hostPath(companyPrefix: string | null | undefined, suffix: string): string {
  return companyPrefix ? `/${companyPrefix}${suffix}` : suffix;
}

function pluginPagePath(companyPrefix: string | null | undefined): string {
  return hostPath(companyPrefix, `/${PAGE_ROUTE}`);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatToken(value: string | null | undefined): string {
  if (!value) return "não definido";
  return TOKEN_LABELS[value] ?? value.replaceAll("_", " ").replaceAll("-", " ");
}

function getObjectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const next = (value as Record<string, unknown>)[key];
  return typeof next === "string" ? next : null;
}

function getObjectNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const next = (value as Record<string, unknown>)[key];
  return typeof next === "number" && Number.isFinite(next) ? next : null;
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre style={codeStyle}>{JSON.stringify(value, null, 2)}</pre>;
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <strong>{title}</strong>
        {action}
      </div>
      <div style={layoutStack}>{children}</div>
    </section>
  );
}

function Pill({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        borderRadius: "999px",
        border: "1px solid var(--border)",
        padding: "2px 8px",
        fontSize: "11px",
      }}
    >
      {label}
    </span>
  );
}

function MiniWidget({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
}) {
  return (
    <section style={widgetStyle}>
      {eyebrow ? <div style={{ fontSize: "11px", opacity: 0.65, textTransform: "uppercase", letterSpacing: "0.06em" }}>{eyebrow}</div> : null}
      <strong>{title}</strong>
      <div style={layoutStack}>{children}</div>
    </section>
  );
}

function MiniList({
  items,
  render,
  empty,
}: {
  items: unknown[];
  render: (item: unknown, index: number) => ReactNode;
  empty: string;
}) {
  if (items.length === 0) return <div style={{ fontSize: "12px", opacity: 0.7 }}>{empty}</div>;
  return (
    <div style={{ display: "grid", gap: "8px" }}>
      {items.map((item, index) => (
        <div key={index} style={subtleCardStyle}>
          {render(item, index)}
        </div>
      ))}
    </div>
  );
}

function StatusLine({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: "4px" }}>
      <span style={{ fontSize: "11px", opacity: 0.65, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <div style={{ fontSize: "12px" }}>{value}</div>
    </div>
  );
}

function PaginatedDomainCard({
  title,
  items,
  totalCount,
  empty,
  onLoadMore,
  render,
}: {
  title: string;
  items: unknown[];
  totalCount: number | null;
  empty: string;
  onLoadMore: () => void;
  render: (item: unknown, index: number) => ReactNode;
}) {
  const hasMore = totalCount !== null ? items.length < totalCount : false;

  return (
    <div style={subtleCardStyle}>
      <div style={sectionHeaderStyle}>
        <strong>{title}</strong>
        {totalCount !== null ? <span style={mutedTextStyle}>{items.length} / {totalCount}</span> : null}
      </div>
      <MiniList items={items} empty={empty} render={render} />
      {hasMore ? (
        <div style={{ marginTop: "10px" }}>
          <button type="button" style={buttonStyle} onClick={onLoadMore}>
            Load 20 more
          </button>
        </div>
      ) : null}
    </div>
  );
}

function usePluginOverview(companyId: string | null) {
  return usePluginData<OverviewData>("overview", companyId ? { companyId } : {});
}

function usePluginConfigData() {
  return usePluginData<PluginConfigData>("plugin-config");
}

function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  }).then(async (response) => {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed: ${response.status}`);
    }
    return await response.json() as T;
  });
}

function useSettingsConfig() {
  const [configJson, setConfigJson] = useState<Record<string, unknown>>({ ...DEFAULT_CONFIG });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    hostFetchJson<{ configJson?: Record<string, unknown> | null } | null>(`/api/plugins/${PLUGIN_ID}/config`)
      .then((result) => {
        if (cancelled) return;
        setConfigJson({ ...DEFAULT_CONFIG, ...(result?.configJson ?? {}) });
        setError(null);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(nextConfig: Record<string, unknown>) {
    setSaving(true);
    try {
      await hostFetchJson(`/api/plugins/${PLUGIN_ID}/config`, {
        method: "POST",
        body: JSON.stringify({ configJson: nextConfig }),
      });
      setConfigJson(nextConfig);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      throw nextError;
    } finally {
      setSaving(false);
    }
  }

  return {
    configJson,
    setConfigJson,
    loading,
    saving,
    error,
    save,
  };
}

function CompactSurfaceSummary({ label, entityType }: { label: string; entityType?: string | null }) {
  const context = useHostContext();
  const companyId = context.companyId;
  const entityId = context.entityId;
  const resolvedEntityType = entityType ?? context.entityType ?? null;
  const entityQuery = usePluginData(
    "entity-context",
    companyId && entityId && resolvedEntityType
      ? { companyId, entityId, entityType: resolvedEntityType }
      : {},
  );
  const writeMetric = usePluginAction("write-metric");

  return (
    <div style={layoutStack}>
      <div style={rowStyle}>
        <strong>{label}</strong>
        {resolvedEntityType ? <Pill label={formatToken(resolvedEntityType)} /> : null}
      </div>
      <div style={mutedTextStyle}>
        Esta superfície mostra o contexto do host no ponto atual de montagem. O botão de métrica registra um contador operacional para validar a instrumentação a partir de uma superfície contextual.
      </div>
      <JsonBlock value={context} />
      <button
        type="button"
        style={buttonStyle}
        onClick={() => {
          if (!companyId) return;
          void writeMetric({ name: "surface_click", value: 1, companyId }).catch(console.error);
        }}
      >
        Registrar métrica
      </button>
      {entityQuery.data ? <JsonBlock value={entityQuery.data} /> : null}
    </div>
  );
}

function KitchenSinkPageWidgets({ context }: { context: PluginPageProps["context"] }) {
  const overview = usePluginOverview(context.companyId);
  const toast = usePluginToast();
  const emitDemoEvent = usePluginAction("emit-demo-event");
  const startProgressStream = usePluginAction("start-progress-stream");
  const writeMetric = usePluginAction("write-metric");
  const progressStream = usePluginStream<{ step?: number; message?: string }>(
    STREAM_CHANNELS.progress,
    { companyId: context.companyId ?? undefined },
  );
  const [quickActionStatus, setQuickActionStatus] = useState<{
    title: string;
    body: string;
    tone: "info" | "success" | "warn" | "error";
  } | null>(null);

  useEffect(() => {
    const latest = progressStream.events.at(-1);
    if (!latest) return;
    setQuickActionStatus({
      title: "Atualização do stream de progresso",
      body: latest.message ?? `Passo ${latest.step ?? "?"}`,
      tone: "info",
    });
  }, [progressStream.events]);

  return (
    <div style={widgetGridStyle}>
      <MiniWidget title="Resumo do Runtime" eyebrow="Visão Geral">
        <div style={{ display: "grid", gap: "4px", fontSize: "12px" }}>
          <div>Empresas: {overview.data?.counts.companies ?? 0}</div>
          <div>Projetos: {overview.data?.counts.projects ?? 0}</div>
          <div>Issues: {overview.data?.counts.issues ?? 0}</div>
          <div>Agentes: {overview.data?.counts.agents ?? 0}</div>
        </div>
      </MiniWidget>

      <MiniWidget title="Ações Rápidas" eyebrow="Teste Rápido">
        <div style={rowStyle}>
          <button
            type="button"
            style={toneButtonStyle("success")}
            onClick={() =>
              toast({
                title: "Toast de sucesso da Central de Operações",
                body: "Este toast é renderizado pelo sistema do host a partir da UI do plugin.",
                tone: "success",
              })}
          >
            Toast de sucesso
          </button>
          <button
            type="button"
            style={toneButtonStyle("warn")}
            onClick={() =>
              toast({
                title: "Toast de alerta da Central de Operações",
                body: "Use este padrão para feedback visível ao operador.",
                tone: "warn",
              })}
          >
            Toast de alerta
          </button>
          <button
            type="button"
            style={toneButtonStyle("info")}
            onClick={() =>
              toast({
                title: "Abrir painel",
                body: "Toasts podem apontar de volta para páginas do host.",
                tone: "info",
                action: {
                  label: "Abrir",
                  href: hostPath(context.companyPrefix, "/dashboard"),
                },
              })}
          >
            Toast com ação
          </button>
        </div>
        <div style={rowStyle}>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              if (!context.companyId) return;
              void emitDemoEvent({ companyId: context.companyId, message: "Disparado pela página da Central de Operações" })
                .then((next) => {
                  overview.refresh();
                  const message = getObjectString(next, "message") ?? "Evento operacional emitido";
                  setQuickActionStatus({
                    title: "Evento emitido",
                    body: message,
                    tone: "success",
                  });
                  toast({
                    title: "Evento emitido",
                    body: message,
                    tone: "success",
                  });
                })
                .catch((error) => {
                  const message = getErrorMessage(error);
                  setQuickActionStatus({
                    title: "Falha ao emitir evento",
                    body: message,
                    tone: "error",
                  });
                  toast({
                    title: "Falha ao emitir evento",
                    body: message,
                    tone: "error",
                  });
                });
            }}
          >
            Emitir evento
          </button>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              if (!context.companyId) return;
              void startProgressStream({ companyId: context.companyId, steps: 4 })
                .then(() => {
                  setQuickActionStatus({
                    title: "Stream iniciado",
                    body: "Acompanhe abaixo as atualizações em tempo real.",
                    tone: "info",
                  });
                  toast({
                    title: "Stream de progresso iniciado",
                    body: "As atualizações aparecerão no painel de ações rápidas.",
                    tone: "info",
                  });
                })
                .catch((error) => {
                  const message = getErrorMessage(error);
                  setQuickActionStatus({
                    title: "Falha ao iniciar stream",
                    body: message,
                    tone: "error",
                  });
                  toast({
                    title: "Falha no stream de progresso",
                    body: message,
                    tone: "error",
                  });
                });
            }}
          >
            Iniciar stream
          </button>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              if (!context.companyId) return;
              void writeMetric({ companyId: context.companyId, name: "page_quick_action", value: 1 })
                .then((next) => {
                  overview.refresh();
                  const value = getObjectNumber(next, "value") ?? 1;
                  const body = `Registrou ops.page_quick_action = ${value}`;
                  setQuickActionStatus({
                    title: "Métrica registrada",
                    body,
                    tone: "success",
                  });
                  toast({
                    title: "Métrica registrada",
                    body,
                    tone: "success",
                  });
                })
                .catch((error) => {
                  const message = getErrorMessage(error);
                  setQuickActionStatus({
                    title: "Falha ao registrar métrica",
                    body: message,
                    tone: "error",
                  });
                  toast({
                    title: "Falha ao registrar métrica",
                    body: message,
                    tone: "error",
                  });
                });
            }}
          >
            Registrar métrica
          </button>
        </div>
        <div style={{ display: "grid", gap: "6px" }}>
          <div style={mutedTextStyle}>
            Eventos recentes de progresso: {progressStream.events.length}
          </div>
          {quickActionStatus ? (
            <div
              style={{
                ...subtleCardStyle,
                borderColor:
                  quickActionStatus.tone === "error"
                    ? "color-mix(in srgb, #dc2626 45%, var(--border))"
                    : quickActionStatus.tone === "warn"
                      ? "color-mix(in srgb, #d97706 45%, var(--border))"
                      : quickActionStatus.tone === "success"
                        ? "color-mix(in srgb, #16a34a 45%, var(--border))"
                        : "color-mix(in srgb, #2563eb 45%, var(--border))",
              }}
            >
              <div style={{ fontSize: "12px", fontWeight: 600 }}>{quickActionStatus.title}</div>
              <div style={mutedTextStyle}>{quickActionStatus.body}</div>
            </div>
          ) : null}
          {progressStream.events.length > 0 ? (
            <JsonBlock value={progressStream.events.slice(-3)} />
          ) : null}
        </div>
      </MiniWidget>

      <MiniWidget title="Mapa de Superfícies" eyebrow="UI">
        <div style={{ display: "grid", gap: "4px", fontSize: "12px" }}>
          <div>Link e painel lateral</div>
          <div>Widget de dashboard</div>
          <div>Link de projeto, aba, botão de toolbar e launcher</div>
          <div>Aba de issue, visão da task, botão de toolbar e launcher</div>
          <div>Anotação e ação de comentário</div>
        </div>
      </MiniWidget>

      <MiniWidget title="Cobertura do Manifest" eyebrow="Worker">
        <div style={{ display: "grid", gap: "4px", fontSize: "12px" }}>
          <div>Jobs: {overview.data?.manifest.jobs.length ?? 0}</div>
          <div>Webhooks: {overview.data?.manifest.webhooks.length ?? 0}</div>
          <div>Ferramentas: {overview.data?.manifest.tools.length ?? 0}</div>
          <div>Launchers: {overview.data?.runtimeLaunchers.length ?? 0}</div>
        </div>
      </MiniWidget>

      <MiniWidget title="Estado Mais Recente do Runtime" eyebrow="Diagnósticos">
        <div style={mutedTextStyle}>
          Este bloco é atualizado conforme você usa as ações operacionais abaixo.
        </div>
        <JsonBlock
          value={{
            lastJob: overview.data?.lastJob ?? null,
            lastWebhook: overview.data?.lastWebhook ?? null,
            lastProcessResult: overview.data?.lastProcessResult ?? null,
          }}
        />
      </MiniWidget>

    </div>
  );
}

function KitchenSinkIssueCrudDemo({ context }: { context: PluginPageProps["context"] }) {
  const toast = usePluginToast();
  const [issues, setIssues] = useState<HostIssueRecord[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { title: string; status: string }>>({});
  const [createTitle, setCreateTitle] = useState("Issue operacional de acompanhamento");
  const [createDescription, setCreateDescription] = useState("Criada a partir da página da Central de Operações.");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadIssues() {
    if (!context.companyId) return;
    setLoading(true);
    try {
      const result = await hostFetchJson<HostIssueRecord[]>(`/api/companies/${context.companyId}/issues`);
      const nextIssues = result.slice(0, 8);
      setIssues(nextIssues);
      setDrafts(
        Object.fromEntries(
          nextIssues.map((issue) => [issue.id, { title: issue.title, status: issue.status }]),
        ),
      );
      setError(null);
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadIssues();
  }, [context.companyId]);

  async function handleCreate() {
    if (!context.companyId || !createTitle.trim()) return;
    try {
      await hostFetchJson(`/api/companies/${context.companyId}/issues`, {
        method: "POST",
        body: JSON.stringify({
          title: createTitle.trim(),
          description: createDescription.trim() || undefined,
          status: "todo",
          priority: "medium",
        }),
      });
      toast({ title: "Issue criada", body: createTitle.trim(), tone: "success" });
      setCreateTitle("Issue operacional de acompanhamento");
      setCreateDescription("Criada a partir da página da Central de Operações.");
      await loadIssues();
    } catch (nextError) {
      toast({ title: "Falha ao criar issue", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  async function handleSave(issueId: string) {
    const draft = drafts[issueId];
    if (!draft) return;
    try {
      await hostFetchJson(`/api/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: draft.title.trim(),
          status: draft.status,
        }),
      });
      toast({ title: "Issue atualizada", body: draft.title.trim(), tone: "success" });
      await loadIssues();
    } catch (nextError) {
      toast({ title: "Falha ao atualizar issue", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  async function handleDelete(issueId: string) {
    try {
      await hostFetchJson(`/api/issues/${issueId}`, { method: "DELETE" });
      toast({ title: "Issue excluída", tone: "info" });
      await loadIssues();
    } catch (nextError) {
      toast({ title: "Falha ao excluir issue", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  return (
    <Section title="Gestão de Issues">
      <div style={mutedTextStyle}>
        Esta página React embarcada chama a API do board diretamente para criar, atualizar e excluir issues da empresa atual.
      </div>
      {!context.companyId ? (
        <div style={mutedTextStyle}>Selecione uma empresa para gerenciar as issues operacionais.</div>
      ) : (
        <>
          <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) auto" }}>
            <input style={inputStyle} value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="Título da issue" />
            <input style={inputStyle} value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} placeholder="Descrição da issue" />
            <button type="button" style={primaryButtonStyle} onClick={() => void handleCreate()}>
              Criar issue
            </button>
          </div>
          {loading ? <div style={mutedTextStyle}>Carregando issues…</div> : null}
          {error ? <div style={{ ...mutedTextStyle, color: "var(--destructive, #dc2626)" }}>{error}</div> : null}
          <div style={{ display: "grid", gap: "10px" }}>
            {issues.map((issue) => {
              const draft = drafts[issue.id] ?? { title: issue.title, status: issue.status };
              return (
                <div key={issue.id} style={subtleCardStyle}>
                  <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "minmax(0, 1.6fr) 140px auto auto" }}>
                    <input
                      style={inputStyle}
                      value={draft.title}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [issue.id]: { ...draft, title: event.target.value },
                        }))}
                    />
                    <select
                      style={inputStyle}
                      value={draft.status}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [issue.id]: { ...draft, status: event.target.value },
                        }))}
                    >
                      <option value="backlog">{formatToken("backlog")}</option>
                      <option value="todo">{formatToken("todo")}</option>
                      <option value="in_progress">{formatToken("in_progress")}</option>
                      <option value="in_review">{formatToken("in_review")}</option>
                      <option value="done">{formatToken("done")}</option>
                      <option value="blocked">{formatToken("blocked")}</option>
                      <option value="cancelled">{formatToken("cancelled")}</option>
                    </select>
                    <button type="button" style={buttonStyle} onClick={() => void handleSave(issue.id)}>
                      Salvar
                    </button>
                    <button type="button" style={buttonStyle} onClick={() => void handleDelete(issue.id)}>
                      Excluir
                    </button>
                  </div>
                </div>
              );
            })}
            {!loading && issues.length === 0 ? <div style={mutedTextStyle}>Ainda não há issues para esta empresa.</div> : null}
          </div>
        </>
      )}
    </Section>
  );
}

function KitchenSinkCompanyCrudDemo({ context }: { context: PluginPageProps["context"] }) {
  const toast = usePluginToast();
  const [companies, setCompanies] = useState<CompanyRecord[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { name: string; status: string }>>({});
  const [newCompanyName, setNewCompanyName] = useState(`Empresa ${new Date().toLocaleTimeString()}`);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadCompanies() {
    setLoading(true);
    try {
      const result = await hostFetchJson<Array<CompanyRecord & { status?: string }>>("/api/companies");
      setCompanies(result);
      setDrafts(
        Object.fromEntries(
          result.map((company) => [company.id, { name: company.name, status: company.status ?? "active" }]),
        ),
      );
      setError(null);
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCompanies();
  }, []);

  async function handleCreate() {
    const trimmed = newCompanyName.trim();
    if (!trimmed) return;
    const name = trimmed;
    try {
      await hostFetchJson("/api/companies", {
        method: "POST",
        body: JSON.stringify({
          name,
          description: "Criada a partir da página da Central de Operações.",
        }),
      });
      toast({ title: "Empresa criada", body: name, tone: "success" });
      setNewCompanyName(`Empresa ${Date.now()}`);
      await loadCompanies();
    } catch (nextError) {
      toast({ title: "Falha ao criar empresa", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  async function handleSave(companyId: string) {
    const draft = drafts[companyId];
    if (!draft) return;
    try {
      await hostFetchJson(`/api/companies/${companyId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: draft.name.trim(),
          status: draft.status,
        }),
      });
      toast({ title: "Empresa atualizada", body: draft.name.trim(), tone: "success" });
      await loadCompanies();
    } catch (nextError) {
      toast({ title: "Falha ao atualizar empresa", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  async function handleDelete(company: CompanyRecord) {
    try {
      await hostFetchJson(`/api/companies/${company.id}`, { method: "DELETE" });
      toast({ title: "Empresa excluída", body: company.name, tone: "info" });
      await loadCompanies();
    } catch (nextError) {
      toast({ title: "Falha ao excluir empresa", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  const currentCompany = companies.find((company) => company.id === context.companyId) ?? null;
  const managedCompanies = companies;

  return (
    <Section title="Gestão de Empresas">
      <div style={mutedTextStyle}>
        O SDK do worker já expõe leitura de empresas. Este painel complementa isso com ações diretas no host para gestão de empresas em nível de board.
      </div>
      <div style={subtleCardStyle}>
        <div style={rowStyle}>
          <strong>Empresa Atual</strong>
          {currentCompany ? <Pill label={currentCompany.issuePrefix ?? "sem-prefixo"} /> : null}
        </div>
        <div style={{ fontSize: "12px" }}>{currentCompany?.name ?? "Nenhuma empresa atual selecionada"}</div>
      </div>
      <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "minmax(0, 1fr) auto" }}>
        <input
          style={inputStyle}
          value={newCompanyName}
          onChange={(event) => setNewCompanyName(event.target.value)}
          placeholder="Nome da nova empresa"
        />
        <button type="button" style={primaryButtonStyle} onClick={() => void handleCreate()}>
          Criar empresa
        </button>
      </div>
      {loading ? <div style={mutedTextStyle}>Carregando empresas…</div> : null}
      {error ? <div style={{ ...mutedTextStyle, color: "var(--destructive, #dc2626)" }}>{error}</div> : null}
      <div style={{ display: "grid", gap: "10px" }}>
        {managedCompanies.map((company) => {
          const draft = drafts[company.id] ?? { name: company.name, status: "active" };
          const isCurrent = company.id === context.companyId;
          return (
            <div key={company.id} style={subtleCardStyle}>
              <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "minmax(0, 1.5fr) 120px auto auto" }}>
                <input
                  style={inputStyle}
                  value={draft.name}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [company.id]: { ...draft, name: event.target.value },
                    }))}
                />
                <select
                  style={inputStyle}
                  value={draft.status}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [company.id]: { ...draft, status: event.target.value },
                    }))}
                >
                  <option value="active">{formatToken("active")}</option>
                  <option value="paused">{formatToken("paused")}</option>
                  <option value="archived">{formatToken("archived")}</option>
                </select>
                <button type="button" style={buttonStyle} onClick={() => void handleSave(company.id)}>
                  Salvar
                </button>
                <button type="button" style={buttonStyle} onClick={() => void handleDelete(company)} disabled={isCurrent}>
                  Excluir
                </button>
              </div>
              {isCurrent ? <div style={{ ...mutedTextStyle, marginTop: "8px" }}>A empresa atual não pode ser excluída nesta visualização.</div> : null}
            </div>
          );
        })}
        {!loading && managedCompanies.length === 0 ? (
          <div style={mutedTextStyle}>Nenhuma empresa encontrada. Crie uma acima para inicializar um novo escopo de empresa.</div>
        ) : null}
      </div>
    </Section>
  );
}

function KitchenSinkTopRow({ context }: { context: PluginPageProps["context"] }) {
  return (
    <div
      style={{
        display: "grid",
        gap: "14px",
        gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        alignItems: "stretch",
      }}
    >
      <Section title="Aplicação Embarcada">
        <div style={{ fontSize: "13px", lineHeight: 1.5 }}>
          Plugins podem hospedar sua própria página React e se comportar como uma página nativa da empresa. A Central de Operações usa esta rota como workspace principal do operador e mantém o console do worker abaixo para diagnósticos mais profundos.
        </div>
      </Section>
      <div style={{ display: "grid", gap: "14px" }}>
        <Section title="Rota da Página do Plugin">
          <div style={mutedTextStyle}>
            A entrada na barra lateral da empresa abre esta rota diretamente, então o plugin se comporta como uma página de primeira classe e não como uma subpágina de configurações.
          </div>
          <a href={pluginPagePath(context.companyPrefix)} style={{ fontSize: "12px" }}>
            {pluginPagePath(context.companyPrefix)}
          </a>
        </Section>
      <Section title="Animação Paperclip">
        <div style={mutedTextStyle}>
          Este é o mesmo tratamento ASCII do Paperclip usado no onboarding, copiado para o plugin para manter o pacote autocontido.
        </div>
          <AsciiArtAnimation />
        </Section>
      </div>
    </div>
  );
}

function KitchenSinkStorageDemo({ context }: { context: PluginPageProps["context"] }) {
  const toast = usePluginToast();
  const stateKey = "contador_operacional";
  const revenueState = usePluginData<StateValueData>(
    "state-value",
    context.companyId
      ? { scopeKind: "company", scopeId: context.companyId, stateKey }
      : {},
  );
  const writeScopedState = usePluginAction("write-scoped-state");
  const deleteScopedState = usePluginAction("delete-scoped-state");

  const currentValue = useMemo(() => {
    const raw = revenueState.data?.value;
    if (typeof raw === "number") return raw;
    const parsed = Number(raw ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [revenueState.data?.value]);

  async function adjust(delta: number) {
    if (!context.companyId) return;
    try {
      await writeScopedState({
        scopeKind: "company",
        scopeId: context.companyId,
        stateKey,
        value: currentValue + delta,
      });
      revenueState.refresh();
    } catch (nextError) {
      toast({ title: "Falha ao gravar estado", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  async function reset() {
    if (!context.companyId) return;
    try {
      await deleteScopedState({
        scopeKind: "company",
        scopeId: context.companyId,
        stateKey,
      });
      toast({ title: "Contador operacional resetado", tone: "info" });
      revenueState.refresh();
    } catch (nextError) {
      toast({ title: "Falha ao resetar estado", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  return (
    <Section title="Armazenamento do Plugin">
      <div style={mutedTextStyle}>
        Este contador persiste no armazenamento da empresa escopado pelo plugin. Um plugin operacional real poderia guardar contadores, cursores de sync, confirmações ou IDs externos em cache da mesma forma.
      </div>
      {!context.companyId ? (
            <div style={mutedTextStyle}>Selecione uma empresa para usar o armazenamento escopado por empresa.</div>
      ) : (
        <>
          <div style={{ display: "grid", gap: "4px" }}>
            <div style={{ fontSize: "26px", fontWeight: 700 }}>{currentValue}</div>
            <div style={mutedTextStyle}>Armazenado em `company/{context.companyId}/{stateKey}`</div>
          </div>
          <div style={rowStyle}>
            {[-10, -1, 1, 10].map((delta) => (
              <button key={delta} type="button" style={buttonStyle} onClick={() => void adjust(delta)}>
                {delta > 0 ? `+${delta}` : delta}
              </button>
            ))}
            <button type="button" style={buttonStyle} onClick={() => void reset()}>
              Resetar
            </button>
          </div>
          <JsonBlock value={revenueState.data ?? { scopeKind: "company", stateKey, value: 0 }} />
        </>
      )}
    </Section>
  );
}

function KitchenSinkHostIntegrationDemo({ context }: { context: PluginPageProps["context"] }) {
  const [liveRuns, setLiveRuns] = useState<HostLiveRunRecord[]>([]);
  const [recentRuns, setRecentRuns] = useState<HostHeartbeatRunRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadRuns() {
    if (!context.companyId) return;
    setLoading(true);
    try {
      const [nextLiveRuns, nextRecentRuns] = await Promise.all([
        hostFetchJson<HostLiveRunRecord[]>(`/api/companies/${context.companyId}/live-runs?minCount=5`),
        hostFetchJson<HostHeartbeatRunRecord[]>(`/api/companies/${context.companyId}/heartbeat-runs?limit=5`),
      ]);
      setLiveRuns(nextLiveRuns);
      setRecentRuns(nextRecentRuns);
      setError(null);
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadRuns();
  }, [context.companyId]);

  return (
    <Section title="Integrações com o Host">
      <div style={mutedTextStyle}>
        Páginas de plugin podem se comportar como páginas nativas do Paperclip. Esta seção demonstra toasts do host, roteamento escopado por empresa e leitura do heartbeat ao vivo a partir da página embarcada.
      </div>
      <div style={subtleCardStyle}>
        <div style={rowStyle}>
          <strong>Rota da Empresa</strong>
          <Pill label={pluginPagePath(context.companyPrefix)} />
        </div>
        <div style={mutedTextStyle}>
          Esta página é montada como uma rota real da empresa em vez de existir apenas sob `/plugins/:pluginId`.
        </div>
      </div>
      {!context.companyId ? (
        <div style={mutedTextStyle}>Selecione uma empresa para ler os dados de execução.</div>
      ) : (
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          <div style={subtleCardStyle}>
            <div style={sectionHeaderStyle}>
              <strong>Execuções ao Vivo</strong>
              <button type="button" style={buttonStyle} onClick={() => void loadRuns()}>
                Atualizar
              </button>
            </div>
            {loading ? <div style={mutedTextStyle}>Carregando execuções…</div> : null}
            {error ? <div style={{ ...mutedTextStyle, color: "var(--destructive, #dc2626)" }}>{error}</div> : null}
            <MiniList
              items={liveRuns}
              empty="Nenhuma execução ao vivo neste momento."
              render={(item) => {
                const run = item as HostLiveRunRecord;
                return (
                  <div style={{ display: "grid", gap: "6px", fontSize: "12px" }}>
                    <div style={rowStyle}>
                      <strong>{formatToken(run.status)}</strong>
                      {run.agentName ? <Pill label={run.agentName} /> : null}
                    </div>
                    <div>{run.id}</div>
                    {run.agentId ? (
                      <a href={hostPath(context.companyPrefix, `/agents/${run.agentId}/runs/${run.id}`)}>
                        Abrir execução
                      </a>
                    ) : null}
                  </div>
                );
              }}
            />
          </div>
          <div style={subtleCardStyle}>
            <strong>Heartbeats Recentes</strong>
            <MiniList
              items={recentRuns}
              empty="Nenhum heartbeat recente."
              render={(item) => {
                const run = item as HostHeartbeatRunRecord;
                return (
                  <div style={{ display: "grid", gap: "6px", fontSize: "12px" }}>
                    <div style={rowStyle}>
                      <strong>{formatToken(run.status)}</strong>
                      {run.invocationSource ? <Pill label={formatToken(run.invocationSource)} /> : null}
                    </div>
                    <div>{run.id}</div>
                  </div>
                );
              }}
            />
          </div>
        </div>
      )}
    </Section>
  );
}

function KitchenSinkEmbeddedApp({ context }: { context: PluginPageProps["context"] }) {
  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <KitchenSinkTopRow context={context} />
      <KitchenSinkStorageDemo context={context} />
      <KitchenSinkIssueCrudDemo context={context} />
      <KitchenSinkCompanyCrudDemo context={context} />
      <KitchenSinkHostIntegrationDemo context={context} />
    </div>
  );
}

function KitchenSinkConsole({ context }: { context: { companyId: string | null; companyPrefix?: string | null; projectId?: string | null; entityId?: string | null; entityType?: string | null } }) {
  const companyId = context.companyId;
  const overview = usePluginOverview(companyId);
  const [companiesLimit, setCompaniesLimit] = useState(20);
  const [projectsLimit, setProjectsLimit] = useState(20);
  const [issuesLimit, setIssuesLimit] = useState(20);
  const [goalsLimit, setGoalsLimit] = useState(20);
  const companies = usePluginData<CompanyRecord[]>("companies", { limit: companiesLimit });
  const projects = usePluginData<ProjectRecord[]>("projects", companyId ? { companyId, limit: projectsLimit } : {});
  const issues = usePluginData<IssueRecord[]>("issues", companyId ? { companyId, limit: issuesLimit } : {});
  const goals = usePluginData<GoalRecord[]>("goals", companyId ? { companyId, limit: goalsLimit } : {});
  const agents = usePluginData<AgentRecord[]>("agents", companyId ? { companyId } : {});

  const [issueTitle, setIssueTitle] = useState("Issue operacional de acompanhamento");
  const [goalTitle, setGoalTitle] = useState("Marco de confiabilidade");
  const [stateScopeKind, setStateScopeKind] = useState("instance");
  const [stateScopeId, setStateScopeId] = useState("");
  const [stateNamespace, setStateNamespace] = useState("");
  const [stateKey, setStateKey] = useState("nota-operacional");
  const [stateValue, setStateValue] = useState("{\"hello\":\"world\"}");
  const [entityType, setEntityType] = useState("registro-operacional");
  const [entityTitle, setEntityTitle] = useState("Registro Operacional");
  const [entityScopeKind, setEntityScopeKind] = useState("instance");
  const [entityScopeId, setEntityScopeId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedIssueId, setSelectedIssueId] = useState("");
  const [selectedGoalId, setSelectedGoalId] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [httpUrl, setHttpUrl] = useState<string>(DEFAULT_CONFIG.httpDemoUrl);
  const [secretRef, setSecretRef] = useState("");
  const [metricName, setMetricName] = useState("manual");
  const [metricValue, setMetricValue] = useState("1");
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspacePath, setWorkspacePath] = useState<string>(DEFAULT_CONFIG.workspaceScratchFile);
  const [workspaceContent, setWorkspaceContent] = useState("A Central de Operações gravou esta nota.");
  const [commandKey, setCommandKey] = useState<string>(SAFE_COMMANDS[0]?.key ?? "pwd");
  const [toolMessage, setToolMessage] = useState("Resuma o estado operacional atual");
  const [toolOutput, setToolOutput] = useState<unknown>(null);
  const [jobOutput, setJobOutput] = useState<unknown>(null);
  const [webhookOutput, setWebhookOutput] = useState<unknown>(null);
  const [result, setResult] = useState<unknown>(null);

  const stateQuery = usePluginData<StateValueData>("state-value", {
    scopeKind: stateScopeKind,
    scopeId: stateScopeId || undefined,
    namespace: stateNamespace || undefined,
    stateKey,
  });
  const entityQuery = usePluginData<EntityRecord[]>("entities", {
    entityType,
    scopeKind: entityScopeKind,
    scopeId: entityScopeId || undefined,
    limit: 25,
  });
  const workspaceQuery = usePluginData<Array<{ id: string; name: string; path: string }>>(
    "workspaces",
    companyId && selectedProjectId ? { companyId, projectId: selectedProjectId } : {},
  );
  const progressStream = usePluginStream<{ step: number; total: number; message: string }>(
    STREAM_CHANNELS.progress,
    companyId ? { companyId } : undefined,
  );
  const agentStream = usePluginStream<{ eventType: string; message: string | null }>(
    STREAM_CHANNELS.agentChat,
    companyId ? { companyId } : undefined,
  );

  const emitDemoEvent = usePluginAction("emit-demo-event");
  const createIssue = usePluginAction("create-issue");
  const advanceIssueStatus = usePluginAction("advance-issue-status");
  const createGoal = usePluginAction("create-goal");
  const advanceGoalStatus = usePluginAction("advance-goal-status");
  const writeScopedState = usePluginAction("write-scoped-state");
  const deleteScopedState = usePluginAction("delete-scoped-state");
  const upsertEntity = usePluginAction("upsert-entity");
  const writeActivity = usePluginAction("write-activity");
  const writeMetric = usePluginAction("write-metric");
  const httpFetch = usePluginAction("http-fetch");
  const resolveSecret = usePluginAction("resolve-secret");
  const runProcess = usePluginAction("run-process");
  const readWorkspaceFile = usePluginAction("read-workspace-file");
  const writeWorkspaceScratch = usePluginAction("write-workspace-scratch");
  const startProgressStream = usePluginAction("start-progress-stream");
  const invokeAgent = usePluginAction("invoke-agent");
  const pauseAgent = usePluginAction("pause-agent");
  const resumeAgent = usePluginAction("resume-agent");
  const askAgent = usePluginAction("ask-agent");

  useEffect(() => {
    setProjectsLimit(20);
    setIssuesLimit(20);
    setGoalsLimit(20);
  }, [companyId]);

  useEffect(() => {
    if (!selectedProjectId && projects.data?.[0]?.id) setSelectedProjectId(projects.data[0].id);
  }, [projects.data, selectedProjectId]);

  useEffect(() => {
    if (!selectedIssueId && issues.data?.[0]?.id) setSelectedIssueId(issues.data[0].id);
  }, [issues.data, selectedIssueId]);

  useEffect(() => {
    if (!selectedGoalId && goals.data?.[0]?.id) setSelectedGoalId(goals.data[0].id);
  }, [goals.data, selectedGoalId]);

  useEffect(() => {
    if (!selectedAgentId && agents.data?.[0]?.id) setSelectedAgentId(agents.data[0].id);
  }, [agents.data, selectedAgentId]);

  useEffect(() => {
    if (!workspaceId && workspaceQuery.data?.[0]?.id) setWorkspaceId(workspaceQuery.data[0].id);
  }, [workspaceId, workspaceQuery.data]);

  const projectRef = selectedProjectId || context.projectId || "";

  async function refreshAll() {
    overview.refresh();
    projects.refresh();
    issues.refresh();
    goals.refresh();
    agents.refresh();
    stateQuery.refresh();
    entityQuery.refresh();
    workspaceQuery.refresh();
  }

  async function executeTool(name: string) {
    if (!companyId || !selectedAgentId || !projectRef) {
      setToolOutput({ error: "Selecione primeiro uma empresa, um projeto e um agente." });
      return;
    }
    try {
      const toolName = `${PLUGIN_ID}:${name}`;
      const body =
        name === TOOL_NAMES.echo
          ? { message: toolMessage }
          : name === TOOL_NAMES.createIssue
            ? { title: issueTitle, description: "Criada pelo despachante de ferramentas a partir da Central de Operações." }
            : {};
      const response = await hostFetchJson(`/api/plugins/tools/execute`, {
        method: "POST",
        body: JSON.stringify({
          tool: toolName,
          parameters: body,
          runContext: {
            agentId: selectedAgentId,
            runId: `operations-console-${Date.now()}`,
            companyId,
            projectId: projectRef,
          },
        }),
      });
      setToolOutput(response);
      await refreshAll();
    } catch (error) {
      setToolOutput({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function fetchJobsAndTrigger() {
    try {
      const jobsResponse = await hostFetchJson<Array<{ id: string; jobKey: string }>>(`/api/plugins/${PLUGIN_ID}/jobs`);
      const job = jobsResponse.find((entry) => entry.jobKey === JOB_KEYS.heartbeat) ?? jobsResponse[0];
      if (!job) {
        setJobOutput({ error: "No plugin jobs returned by the host." });
        return;
      }
      const triggerResult = await hostFetchJson(`/api/plugins/${PLUGIN_ID}/jobs/${job.id}/trigger`, {
        method: "POST",
      });
      setJobOutput({ jobs: jobsResponse, triggerResult });
      overview.refresh();
    } catch (error) {
      setJobOutput({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function sendWebhook() {
    try {
      const response = await hostFetchJson(`/api/plugins/${PLUGIN_ID}/webhooks/${WEBHOOK_KEYS.demo}`, {
        method: "POST",
        body: JSON.stringify({
          source: "operations-console-ui",
          companyId,
          projectId: projectRef || undefined,
          title: "Issue operacional criada por webhook",
          description: "Criada pela ação de teste de webhook da Central de Operações.",
          sentAt: new Date().toISOString(),
        }),
      });
      setWebhookOutput(response);
      overview.refresh();
    } catch (error) {
      setWebhookOutput({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <Section
        title="Visão Geral"
        action={<button type="button" style={buttonStyle} onClick={() => refreshAll()}>Atualizar</button>}
      >
        <div style={rowStyle}>
          <Pill label={`Plugin: ${PLUGIN_DISPLAY_NAME}`} />
          <Pill label={`Versão: ${overview.data?.version ?? "carregando"}`} />
          <Pill label={`Empresa: ${companyId ?? "nenhuma"}`} />
          {context.entityType ? <Pill label={`Entidade: ${formatToken(context.entityType)}`} /> : null}
        </div>
        {overview.data ? (
          <>
            <div style={{ display: "grid", gap: "8px", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
              <StatusLine label="Empresas" value={overview.data.counts.companies} />
              <StatusLine label="Projetos" value={overview.data.counts.projects} />
              <StatusLine label="Issues" value={overview.data.counts.issues} />
              <StatusLine label="Metas" value={overview.data.counts.goals} />
              <StatusLine label="Agentes" value={overview.data.counts.agents} />
              <StatusLine label="Entidades" value={overview.data.counts.entities} />
            </div>
            <JsonBlock value={overview.data.config} />
          </>
        ) : (
          <div style={{ fontSize: "12px", opacity: 0.7 }}>Carregando visão geral…</div>
        )}
      </Section>

      <Section title="Superfícies de UI">
        <div style={rowStyle}>
          <a href={pluginPagePath(context.companyPrefix)} style={{ fontSize: "12px" }}>Abrir página do plugin</a>
          {projectRef ? (
            <a
              href={hostPath(context.companyPrefix, `/projects/${projectRef}?tab=plugin:${PLUGIN_ID}:${SLOT_IDS.projectTab}`)}
              style={{ fontSize: "12px" }}
            >
              Abrir aba do projeto
            </a>
          ) : null}
          {selectedIssueId ? (
            <a
              href={hostPath(context.companyPrefix, `/issues/${selectedIssueId}`)}
              style={{ fontSize: "12px" }}
            >
              Abrir issue selecionada
            </a>
          ) : null}
        </div>
        <JsonBlock value={overview.data?.runtimeLaunchers ?? []} />
      </Section>

      <Section title="Inventário Operacional">
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <PaginatedDomainCard
            title="Empresas"
            items={companies.data ?? []}
            totalCount={overview.data?.counts.companies ?? null}
            empty="Nenhuma empresa."
            onLoadMore={() => setCompaniesLimit((current) => current + 20)}
            render={(item) => {
              const company = item as CompanyRecord;
              return <div>{company.name} <span style={{ opacity: 0.6 }}>({company.id.slice(0, 8)})</span></div>;
            }}
          />
          <PaginatedDomainCard
            title="Projetos"
            items={projects.data ?? []}
            totalCount={overview.data?.counts.projects ?? null}
            empty="Nenhum projeto."
            onLoadMore={() => setProjectsLimit((current) => current + 20)}
            render={(item) => {
              const project = item as ProjectRecord;
              return <div>{project.name} <span style={{ opacity: 0.6 }}>({formatToken(project.status ?? "unknown")})</span></div>;
            }}
          />
          <PaginatedDomainCard
            title="Issues"
            items={issues.data ?? []}
            totalCount={overview.data?.counts.issues ?? null}
            empty="Nenhuma issue."
            onLoadMore={() => setIssuesLimit((current) => current + 20)}
            render={(item) => {
              const issue = item as IssueRecord;
              return <div>{issue.title} <span style={{ opacity: 0.6 }}>({formatToken(issue.status)})</span></div>;
            }}
          />
          <PaginatedDomainCard
            title="Metas"
            items={goals.data ?? []}
            totalCount={overview.data?.counts.goals ?? null}
            empty="Nenhuma meta."
            onLoadMore={() => setGoalsLimit((current) => current + 20)}
            render={(item) => {
              const goal = item as GoalRecord;
              return <div>{goal.title} <span style={{ opacity: 0.6 }}>({formatToken(goal.status)})</span></div>;
            }}
          />
        </div>
      </Section>

      <Section title="Ações de Issue e Meta">
        <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId) return;
              void createIssue({ companyId, projectId: selectedProjectId || undefined, title: issueTitle })
                .then((next) => {
                  setResult(next);
                  return refreshAll();
                })
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Criar issue</strong>
            <input style={inputStyle} value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} />
            <button type="submit" style={primaryButtonStyle} disabled={!companyId}>Criar issue</button>
          </form>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId || !selectedIssueId) return;
              void advanceIssueStatus({ companyId, issueId: selectedIssueId, status: "in_review" })
                .then((next) => {
                  setResult(next);
                  return refreshAll();
                })
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Avançar issue selecionada</strong>
            <select style={inputStyle} value={selectedIssueId} onChange={(event) => setSelectedIssueId(event.target.value)}>
              {(issues.data ?? []).map((issue) => (
                <option key={issue.id} value={issue.id}>{issue.title}</option>
              ))}
            </select>
            <button type="submit" style={buttonStyle} disabled={!companyId || !selectedIssueId}>Mover para em revisão</button>
          </form>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId) return;
              void createGoal({ companyId, title: goalTitle })
                .then((next) => {
                  setResult(next);
                  return refreshAll();
                })
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Criar meta</strong>
            <input style={inputStyle} value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} />
            <button type="submit" style={primaryButtonStyle} disabled={!companyId}>Criar meta</button>
          </form>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId || !selectedGoalId) return;
              void advanceGoalStatus({ companyId, goalId: selectedGoalId, status: "active" })
                .then((next) => {
                  setResult(next);
                  return refreshAll();
                })
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Avançar meta selecionada</strong>
            <select style={inputStyle} value={selectedGoalId} onChange={(event) => setSelectedGoalId(event.target.value)}>
              {(goals.data ?? []).map((goal) => (
                <option key={goal.id} value={goal.id}>{goal.title}</option>
              ))}
            </select>
            <button type="submit" style={buttonStyle} disabled={!companyId || !selectedGoalId}>Mover para ativa</button>
          </form>
        </div>
      </Section>

      <Section title="Estado e Entidades">
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              void writeScopedState({
                scopeKind: stateScopeKind,
                scopeId: stateScopeId || undefined,
                namespace: stateNamespace || undefined,
                stateKey,
                value: stateValue,
              })
                .then((next) => {
                  setResult(next);
                  stateQuery.refresh();
                })
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Estado</strong>
            <input style={inputStyle} value={stateScopeKind} onChange={(event) => setStateScopeKind(event.target.value)} placeholder="scopeKind" />
            <input style={inputStyle} value={stateScopeId} onChange={(event) => setStateScopeId(event.target.value)} placeholder="scopeId (opcional)" />
            <input style={inputStyle} value={stateNamespace} onChange={(event) => setStateNamespace(event.target.value)} placeholder="namespace (opcional)" />
            <input style={inputStyle} value={stateKey} onChange={(event) => setStateKey(event.target.value)} placeholder="stateKey" />
            <textarea style={{ ...inputStyle, minHeight: "88px" }} value={stateValue} onChange={(event) => setStateValue(event.target.value)} />
            <div style={rowStyle}>
              <button type="submit" style={primaryButtonStyle}>Gravar estado</button>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  void deleteScopedState({
                    scopeKind: stateScopeKind,
                    scopeId: stateScopeId || undefined,
                    namespace: stateNamespace || undefined,
                    stateKey,
                  })
                    .then((next) => {
                      setResult(next);
                      stateQuery.refresh();
                    })
                    .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
                }}
              >
                Excluir estado
              </button>
            </div>
            <JsonBlock value={stateQuery.data ?? { loading: true }} />
          </form>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              void upsertEntity({
                entityType,
                title: entityTitle,
                scopeKind: entityScopeKind,
                scopeId: entityScopeId || undefined,
                data: JSON.stringify({ createdAt: new Date().toISOString() }),
              })
                .then((next) => {
                  setResult(next);
                  entityQuery.refresh();
                  overview.refresh();
                })
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Entidades</strong>
            <input style={inputStyle} value={entityType} onChange={(event) => setEntityType(event.target.value)} placeholder="entityType" />
            <input style={inputStyle} value={entityTitle} onChange={(event) => setEntityTitle(event.target.value)} placeholder="título" />
            <input style={inputStyle} value={entityScopeKind} onChange={(event) => setEntityScopeKind(event.target.value)} placeholder="scopeKind" />
            <input style={inputStyle} value={entityScopeId} onChange={(event) => setEntityScopeId(event.target.value)} placeholder="scopeId (opcional)" />
            <button type="submit" style={primaryButtonStyle}>Criar ou atualizar entidade</button>
            <JsonBlock value={entityQuery.data ?? []} />
          </form>
        </div>
      </Section>

      <Section title="Eventos e Streams">
        <div style={rowStyle}>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => {
              if (!companyId) return;
              void emitDemoEvent({ companyId, message: "Evento manual da Central de Operações" })
                .then((next) => {
                  setResult(next);
                  overview.refresh();
                })
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            Registrar evento operacional
          </button>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              if (!companyId) return;
              void startProgressStream({ companyId, steps: 5 })
                .then((next) => setResult(next))
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            Iniciar stream de progresso
          </button>
        </div>
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div style={subtleCardStyle}>
            <strong>Stream de Progresso</strong>
            <JsonBlock value={progressStream.events.slice(-8)} />
          </div>
          <div style={subtleCardStyle}>
            <strong>Registros Recentes</strong>
            <JsonBlock value={overview.data?.recentRecords ?? []} />
          </div>
        </div>
      </Section>

      <Section title="HTTP, Segredos, Atividade e Métricas">
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              void httpFetch({ url: httpUrl })
                .then((next) => setResult(next))
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>HTTP</strong>
            <input style={inputStyle} value={httpUrl} onChange={(event) => setHttpUrl(event.target.value)} />
            <button type="submit" style={buttonStyle}>Consultar URL</button>
          </form>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              void resolveSecret({ secretRef })
                .then((next) => setResult(next))
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Segredos</strong>
            <input style={inputStyle} value={secretRef} onChange={(event) => setSecretRef(event.target.value)} placeholder="MY_SECRET_REF" />
            <button type="submit" style={buttonStyle}>Resolver referência</button>
          </form>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId) return;
              void writeActivity({ companyId, entityType: context.entityType ?? undefined, entityId: context.entityId ?? undefined })
                .then((next) => setResult(next))
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Atividade e Métricas</strong>
            <input style={inputStyle} value={metricName} onChange={(event) => setMetricName(event.target.value)} placeholder="nome da métrica" />
            <input style={inputStyle} value={metricValue} onChange={(event) => setMetricValue(event.target.value)} placeholder="valor da métrica" />
            <div style={rowStyle}>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  if (!companyId) return;
                  void writeMetric({ companyId, name: metricName, value: Number(metricValue || "1") })
                    .then((next) => setResult(next))
                    .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
                }}
              >
                Gravar métrica
              </button>
              <button type="submit" style={buttonStyle} disabled={!companyId}>Gravar atividade</button>
            </div>
          </form>
        </div>
      </Section>

      <Section title="Workspace e Diagnósticos">
        <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div style={layoutStack}>
            <strong>Selecionar projeto/workspace</strong>
            <select style={inputStyle} value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
              <option value="">Selecione um projeto</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
            <select style={inputStyle} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              <option value="">Selecione um workspace</option>
              {(workspaceQuery.data ?? []).map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
              ))}
            </select>
            <JsonBlock value={workspaceQuery.data ?? []} />
          </div>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId || !selectedProjectId) return;
              void writeWorkspaceScratch({
                companyId,
                projectId: selectedProjectId,
                workspaceId: workspaceId || undefined,
                relativePath: workspacePath,
                content: workspaceContent,
              })
                .then((next) => setResult(next))
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Notas do Workspace</strong>
            <input style={inputStyle} value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} />
            <textarea style={{ ...inputStyle, minHeight: "88px" }} value={workspaceContent} onChange={(event) => setWorkspaceContent(event.target.value)} />
            <div style={rowStyle}>
              <button type="submit" style={buttonStyle} disabled={!companyId || !selectedProjectId}>Gravar arquivo de notas</button>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  if (!companyId || !selectedProjectId) return;
                  void readWorkspaceFile({
                    companyId,
                    projectId: selectedProjectId,
                    workspaceId: workspaceId || undefined,
                    relativePath: workspacePath,
                  })
                    .then((next) => setResult(next))
                    .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
                }}
              >
                Ler arquivo
              </button>
            </div>
          </form>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId || !selectedProjectId) return;
              void runProcess({
                companyId,
                projectId: selectedProjectId,
                workspaceId: workspaceId || undefined,
                commandKey,
              })
                .then((next) => {
                  setResult(next);
                  overview.refresh();
                })
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Diagnósticos Controlados</strong>
            <select style={inputStyle} value={commandKey} onChange={(event) => setCommandKey(event.target.value)}>
              {SAFE_COMMANDS.map((command) => (
                <option key={command.key} value={command.key}>{command.label}</option>
              ))}
            </select>
            <button type="submit" style={buttonStyle} disabled={!companyId || !selectedProjectId}>Executar comando</button>
            <JsonBlock value={overview.data?.lastProcessResult ?? { note: "Nenhum processo executado ainda." }} />
          </form>
        </div>
      </Section>

      <Section title="Agentes e Sessões">
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId || !selectedAgentId) return;
              void invokeAgent({ companyId, agentId: selectedAgentId, prompt: "Resuma o estado operacional atual." })
                .then((next) => setResult(next))
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Controles de Agente</strong>
            <select style={inputStyle} value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
              {(agents.data ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
            <div style={rowStyle}>
              <button type="submit" style={primaryButtonStyle} disabled={!companyId || !selectedAgentId}>Invocar</button>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  if (!companyId || !selectedAgentId) return;
                  void pauseAgent({ companyId, agentId: selectedAgentId })
                    .then((next) => {
                      setResult(next);
                      agents.refresh();
                    })
                    .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
                }}
              >
                Pausar
              </button>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  if (!companyId || !selectedAgentId) return;
                  void resumeAgent({ companyId, agentId: selectedAgentId })
                    .then((next) => {
                      setResult(next);
                      agents.refresh();
                    })
                    .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
                }}
              >
                Retomar
              </button>
            </div>
          </form>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId || !selectedAgentId) return;
              void askAgent({ companyId, agentId: selectedAgentId, prompt: "Dê um resumo operacional curto." })
                .then((next) => setResult(next))
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Stream de Chat do Agente</strong>
            <button type="submit" style={buttonStyle} disabled={!companyId || !selectedAgentId}>Iniciar chat operacional</button>
            <JsonBlock value={agentStream.events.slice(-12)} />
          </form>
        </div>
      </Section>

      <Section title="Automações, Intake e Ferramentas">
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div style={layoutStack}>
            <strong>Job de Heartbeat</strong>
            <button type="button" style={buttonStyle} onClick={() => void fetchJobsAndTrigger()}>Disparar heartbeat</button>
            <JsonBlock value={jobOutput ?? overview.data?.lastJob ?? { note: "Ainda não há saída de job." }} />
          </div>
          <div style={layoutStack}>
            <strong>Webhook de Incidente</strong>
            <button type="button" style={buttonStyle} onClick={() => void sendWebhook()}>Enviar webhook de incidente</button>
            <JsonBlock value={webhookOutput ?? overview.data?.lastWebhookIssue ?? overview.data?.lastWebhook ?? { note: "Nenhum webhook recebido ainda." }} />
          </div>
          <div style={layoutStack}>
            <strong>Despachante de Ferramentas</strong>
            <input style={inputStyle} value={toolMessage} onChange={(event) => setToolMessage(event.target.value)} />
            <div style={rowStyle}>
              <button type="button" style={buttonStyle} onClick={() => void executeTool(TOOL_NAMES.echo)}>Executar eco de nota</button>
              <button type="button" style={buttonStyle} onClick={() => void executeTool(TOOL_NAMES.companySummary)}>Executar resumo da empresa</button>
              <button type="button" style={buttonStyle} onClick={() => void executeTool(TOOL_NAMES.createIssue)}>Executar criação de issue</button>
            </div>
            <JsonBlock value={toolOutput ?? { note: "Ainda não há saída de ferramenta." }} />
          </div>
        </div>
      </Section>

      <Section title="Resultado Mais Recente">
        <JsonBlock value={result ?? { note: "Execute uma ação para ver o resultado aqui." }} />
      </Section>
    </div>
  );
}

export function KitchenSinkPage({ context }: PluginPageProps) {
  return (
    <div style={layoutStack}>
      <KitchenSinkPageWidgets context={context} />
      <KitchenSinkEmbeddedApp context={context} />
      <KitchenSinkConsole context={context} />
    </div>
  );
}

export function KitchenSinkSettingsPage({ context }: PluginSettingsPageProps) {
  const { configJson, setConfigJson, loading, saving, error, save } = useSettingsConfig();
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  function setField(key: string, value: unknown) {
    setConfigJson((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await save(configJson);
    setSavedMessage("Salvo");
    window.setTimeout(() => setSavedMessage(null), 1500);
  }

  if (loading) {
    return <div style={{ fontSize: "12px", opacity: 0.7 }}>Carregando configuração do plugin…</div>;
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "18px" }}>
      <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "minmax(0, 1.8fr) minmax(220px, 1fr)" }}>
        <div style={{ display: "grid", gap: "8px" }}>
          <strong>Sobre</strong>
          <div style={{ fontSize: "13px", lineHeight: 1.5 }}>
            A Central de Operações expõe uma superfície ampla de plugins do Paperclip em um único plugin interno e confiável. Ela inclui intencionalmente mutações de domínio, eventos, streams, ferramentas, jobs, webhooks e diagnósticos locais de workspace e processo.
          </div>
          <div style={{ fontSize: "12px", opacity: 0.7 }}>
            Contexto atual da empresa: {context.companyId ?? "nenhum"}
          </div>
        </div>
        <div style={{ display: "grid", gap: "8px" }}>
          <strong>Risco e Modelo de Confiança</strong>
          <div style={{ fontSize: "12px", lineHeight: 1.5 }}>
            O acesso ao workspace e os diagnósticos locais executam como código local confiável. Mantenha a execução de processos desativada, a menos que você queira testar explicitamente o comportamento de subprocessos.
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gap: "12px" }}>
        <strong>Configurações</strong>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.showSidebarEntry !== false}
            onChange={(event) => setField("showSidebarEntry", event.target.checked)}
          />
          <span>Exibir entrada na barra lateral</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.showSidebarPanel !== false}
            onChange={(event) => setField("showSidebarPanel", event.target.checked)}
          />
          <span>Exibir painel lateral</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.showProjectSidebarItem !== false}
            onChange={(event) => setField("showProjectSidebarItem", event.target.checked)}
          />
          <span>Exibir atalho lateral do projeto</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.showCommentAnnotation !== false}
            onChange={(event) => setField("showCommentAnnotation", event.target.checked)}
          />
          <span>Exibir anotação de comentário</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.showCommentContextMenuItem !== false}
            onChange={(event) => setField("showCommentContextMenuItem", event.target.checked)}
          />
          <span>Exibir ação contextual de comentário</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.enableWorkspaceDemos !== false}
            onChange={(event) => setField("enableWorkspaceDemos", event.target.checked)}
          />
          <span>Habilitar acesso ao workspace</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.enableProcessDemos === true}
            onChange={(event) => setField("enableProcessDemos", event.target.checked)}
          />
          <span>Habilitar diagnósticos locais</span>
        </label>
        <label style={{ display: "grid", gap: "6px" }}>
          <span style={{ fontSize: "12px" }}>URL do endpoint HTTP</span>
          <input
            style={inputStyle}
            value={String(configJson.httpDemoUrl ?? DEFAULT_CONFIG.httpDemoUrl)}
            onChange={(event) => setField("httpDemoUrl", event.target.value)}
          />
        </label>
        <label style={{ display: "grid", gap: "6px" }}>
          <span style={{ fontSize: "12px" }}>Referência de segredo</span>
          <input
            style={inputStyle}
            value={String(configJson.secretRefExample ?? "")}
            onChange={(event) => setField("secretRefExample", event.target.value)}
          />
        </label>
        <label style={{ display: "grid", gap: "6px" }}>
          <span style={{ fontSize: "12px" }}>Arquivo de notas do workspace</span>
          <input
            style={inputStyle}
            value={String(configJson.workspaceScratchFile ?? DEFAULT_CONFIG.workspaceScratchFile)}
            onChange={(event) => setField("workspaceScratchFile", event.target.value)}
          />
        </label>
      </div>

      {error ? <div style={{ color: "var(--destructive, #c00)", fontSize: "12px" }}>{error}</div> : null}

      <div style={rowStyle}>
        <button type="submit" style={primaryButtonStyle} disabled={saving}>
          {saving ? "Salvando…" : "Salvar configurações"}
        </button>
        {savedMessage ? <span style={{ fontSize: "12px", opacity: 0.7 }}>{savedMessage}</span> : null}
      </div>
    </form>
  );
}

export function KitchenSinkDashboardWidget({ context }: PluginWidgetProps) {
  const overview = usePluginOverview(context.companyId);
  const writeMetric = usePluginAction("write-metric");

  return (
    <div style={layoutStack}>
      <div style={rowStyle}>
        <strong>{PLUGIN_DISPLAY_NAME}</strong>
        <Pill label="Widget do Dashboard" />
      </div>
      <div style={{ fontSize: "12px", opacity: 0.7 }}>
        Resumo do runtime do plugin para a empresa atual.
      </div>
      <div style={{ display: "grid", gap: "4px", fontSize: "12px" }}>
        <div>Registros recentes: {overview.data?.recentRecords.length ?? 0}</div>
        <div>Projetos: {overview.data?.counts.projects ?? 0}</div>
        <div>Issues: {overview.data?.counts.issues ?? 0}</div>
      </div>
      <div style={rowStyle}>
        <a href={pluginPagePath(context.companyPrefix)} style={{ fontSize: "12px" }}>Abrir página</a>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            if (!context.companyId) return;
            void writeMetric({ companyId: context.companyId, name: "dashboard_click", value: 1 }).catch(console.error);
          }}
        >
          Registrar métrica
        </button>
      </div>
    </div>
  );
}

export function KitchenSinkSidebarLink({ context }: PluginSidebarProps) {
  const config = usePluginConfigData();
  if (config.data && config.data.showSidebarEntry === false) return null;
  const href = pluginPagePath(context.companyPrefix);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      <span className="relative shrink-0">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="4" width="7" height="7" rx="1.5" />
          <rect x="13" y="4" width="7" height="7" rx="1.5" />
          <rect x="4" y="13" width="7" height="7" rx="1.5" />
          <path d="M13 16.5h7" />
          <path d="M16.5 13v7" />
        </svg>
      </span>
      <span className="flex-1 truncate">
        {PLUGIN_DISPLAY_NAME}
      </span>
    </a>
  );
}

export function KitchenSinkSidebarPanel() {
  const context = useHostContext();
  const config = usePluginConfigData();
  const overview = usePluginOverview(context.companyId);
  if (config.data && config.data.showSidebarPanel === false) return null;
  return (
    <div style={{ ...layoutStack, ...subtleCardStyle, fontSize: "12px" }}>
      <strong>Painel Operacional</strong>
      <div>Registros recentes do plugin: {overview.data?.recentRecords.length ?? 0}</div>
      <a href={pluginPagePath(context.companyPrefix)}>Abrir página do plugin</a>
    </div>
  );
}

export function KitchenSinkProjectSidebarItem({ context }: PluginProjectSidebarItemProps) {
  const config = usePluginConfigData();
  if (config.data && config.data.showProjectSidebarItem === false) return null;
  return (
    <a
      href={hostPath(context.companyPrefix, `/projects/${context.entityId}?tab=plugin:${PLUGIN_ID}:${SLOT_IDS.projectTab}`)}
      style={{ fontSize: "12px", textDecoration: "none" }}
    >
      Operações
    </a>
  );
}

export function KitchenSinkProjectTab({ context }: PluginDetailTabProps) {
  return <CompactSurfaceSummary label="Aba de Detalhes do Projeto" entityType="project" />;
}

export function KitchenSinkIssueTab({ context }: PluginDetailTabProps) {
  return <CompactSurfaceSummary label="Aba de Detalhes da Issue" entityType="issue" />;
}

export function KitchenSinkTaskDetailView() {
  return <CompactSurfaceSummary label="Visão de Detalhes da Task" entityType="issue" />;
}

export function KitchenSinkToolbarButton() {
  const context = useHostContext();
  const startProgress = usePluginAction("start-progress-stream");
  return (
    <button
      type="button"
      style={buttonStyle}
      onClick={() => {
        if (!context.companyId) return;
        void startProgress({ companyId: context.companyId, steps: 3 }).catch(console.error);
      }}
    >
      Ação Operacional
    </button>
  );
}

export function KitchenSinkContextMenuItem() {
  const context = useHostContext();
  const writeActivity = usePluginAction("write-activity");
  return (
    <button
      type="button"
      style={buttonStyle}
      onClick={() => {
        if (!context.companyId) return;
        void writeActivity({
          companyId: context.companyId,
          entityType: context.entityType ?? undefined,
          entityId: context.entityId ?? undefined,
          message: "Ação contextual da Central de Operações acionada",
        }).catch(console.error);
      }}
    >
      Contexto Operacional
    </button>
  );
}

export function KitchenSinkCommentAnnotation({ context }: PluginCommentAnnotationProps) {
  const config = usePluginConfigData();
  const data = usePluginData<CommentContextData>(
    "comment-context",
    context.companyId
      ? { companyId: context.companyId, issueId: context.parentEntityId, commentId: context.entityId }
      : {},
  );
  if (config.data && config.data.showCommentAnnotation === false) return null;
  if (!data.data) return null;
  return (
    <div style={{ ...subtleCardStyle, fontSize: "11px" }}>
      <strong>{PLUGIN_DISPLAY_NAME}</strong>
      <div>Tamanho do comentário: {data.data.length}</div>
      <div>Total de capturas: {data.data.copiedCount}</div>
      <div style={{ opacity: 0.75 }}>{data.data.preview}</div>
    </div>
  );
}

export function KitchenSinkCommentContextMenuItem({ context }: PluginCommentContextMenuItemProps) {
  const config = usePluginConfigData();
  const copyCommentContext = usePluginAction("copy-comment-context");
  const [status, setStatus] = useState<string | null>(null);
  if (config.data && config.data.showCommentContextMenuItem === false) return null;
  return (
    <div style={rowStyle}>
      <button
        type="button"
        style={buttonStyle}
        onClick={() => {
          if (!context.companyId) return;
          void copyCommentContext({
            companyId: context.companyId,
            issueId: context.parentEntityId,
            commentId: context.entityId,
          })
            .then(() => setStatus("Copiado"))
            .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
        }}
      >
        Capturar para a Central
      </button>
      {status ? <span style={{ fontSize: "11px", opacity: 0.7 }}>{status}</span> : null}
    </div>
  );
}

export function KitchenSinkLauncherModal() {
  const context = useHostContext();
  return (
    <div style={{ display: "grid", gap: "10px" }}>
      <strong>Modal da Central de Operações</strong>
      <div style={{ fontSize: "12px", opacity: 0.7 }}>
        Esta exportação existe para que a infraestrutura de launchers tenha um alvo concreto de modal.
      </div>
      <JsonBlock value={context.renderEnvironment ?? { note: "Nenhum metadado de ambiente de renderização disponível." }} />
    </div>
  );
}
