import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import {
  AssigneePicker,
  ProjectPicker,
  useHostContext,
  useHostNavigation,
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function isKitchenSinkDemoCompany(company: CompanyRecord): boolean {
  return company.name.startsWith("Kitchen Sink Demo");
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
        {resolvedEntityType ? <Pill label={resolvedEntityType} /> : null}
      </div>
      <div style={mutedTextStyle}>
        This surface demo shows the host context for the current mount point. The metric button records a demo counter so you can verify plugin metrics wiring from a contextual surface.
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
        Record demo metric
      </button>
      {entityQuery.data ? <JsonBlock value={entityQuery.data} /> : null}
    </div>
  );
}

function KitchenSinkPageWidgets({ context }: { context: PluginPageProps["context"] }) {
  const overview = usePluginOverview(context.companyId);
  const toast = usePluginToast();
  const hostNavigation = useHostNavigation();
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
      title: "Progress stream update",
      body: latest.message ?? `Step ${latest.step ?? "?"}`,
      tone: "info",
    });
  }, [progressStream.events]);

  return (
    <div style={widgetGridStyle}>
      <MiniWidget title="Runtime Summary" eyebrow="Overview">
        <div style={{ display: "grid", gap: "4px", fontSize: "12px" }}>
          <div>Companies: {overview.data?.counts.companies ?? 0}</div>
          <div>Projects: {overview.data?.counts.projects ?? 0}</div>
          <div>Issues: {overview.data?.counts.issues ?? 0}</div>
          <div>Agents: {overview.data?.counts.agents ?? 0}</div>
        </div>
      </MiniWidget>

      <MiniWidget title="Quick Actions" eyebrow="Try It">
        <div style={rowStyle}>
          <button
            type="button"
            style={toneButtonStyle("success")}
            onClick={() =>
              toast({
                title: "Kitchen Sink success toast",
                body: "This is rendered by the host toast system from plugin UI.",
                tone: "success",
              })}
          >
            Success toast
          </button>
          <button
            type="button"
            style={toneButtonStyle("warn")}
            onClick={() =>
              toast({
                title: "Kitchen Sink warning toast",
                body: "Use this pattern for user-facing plugin feedback.",
                tone: "warn",
              })}
          >
            Warning toast
          </button>
          <button
            type="button"
            style={toneButtonStyle("info")}
            onClick={() =>
              toast({
                title: "Open dashboard",
                body: "Toasts can link back into host pages.",
                tone: "info",
                action: {
                  label: "Go",
                  href: hostNavigation.resolveHref("/dashboard"),
                },
              })}
          >
            Action toast
          </button>
        </div>
        <div style={rowStyle}>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              if (!context.companyId) return;
              void emitDemoEvent({ companyId: context.companyId, message: "Triggered from Kitchen Sink page" })
                .then((next) => {
                  overview.refresh();
                  const message = getObjectString(next, "message") ?? "Demo event emitted";
                  setQuickActionStatus({
                    title: "Event emitted",
                    body: message,
                    tone: "success",
                  });
                  toast({
                    title: "Event emitted",
                    body: message,
                    tone: "success",
                  });
                })
                .catch((error) => {
                  const message = getErrorMessage(error);
                  setQuickActionStatus({
                    title: "Event failed",
                    body: message,
                    tone: "error",
                  });
                  toast({
                    title: "Event failed",
                    body: message,
                    tone: "error",
                  });
                });
            }}
          >
            Emit event
          </button>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              if (!context.companyId) return;
              void startProgressStream({ companyId: context.companyId, steps: 4 })
                .then(() => {
                  setQuickActionStatus({
                    title: "Stream started",
                    body: "Watch the live progress updates below.",
                    tone: "info",
                  });
                  toast({
                    title: "Progress stream started",
                    body: "Live updates will appear in the quick action panel.",
                    tone: "info",
                  });
                })
                .catch((error) => {
                  const message = getErrorMessage(error);
                  setQuickActionStatus({
                    title: "Stream failed",
                    body: message,
                    tone: "error",
                  });
                  toast({
                    title: "Progress stream failed",
                    body: message,
                    tone: "error",
                  });
                });
            }}
          >
            Start stream
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
                  const body = `Recorded demo.page_quick_action = ${value}`;
                  setQuickActionStatus({
                    title: "Metric recorded",
                    body,
                    tone: "success",
                  });
                  toast({
                    title: "Metric recorded",
                    body,
                    tone: "success",
                  });
                })
                .catch((error) => {
                  const message = getErrorMessage(error);
                  setQuickActionStatus({
                    title: "Metric failed",
                    body: message,
                    tone: "error",
                  });
                  toast({
                    title: "Metric failed",
                    body: message,
                    tone: "error",
                  });
                });
            }}
          >
            Write metric
          </button>
        </div>
        <div style={{ display: "grid", gap: "6px" }}>
          <div style={mutedTextStyle}>
            Recent progress events: {progressStream.events.length}
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

      <MiniWidget title="Surface Map" eyebrow="UI">
        <div style={{ display: "grid", gap: "4px", fontSize: "12px" }}>
          <div>Sidebar link and panel</div>
          <div>Dashboard widget</div>
          <div>Project link, tab, toolbar button, launcher</div>
          <div>Issue tab, task view, toolbar button, launcher</div>
          <div>Comment annotation and comment action</div>
        </div>
      </MiniWidget>

      <MiniWidget title="Manifest Coverage" eyebrow="Worker">
        <div style={{ display: "grid", gap: "4px", fontSize: "12px" }}>
          <div>Jobs: {overview.data?.manifest.jobs.length ?? 0}</div>
          <div>Webhooks: {overview.data?.manifest.webhooks.length ?? 0}</div>
          <div>Tools: {overview.data?.manifest.tools.length ?? 0}</div>
          <div>Launchers: {overview.data?.runtimeLaunchers.length ?? 0}</div>
        </div>
      </MiniWidget>

      <MiniWidget title="Latest Runtime State" eyebrow="Diagnostics">
        <div style={mutedTextStyle}>
          This updates as you use the worker demos below.
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
  const [createTitle, setCreateTitle] = useState("Kitchen Sink demo issue");
  const [createDescription, setCreateDescription] = useState("Created from the Kitchen Sink embedded page.");
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
      toast({ title: "Issue created", body: createTitle.trim(), tone: "success" });
      setCreateTitle("Kitchen Sink demo issue");
      setCreateDescription("Created from the Kitchen Sink embedded page.");
      await loadIssues();
    } catch (nextError) {
      toast({ title: "Issue create failed", body: getErrorMessage(nextError), tone: "error" });
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
      toast({ title: "Issue updated", body: draft.title.trim(), tone: "success" });
      await loadIssues();
    } catch (nextError) {
      toast({ title: "Issue update failed", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  async function handleDelete(issueId: string) {
    try {
      await hostFetchJson(`/api/issues/${issueId}`, { method: "DELETE" });
      toast({ title: "Issue deleted", tone: "info" });
      await loadIssues();
    } catch (nextError) {
      toast({ title: "Issue delete failed", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  return (
    <Section title="Issue CRUD">
      <div style={mutedTextStyle}>
        This is a regular embedded React page inside Paperclip calling the board API directly. It creates, updates, and deletes issues for the current company.
      </div>
      {!context.companyId ? (
        <div style={mutedTextStyle}>Select a company to use issue demos.</div>
      ) : (
        <>
          <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) auto" }}>
            <input style={inputStyle} value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="Issue title" />
            <input style={inputStyle} value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} placeholder="Issue description" />
            <button type="button" style={primaryButtonStyle} onClick={() => void handleCreate()}>
              Create issue
            </button>
          </div>
          {loading ? <div style={mutedTextStyle}>Loading issues…</div> : null}
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
                      <option value="backlog">backlog</option>
                      <option value="todo">todo</option>
                      <option value="in_progress">in_progress</option>
                      <option value="in_review">in_review</option>
                      <option value="done">done</option>
                      <option value="blocked">blocked</option>
                      <option value="cancelled">cancelled</option>
                    </select>
                    <button type="button" style={buttonStyle} onClick={() => void handleSave(issue.id)}>
                      Save
                    </button>
                    <button type="button" style={buttonStyle} onClick={() => void handleDelete(issue.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
            {!loading && issues.length === 0 ? <div style={mutedTextStyle}>No issues yet for this company.</div> : null}
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
  const [newCompanyName, setNewCompanyName] = useState(`Kitchen Sink Demo ${new Date().toLocaleTimeString()}`);
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
    const name = trimmed.startsWith("Kitchen Sink Demo") ? trimmed : `Kitchen Sink Demo ${trimmed}`;
    try {
      await hostFetchJson("/api/companies", {
        method: "POST",
        body: JSON.stringify({
          name,
          description: "Created from the Kitchen Sink example plugin page.",
        }),
      });
      toast({ title: "Demo company created", body: name, tone: "success" });
      setNewCompanyName(`Kitchen Sink Demo ${Date.now()}`);
      await loadCompanies();
    } catch (nextError) {
      toast({ title: "Company create failed", body: getErrorMessage(nextError), tone: "error" });
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
      toast({ title: "Company updated", body: draft.name.trim(), tone: "success" });
      await loadCompanies();
    } catch (nextError) {
      toast({ title: "Company update failed", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  async function handleDelete(company: CompanyRecord) {
    try {
      await hostFetchJson(`/api/companies/${company.id}`, { method: "DELETE" });
      toast({ title: "Demo company deleted", body: company.name, tone: "info" });
      await loadCompanies();
    } catch (nextError) {
      toast({ title: "Company delete failed", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  const currentCompany = companies.find((company) => company.id === context.companyId) ?? null;
  const demoCompanies = companies.filter(isKitchenSinkDemoCompany);

  return (
    <Section title="Company CRUD">
      <div style={mutedTextStyle}>
        The worker SDK currently exposes company reads. This page shows a pragmatic embedded-app pattern for broader board actions by calling the host REST API directly.
      </div>
      <div style={subtleCardStyle}>
        <div style={rowStyle}>
          <strong>Current Company</strong>
          {currentCompany ? <Pill label={currentCompany.issuePrefix ?? "no-prefix"} /> : null}
        </div>
        <div style={{ fontSize: "12px" }}>{currentCompany?.name ?? "No current company selected"}</div>
      </div>
      <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "minmax(0, 1fr) auto" }}>
        <input
          style={inputStyle}
          value={newCompanyName}
          onChange={(event) => setNewCompanyName(event.target.value)}
          placeholder="Kitchen Sink Demo Company"
        />
        <button type="button" style={primaryButtonStyle} onClick={() => void handleCreate()}>
          Create demo company
        </button>
      </div>
      {loading ? <div style={mutedTextStyle}>Loading companies…</div> : null}
      {error ? <div style={{ ...mutedTextStyle, color: "var(--destructive, #dc2626)" }}>{error}</div> : null}
      <div style={{ display: "grid", gap: "10px" }}>
        {demoCompanies.map((company) => {
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
                  <option value="active">active</option>
                  <option value="paused">paused</option>
                  <option value="archived">archived</option>
                </select>
                <button type="button" style={buttonStyle} onClick={() => void handleSave(company.id)}>
                  Save
                </button>
                <button type="button" style={buttonStyle} onClick={() => void handleDelete(company)} disabled={isCurrent}>
                  Delete
                </button>
              </div>
              {isCurrent ? <div style={{ ...mutedTextStyle, marginTop: "8px" }}>Current company cannot be deleted from this demo.</div> : null}
            </div>
          );
        })}
        {!loading && demoCompanies.length === 0 ? (
          <div style={mutedTextStyle}>No demo companies yet. Create one above and manage it from this page.</div>
        ) : null}
      </div>
    </Section>
  );
}

function KitchenSinkTopRow({ context }: { context: PluginPageProps["context"] }) {
  const hostNavigation = useHostNavigation();
  return (
    <div
      style={{
        display: "grid",
        gap: "14px",
        gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        alignItems: "stretch",
      }}
    >
      <Section title="Embedded App Demo">
        <div style={{ fontSize: "13px", lineHeight: 1.5 }}>
          Plugins can host their own React page and behave like a native company page. Kitchen Sink now uses this route as a practical demo app, then keeps the lower-level worker console below for the rest of the SDK surface.
        </div>
      </Section>
      <div style={{ display: "grid", gap: "14px" }}>
        <Section title="Plugin Page Route">
          <div style={mutedTextStyle}>
            The company sidebar entry opens this route directly, so the plugin feels like a first-class company page instead of a settings subpage.
          </div>
          <a {...hostNavigation.linkProps(`/${PAGE_ROUTE}`)} style={{ fontSize: "12px" }}>
            {hostNavigation.resolveHref(`/${PAGE_ROUTE}`)}
          </a>
        </Section>
        <Section title="Paperclip Animation">
          <div style={mutedTextStyle}>
            This is the same Paperclip ASCII treatment used in onboarding, copied into the example plugin so the package stays self-contained.
          </div>
          <AsciiArtAnimation />
        </Section>
      </div>
    </div>
  );
}

function KitchenSinkStorageDemo({ context }: { context: PluginPageProps["context"] }) {
  const toast = usePluginToast();
  const stateKey = "revenue_clicker";
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
      toast({ title: "Storage write failed", body: getErrorMessage(nextError), tone: "error" });
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
      toast({ title: "Revenue counter reset", tone: "info" });
      revenueState.refresh();
    } catch (nextError) {
      toast({ title: "Storage reset failed", body: getErrorMessage(nextError), tone: "error" });
    }
  }

  return (
    <Section title="Plugin Storage">
      <div style={mutedTextStyle}>
        This clicker persists into plugin-scoped company storage. A real revenue plugin could store counters, sync cursors, or cached external IDs the same way.
      </div>
      {!context.companyId ? (
        <div style={mutedTextStyle}>Select a company to use company-scoped plugin storage.</div>
      ) : (
        <>
          <div style={{ display: "grid", gap: "4px" }}>
            <div style={{ fontSize: "26px", fontWeight: 700 }}>{currentValue}</div>
            <div style={mutedTextStyle}>Stored at `company/{context.companyId}/{stateKey}`</div>
          </div>
          <div style={rowStyle}>
            {[-10, -1, 1, 10].map((delta) => (
              <button key={delta} type="button" style={buttonStyle} onClick={() => void adjust(delta)}>
                {delta > 0 ? `+${delta}` : delta}
              </button>
            ))}
            <button type="button" style={buttonStyle} onClick={() => void reset()}>
              Reset
            </button>
          </div>
          <JsonBlock value={revenueState.data ?? { scopeKind: "company", stateKey, value: 0 }} />
        </>
      )}
    </Section>
  );
}

function KitchenSinkHostIntegrationDemo({ context }: { context: PluginPageProps["context"] }) {
  const hostNavigation = useHostNavigation();
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
    <Section title="Host Integrations">
      <div style={mutedTextStyle}>
        Plugin pages can feel like native Paperclip pages. This section demonstrates host toasts, company-scoped routing, and reading live heartbeat data from the embedded page.
      </div>
      <div style={subtleCardStyle}>
        <div style={rowStyle}>
          <strong>Company Route</strong>
          <Pill label={hostNavigation.resolveHref(`/${PAGE_ROUTE}`)} />
        </div>
        <div style={mutedTextStyle}>
          This page is mounted as a real company route instead of living only under `/plugins/:pluginId`.
        </div>
      </div>
      {!context.companyId ? (
        <div style={mutedTextStyle}>Select a company to read run data.</div>
      ) : (
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          <div style={subtleCardStyle}>
            <div style={sectionHeaderStyle}>
              <strong>Live Runs</strong>
              <button type="button" style={buttonStyle} onClick={() => void loadRuns()}>
                Refresh
              </button>
            </div>
            {loading ? <div style={mutedTextStyle}>Loading run data…</div> : null}
            {error ? <div style={{ ...mutedTextStyle, color: "var(--destructive, #dc2626)" }}>{error}</div> : null}
            <MiniList
              items={liveRuns}
              empty="No live runs right now."
              render={(item) => {
                const run = item as HostLiveRunRecord;
                return (
                  <div style={{ display: "grid", gap: "6px", fontSize: "12px" }}>
                    <div style={rowStyle}>
                      <strong>{run.status}</strong>
                      {run.agentName ? <Pill label={run.agentName} /> : null}
                    </div>
                    <div>{run.id}</div>
                    {run.agentId ? (
                      <a {...hostNavigation.linkProps(`/agents/${run.agentId}/runs/${run.id}`)}>
                        Open run
                      </a>
                    ) : null}
                  </div>
                );
              }}
            />
          </div>
          <div style={subtleCardStyle}>
            <strong>Recent Heartbeats</strong>
            <MiniList
              items={recentRuns}
              empty="No recent heartbeat runs."
              render={(item) => {
                const run = item as HostHeartbeatRunRecord;
                return (
                  <div style={{ display: "grid", gap: "6px", fontSize: "12px" }}>
                    <div style={rowStyle}>
                      <strong>{run.status}</strong>
                      {run.invocationSource ? <Pill label={run.invocationSource} /> : null}
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

function KitchenSinkSharedPickerDemo({ context }: { context: PluginPageProps["context"] }) {
  const [assigneeValue, setAssigneeValue] = useState("");
  const [projectId, setProjectId] = useState(context.projectId ?? "");

  useEffect(() => {
    setProjectId(context.projectId ?? "");
  }, [context.projectId]);

  return (
    <Section title="Shared Host Pickers">
      <div style={mutedTextStyle}>
        These controls are imported from `@paperclipai/plugin-sdk/ui` and reuse the host's assignee and project pickers from the new issue pane.
      </div>
      {!context.companyId ? (
        <div style={mutedTextStyle}>Select a company to load picker options.</div>
      ) : (
        <div style={subtleCardStyle}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
            <AssigneePicker
              companyId={context.companyId}
              value={assigneeValue}
              onChange={(value) => setAssigneeValue(value)}
            />
            <ProjectPicker
              companyId={context.companyId}
              value={projectId}
              onChange={setProjectId}
            />
          </div>
          <div style={{ ...mutedTextStyle, marginTop: "8px" }}>
            Selected assignee: {assigneeValue || "none"}, selected project: {projectId || "none"}
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
      <KitchenSinkSharedPickerDemo context={context} />
      <KitchenSinkHostIntegrationDemo context={context} />
    </div>
  );
}

function KitchenSinkConsole({ context }: { context: { companyId: string | null; companyPrefix?: string | null; projectId?: string | null; entityId?: string | null; entityType?: string | null } }) {
  const hostNavigation = useHostNavigation();
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

  const [issueTitle, setIssueTitle] = useState("Kitchen Sink demo issue");
  const [goalTitle, setGoalTitle] = useState("Kitchen Sink demo goal");
  const [stateScopeKind, setStateScopeKind] = useState("instance");
  const [stateScopeId, setStateScopeId] = useState("");
  const [stateNamespace, setStateNamespace] = useState("");
  const [stateKey, setStateKey] = useState("demo");
  const [stateValue, setStateValue] = useState("{\"hello\":\"world\"}");
  const [entityType, setEntityType] = useState("demo-record");
  const [entityTitle, setEntityTitle] = useState("Kitchen Sink Entity");
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
  const [workspaceContent, setWorkspaceContent] = useState("Kitchen Sink wrote this file.");
  const [commandKey, setCommandKey] = useState<string>(SAFE_COMMANDS[0]?.key ?? "pwd");
  const [toolMessage, setToolMessage] = useState("Hello from the Kitchen Sink tool");
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
      setToolOutput({ error: "Select a company, project, and agent first." });
      return;
    }
    try {
      const toolName = `${PLUGIN_ID}:${name}`;
      const body =
        name === TOOL_NAMES.echo
          ? { message: toolMessage }
          : name === TOOL_NAMES.createIssue
            ? { title: issueTitle, description: "Created through the tool dispatcher demo." }
            : {};
      const response = await hostFetchJson(`/api/plugins/tools/execute`, {
        method: "POST",
        body: JSON.stringify({
          tool: toolName,
          parameters: body,
          runContext: {
            agentId: selectedAgentId,
            runId: `kitchen-sink-${Date.now()}`,
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
          source: "kitchen-sink-ui",
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
        title="Overview"
        action={<button type="button" style={buttonStyle} onClick={() => refreshAll()}>Refresh</button>}
      >
        <div style={rowStyle}>
          <Pill label={`Plugin: ${overview.data?.pluginId ?? PLUGIN_ID}`} />
          <Pill label={`Version: ${overview.data?.version ?? "loading"}`} />
          <Pill label={`Company: ${companyId ?? "none"}`} />
          {context.entityType ? <Pill label={`Entity: ${context.entityType}`} /> : null}
        </div>
        {overview.data ? (
          <>
            <div style={{ display: "grid", gap: "8px", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
              <StatusLine label="Companies" value={overview.data.counts.companies} />
              <StatusLine label="Projects" value={overview.data.counts.projects} />
              <StatusLine label="Issues" value={overview.data.counts.issues} />
              <StatusLine label="Goals" value={overview.data.counts.goals} />
              <StatusLine label="Agents" value={overview.data.counts.agents} />
              <StatusLine label="Entities" value={overview.data.counts.entities} />
            </div>
            <JsonBlock value={overview.data.config} />
          </>
        ) : (
          <div style={{ fontSize: "12px", opacity: 0.7 }}>Loading overview…</div>
        )}
      </Section>

      <Section title="UI Surfaces">
        <div style={rowStyle}>
          <a {...hostNavigation.linkProps(`/${PAGE_ROUTE}`)} style={{ fontSize: "12px" }}>Open plugin page</a>
          {projectRef ? (
            <a
              {...hostNavigation.linkProps(`/projects/${projectRef}?tab=plugin:${PLUGIN_ID}:${SLOT_IDS.projectTab}`)}
              style={{ fontSize: "12px" }}
            >
              Open project tab
            </a>
          ) : null}
          {selectedIssueId ? (
            <a
              {...hostNavigation.linkProps(`/issues/${selectedIssueId}`)}
              style={{ fontSize: "12px" }}
            >
              Open selected issue
            </a>
          ) : null}
        </div>
        <JsonBlock value={overview.data?.runtimeLaunchers ?? []} />
      </Section>

      <Section title="Paperclip Domain APIs">
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <PaginatedDomainCard
            title="Companies"
            items={companies.data ?? []}
            totalCount={overview.data?.counts.companies ?? null}
            empty="No companies."
            onLoadMore={() => setCompaniesLimit((current) => current + 20)}
            render={(item) => {
              const company = item as CompanyRecord;
              return <div>{company.name} <span style={{ opacity: 0.6 }}>({company.id.slice(0, 8)})</span></div>;
            }}
          />
          <PaginatedDomainCard
            title="Projects"
            items={projects.data ?? []}
            totalCount={overview.data?.counts.projects ?? null}
            empty="No projects."
            onLoadMore={() => setProjectsLimit((current) => current + 20)}
            render={(item) => {
              const project = item as ProjectRecord;
              return <div>{project.name} <span style={{ opacity: 0.6 }}>({project.status ?? "unknown"})</span></div>;
            }}
          />
          <PaginatedDomainCard
            title="Issues"
            items={issues.data ?? []}
            totalCount={overview.data?.counts.issues ?? null}
            empty="No issues."
            onLoadMore={() => setIssuesLimit((current) => current + 20)}
            render={(item) => {
              const issue = item as IssueRecord;
              return <div>{issue.title} <span style={{ opacity: 0.6 }}>({issue.status})</span></div>;
            }}
          />
          <PaginatedDomainCard
            title="Goals"
            items={goals.data ?? []}
            totalCount={overview.data?.counts.goals ?? null}
            empty="No goals."
            onLoadMore={() => setGoalsLimit((current) => current + 20)}
            render={(item) => {
              const goal = item as GoalRecord;
              return <div>{goal.title} <span style={{ opacity: 0.6 }}>({goal.status})</span></div>;
            }}
          />
        </div>
      </Section>

      <Section title="Issue + Goal Actions">
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
            <strong>Create issue</strong>
            <input style={inputStyle} value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} />
            <button type="submit" style={primaryButtonStyle} disabled={!companyId}>Create issue</button>
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
            <strong>Advance selected issue</strong>
            <select style={inputStyle} value={selectedIssueId} onChange={(event) => setSelectedIssueId(event.target.value)}>
              {(issues.data ?? []).map((issue) => (
                <option key={issue.id} value={issue.id}>{issue.title}</option>
              ))}
            </select>
            <button type="submit" style={buttonStyle} disabled={!companyId || !selectedIssueId}>Move to in_review</button>
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
            <strong>Create goal</strong>
            <input style={inputStyle} value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} />
            <button type="submit" style={primaryButtonStyle} disabled={!companyId}>Create goal</button>
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
            <strong>Advance selected goal</strong>
            <select style={inputStyle} value={selectedGoalId} onChange={(event) => setSelectedGoalId(event.target.value)}>
              {(goals.data ?? []).map((goal) => (
                <option key={goal.id} value={goal.id}>{goal.title}</option>
              ))}
            </select>
            <button type="submit" style={buttonStyle} disabled={!companyId || !selectedGoalId}>Move to active</button>
          </form>
        </div>
      </Section>

      <Section title="State + Entities">
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
            <strong>State</strong>
            <input style={inputStyle} value={stateScopeKind} onChange={(event) => setStateScopeKind(event.target.value)} placeholder="scopeKind" />
            <input style={inputStyle} value={stateScopeId} onChange={(event) => setStateScopeId(event.target.value)} placeholder="scopeId (optional)" />
            <input style={inputStyle} value={stateNamespace} onChange={(event) => setStateNamespace(event.target.value)} placeholder="namespace (optional)" />
            <input style={inputStyle} value={stateKey} onChange={(event) => setStateKey(event.target.value)} placeholder="stateKey" />
            <textarea style={{ ...inputStyle, minHeight: "88px" }} value={stateValue} onChange={(event) => setStateValue(event.target.value)} />
            <div style={rowStyle}>
              <button type="submit" style={primaryButtonStyle}>Write state</button>
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
                Delete state
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
            <strong>Entities</strong>
            <input style={inputStyle} value={entityType} onChange={(event) => setEntityType(event.target.value)} placeholder="entityType" />
            <input style={inputStyle} value={entityTitle} onChange={(event) => setEntityTitle(event.target.value)} placeholder="title" />
            <input style={inputStyle} value={entityScopeKind} onChange={(event) => setEntityScopeKind(event.target.value)} placeholder="scopeKind" />
            <input style={inputStyle} value={entityScopeId} onChange={(event) => setEntityScopeId(event.target.value)} placeholder="scopeId (optional)" />
            <button type="submit" style={primaryButtonStyle}>Upsert entity</button>
            <JsonBlock value={entityQuery.data ?? []} />
          </form>
        </div>
      </Section>

      <Section title="Events + Streams">
        <div style={rowStyle}>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => {
              if (!companyId) return;
              void emitDemoEvent({ companyId, message: "Kitchen Sink manual event" })
                .then((next) => {
                  setResult(next);
                  overview.refresh();
                })
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            Emit demo event
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
            Start progress stream
          </button>
        </div>
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div style={subtleCardStyle}>
            <strong>Progress stream</strong>
            <JsonBlock value={progressStream.events.slice(-8)} />
          </div>
          <div style={subtleCardStyle}>
            <strong>Recent records</strong>
            <JsonBlock value={overview.data?.recentRecords ?? []} />
          </div>
        </div>
      </Section>

      <Section title="HTTP + Secrets + Activity + Metrics">
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
            <button type="submit" style={buttonStyle}>Fetch URL</button>
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
            <strong>Secrets</strong>
            <input style={inputStyle} value={secretRef} onChange={(event) => setSecretRef(event.target.value)} placeholder="MY_SECRET_REF" />
            <button type="submit" style={buttonStyle}>Resolve secret ref</button>
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
            <strong>Activity + Metrics</strong>
            <input style={inputStyle} value={metricName} onChange={(event) => setMetricName(event.target.value)} placeholder="metric name" />
            <input style={inputStyle} value={metricValue} onChange={(event) => setMetricValue(event.target.value)} placeholder="metric value" />
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
                Write metric
              </button>
              <button type="submit" style={buttonStyle} disabled={!companyId}>Write activity</button>
            </div>
          </form>
        </div>
      </Section>

      <Section title="Workspace + Process">
        <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div style={layoutStack}>
            <strong>Select project/workspace</strong>
            <select style={inputStyle} value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
              <option value="">Select project</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
            <select style={inputStyle} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              <option value="">Select workspace</option>
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
            <strong>Workspace file</strong>
            <input style={inputStyle} value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} />
            <textarea style={{ ...inputStyle, minHeight: "88px" }} value={workspaceContent} onChange={(event) => setWorkspaceContent(event.target.value)} />
            <div style={rowStyle}>
              <button type="submit" style={buttonStyle} disabled={!companyId || !selectedProjectId}>Write scratch file</button>
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
                Read file
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
            <strong>Curated process demo</strong>
            <select style={inputStyle} value={commandKey} onChange={(event) => setCommandKey(event.target.value)}>
              {SAFE_COMMANDS.map((command) => (
                <option key={command.key} value={command.key}>{command.label}</option>
              ))}
            </select>
            <button type="submit" style={buttonStyle} disabled={!companyId || !selectedProjectId}>Run command</button>
            <JsonBlock value={overview.data?.lastProcessResult ?? { note: "No process run yet." }} />
          </form>
        </div>
      </Section>

      <Section title="Agents + Sessions">
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId || !selectedAgentId) return;
              void invokeAgent({ companyId, agentId: selectedAgentId, prompt: "Kitchen Sink invoke demo" })
                .then((next) => setResult(next))
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Agent controls</strong>
            <select style={inputStyle} value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
              {(agents.data ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
            <div style={rowStyle}>
              <button type="submit" style={primaryButtonStyle} disabled={!companyId || !selectedAgentId}>Invoke</button>
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
                Pause
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
                Resume
              </button>
            </div>
          </form>
          <form
            style={layoutStack}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId || !selectedAgentId) return;
              void askAgent({ companyId, agentId: selectedAgentId, prompt: "Give a short greeting from the Kitchen Sink plugin." })
                .then((next) => setResult(next))
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            <strong>Agent chat stream</strong>
            <button type="submit" style={buttonStyle} disabled={!companyId || !selectedAgentId}>Start chat demo</button>
            <JsonBlock value={agentStream.events.slice(-12)} />
          </form>
        </div>
      </Section>

      <Section title="Jobs + Webhooks + Tools">
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div style={layoutStack}>
            <strong>Job demo</strong>
            <button type="button" style={buttonStyle} onClick={() => void fetchJobsAndTrigger()}>Trigger demo job</button>
            <JsonBlock value={jobOutput ?? overview.data?.lastJob ?? { note: "No job output yet." }} />
          </div>
          <div style={layoutStack}>
            <strong>Webhook demo</strong>
            <button type="button" style={buttonStyle} onClick={() => void sendWebhook()}>Send demo webhook</button>
            <JsonBlock value={webhookOutput ?? overview.data?.lastWebhook ?? { note: "No webhook yet." }} />
          </div>
          <div style={layoutStack}>
            <strong>Tool dispatcher demo</strong>
            <input style={inputStyle} value={toolMessage} onChange={(event) => setToolMessage(event.target.value)} />
            <div style={rowStyle}>
              <button type="button" style={buttonStyle} onClick={() => void executeTool(TOOL_NAMES.echo)}>Run echo tool</button>
              <button type="button" style={buttonStyle} onClick={() => void executeTool(TOOL_NAMES.companySummary)}>Run summary tool</button>
              <button type="button" style={buttonStyle} onClick={() => void executeTool(TOOL_NAMES.createIssue)}>Run create-issue tool</button>
            </div>
            <JsonBlock value={toolOutput ?? { note: "No tool output yet." }} />
          </div>
        </div>
      </Section>

      <Section title="Latest Result">
        <JsonBlock value={result ?? { note: "Run an action to see results here." }} />
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
    setSavedMessage("Saved");
    window.setTimeout(() => setSavedMessage(null), 1500);
  }

  if (loading) {
    return <div style={{ fontSize: "12px", opacity: 0.7 }}>Loading plugin config…</div>;
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "18px" }}>
      <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "minmax(0, 1.8fr) minmax(220px, 1fr)" }}>
        <div style={{ display: "grid", gap: "8px" }}>
          <strong>About</strong>
          <div style={{ fontSize: "13px", lineHeight: 1.5 }}>
            Kitchen Sink demonstrates the current Paperclip plugin API surface in one local, trusted example. It intentionally includes domain mutations, event handling, streams, tools, jobs, webhooks, and local workspace/process demos.
          </div>
          <div style={{ fontSize: "12px", opacity: 0.7 }}>
            Current company context: {context.companyId ?? "none"}
          </div>
        </div>
        <div style={{ display: "grid", gap: "8px" }}>
          <strong>Danger / Trust Model</strong>
          <div style={{ fontSize: "12px", lineHeight: 1.5 }}>
            Workspace and process demos run as trusted local code. Keep process demos off unless you explicitly want to exercise local child process behavior.
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gap: "12px" }}>
        <strong>Settings</strong>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.showSidebarEntry !== false}
            onChange={(event) => setField("showSidebarEntry", event.target.checked)}
          />
          <span>Show sidebar entry</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.showSidebarPanel !== false}
            onChange={(event) => setField("showSidebarPanel", event.target.checked)}
          />
          <span>Show sidebar panel</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.showProjectSidebarItem !== false}
            onChange={(event) => setField("showProjectSidebarItem", event.target.checked)}
          />
          <span>Show project sidebar item</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.showCommentAnnotation !== false}
            onChange={(event) => setField("showCommentAnnotation", event.target.checked)}
          />
          <span>Show comment annotation</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.showCommentContextMenuItem !== false}
            onChange={(event) => setField("showCommentContextMenuItem", event.target.checked)}
          />
          <span>Show comment context action</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.enableWorkspaceDemos !== false}
            onChange={(event) => setField("enableWorkspaceDemos", event.target.checked)}
          />
          <span>Enable workspace demos</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={configJson.enableProcessDemos === true}
            onChange={(event) => setField("enableProcessDemos", event.target.checked)}
          />
          <span>Enable curated process demos</span>
        </label>
        <label style={{ display: "grid", gap: "6px" }}>
          <span style={{ fontSize: "12px" }}>HTTP demo URL</span>
          <input
            style={inputStyle}
            value={String(configJson.httpDemoUrl ?? DEFAULT_CONFIG.httpDemoUrl)}
            onChange={(event) => setField("httpDemoUrl", event.target.value)}
          />
        </label>
        <label style={{ display: "grid", gap: "6px" }}>
          <span style={{ fontSize: "12px" }}>Secret reference example</span>
          <input
            style={inputStyle}
            value={String(configJson.secretRefExample ?? "")}
            onChange={(event) => setField("secretRefExample", event.target.value)}
          />
        </label>
        <label style={{ display: "grid", gap: "6px" }}>
          <span style={{ fontSize: "12px" }}>Workspace scratch file</span>
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
          {saving ? "Saving…" : "Save settings"}
        </button>
        {savedMessage ? <span style={{ fontSize: "12px", opacity: 0.7 }}>{savedMessage}</span> : null}
      </div>
    </form>
  );
}

export function KitchenSinkDashboardWidget({ context }: PluginWidgetProps) {
  const hostNavigation = useHostNavigation();
  const overview = usePluginOverview(context.companyId);
  const writeMetric = usePluginAction("write-metric");

  return (
    <div style={layoutStack}>
      <div style={rowStyle}>
        <strong>Kitchen Sink</strong>
        <Pill label="dashboardWidget" />
      </div>
      <div style={{ fontSize: "12px", opacity: 0.7 }}>
        Plugin runtime surface demo for the current company.
      </div>
      <div style={{ display: "grid", gap: "4px", fontSize: "12px" }}>
        <div>Recent records: {overview.data?.recentRecords.length ?? 0}</div>
        <div>Projects: {overview.data?.counts.projects ?? 0}</div>
        <div>Issues: {overview.data?.counts.issues ?? 0}</div>
      </div>
      <div style={rowStyle}>
        <a {...hostNavigation.linkProps(`/${PAGE_ROUTE}`)} style={{ fontSize: "12px" }}>Open page</a>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            if (!context.companyId) return;
            void writeMetric({ companyId: context.companyId, name: "dashboard_click", value: 1 }).catch(console.error);
          }}
        >
          Write metric
        </button>
      </div>
    </div>
  );
}

export function KitchenSinkSidebarLink({ context }: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  const config = usePluginConfigData();
  if (config.data && config.data.showSidebarEntry === false) return null;
  const href = hostNavigation.resolveHref(`/${PAGE_ROUTE}`);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      {...hostNavigation.linkProps(`/${PAGE_ROUTE}`)}
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
        Kitchen Sink
      </span>
    </a>
  );
}

export function KitchenSinkSidebarPanel() {
  const context = useHostContext();
  const hostNavigation = useHostNavigation();
  const config = usePluginConfigData();
  const overview = usePluginOverview(context.companyId);
  if (config.data && config.data.showSidebarPanel === false) return null;
  return (
    <div style={{ ...layoutStack, ...subtleCardStyle, fontSize: "12px" }}>
      <strong>Kitchen Sink Panel</strong>
      <div>Recent plugin records: {overview.data?.recentRecords.length ?? 0}</div>
      <a {...hostNavigation.linkProps(`/${PAGE_ROUTE}`)}>Open plugin page</a>
    </div>
  );
}

export function KitchenSinkProjectSidebarItem({ context }: PluginProjectSidebarItemProps) {
  const hostNavigation = useHostNavigation();
  const config = usePluginConfigData();
  if (config.data && config.data.showProjectSidebarItem === false) return null;
  return (
    <a
      {...hostNavigation.linkProps(`/projects/${context.entityId}?tab=plugin:${PLUGIN_ID}:${SLOT_IDS.projectTab}`)}
      style={{ fontSize: "12px", textDecoration: "none" }}
    >
      Kitchen Sink
    </a>
  );
}

export function KitchenSinkProjectTab({ context }: PluginDetailTabProps) {
  return <CompactSurfaceSummary label="Project Detail Tab" entityType="project" />;
}

export function KitchenSinkIssueTab({ context }: PluginDetailTabProps) {
  return <CompactSurfaceSummary label="Issue Detail Tab" entityType="issue" />;
}

export function KitchenSinkTaskDetailView() {
  return <CompactSurfaceSummary label="Task Detail View" entityType="issue" />;
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
      Kitchen Sink Action
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
          message: "Kitchen Sink context action clicked",
        }).catch(console.error);
      }}
    >
      Kitchen Sink Context
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
      <strong>Kitchen Sink</strong>
      <div>Comment length: {data.data.length}</div>
      <div>Copied count: {data.data.copiedCount}</div>
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
            .then(() => setStatus("Copied"))
            .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
        }}
      >
        Copy To Kitchen Sink
      </button>
      {status ? <span style={{ fontSize: "11px", opacity: 0.7 }}>{status}</span> : null}
    </div>
  );
}

export function KitchenSinkLauncherModal() {
  const context = useHostContext();
  return (
    <div style={{ display: "grid", gap: "10px" }}>
      <strong>Kitchen Sink Launcher Modal</strong>
      <div style={{ fontSize: "12px", opacity: 0.7 }}>
        This export exists so launcher infrastructure has a concrete modal target.
      </div>
      <JsonBlock value={context.renderEnvironment ?? { note: "No render environment metadata." }} />
    </div>
  );
}
