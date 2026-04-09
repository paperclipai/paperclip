import {
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
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
  Activity,
  Bot,
  Building2,
  ChevronDown,
  ChevronUp,
  Compass,
  Copy,
  FilePenLine,
  FileSearch,
  FolderOpen,
  Gamepad2,
  Gauge,
  Headphones,
  LayoutDashboard,
  MessageSquareText,
  Minus,
  MonitorCog,
  Network,
  PanelsTopLeft,
  Pause,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Sparkles,
  Target,
  TerminalSquare,
  Trash2,
  Users,
  Webhook,
  Workflow,
  type LucideIcon,
} from "lucide-react";
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

type OperationsView = "overview" | "flow" | "aghouse" | "workbench";

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
  fontWeight: 600,
  cursor: "pointer",
  transition: "transform 160ms ease, border-color 160ms ease, background 160ms ease, opacity 160ms ease",
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

const disabledButtonStyle: CSSProperties = {
  opacity: 0.55,
  cursor: "not-allowed",
};

const buttonLabelStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  lineHeight: 1,
  whiteSpace: "nowrap",
};

const fieldLabelStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "12px",
  fontWeight: 600,
};

const toggleRowStyle: CSSProperties = {
  ...subtleCardStyle,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
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

const pageShellStyle: CSSProperties = {
  display: "grid",
  gap: "18px",
};

const heroShellStyle: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
  borderRadius: "18px",
  padding: "18px",
  display: "grid",
  gap: "18px",
  background:
    "linear-gradient(135deg, color-mix(in srgb, var(--foreground) 8%, transparent), color-mix(in srgb, var(--card, transparent) 82%, transparent))",
};

const heroMetricGridStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
};

const heroMetricStyle: CSSProperties = {
  ...subtleCardStyle,
  display: "grid",
  gap: "6px",
  alignContent: "start",
  background: "color-mix(in srgb, var(--card, transparent) 78%, transparent)",
};

const tabRailStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
  padding: "6px",
  border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
  borderRadius: "999px",
  background: "color-mix(in srgb, var(--card, transparent) 72%, transparent)",
};

const groupedGridStyle: CSSProperties = {
  display: "grid",
  gap: "14px",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
};

const actionClusterStyle: CSSProperties = {
  ...subtleCardStyle,
  display: "grid",
  gap: "10px",
  alignContent: "start",
  background: "color-mix(in srgb, var(--card, transparent) 78%, transparent)",
};

const spotlightCardStyle: CSSProperties = {
  ...subtleCardStyle,
  display: "grid",
  gap: "12px",
  alignContent: "start",
  background:
    "linear-gradient(180deg, color-mix(in srgb, var(--foreground) 6%, transparent), color-mix(in srgb, var(--card, transparent) 78%, transparent))",
};

const mutedTextStyle: CSSProperties = {
  fontSize: "12px",
  opacity: 0.72,
  lineHeight: 1.45,
};

const gatherMapShellStyle: CSSProperties = {
  position: "relative",
  minHeight: "680px",
  overflow: "hidden",
  borderRadius: "28px",
  border: "1px solid color-mix(in srgb, var(--border) 84%, transparent)",
  background:
    "linear-gradient(90deg, #d8f1cd 0 16%, #ecf6e8 16% 20%, #f1ead7 20% 82%, #e6f2ee 82% 86%, #d8f1cd 86% 100%)",
  boxShadow:
    "inset 0 0 0 3px color-mix(in srgb, #97a88f 48%, transparent), inset 0 18px 34px color-mix(in srgb, #ffffff 52%, transparent)",
};

const gatherCampusCoreStyle: CSSProperties = {
  position: "absolute",
  inset: "34px 42px",
  borderRadius: "26px",
  border: "3px solid #8d9d97",
  background:
    "repeating-linear-gradient(0deg, #eadfc8 0 10px, #f3ebd8 10px 22px), repeating-linear-gradient(90deg, #eadfc8 0 12px, #f6efe1 12px 24px)",
  boxShadow: "inset 0 0 0 3px color-mix(in srgb, #ffffff 38%, transparent)",
};

const gatherGardenLeftStyle: CSSProperties = {
  position: "absolute",
  inset: "20px auto 20px 18px",
  width: "110px",
  borderRadius: "26px",
  background:
    "radial-gradient(circle at 28px 40px, #77c96d 0 26px, transparent 26px), radial-gradient(circle at 54px 120px, #86d676 0 24px, transparent 24px), radial-gradient(circle at 34px 232px, #7fc46f 0 30px, transparent 30px), radial-gradient(circle at 68px 340px, #6eb95e 0 22px, transparent 22px), linear-gradient(180deg, #cbefbf 0%, #c0e5b8 100%)",
  border: "3px solid color-mix(in srgb, #94b08a 68%, transparent)",
};

const gatherGardenRightStyle: CSSProperties = {
  position: "absolute",
  inset: "20px 18px 20px auto",
  width: "110px",
  borderRadius: "26px",
  background:
    "radial-gradient(circle at 66px 52px, #77c96d 0 24px, transparent 24px), radial-gradient(circle at 38px 160px, #8ad879 0 20px, transparent 20px), radial-gradient(circle at 74px 280px, #78c66d 0 28px, transparent 28px), radial-gradient(circle at 48px 420px, #7bc96f 0 22px, transparent 22px), linear-gradient(180deg, #cbefbf 0%, #c0e5b8 100%)",
  border: "3px solid color-mix(in srgb, #94b08a 68%, transparent)",
};

const gatherHallNorthStyle: CSSProperties = {
  position: "absolute",
  left: "252px",
  right: "184px",
  top: "50px",
  height: "126px",
  borderRadius: "22px",
  background:
    "repeating-linear-gradient(0deg, #cfd7f5 0 10px, #d8e0fb 10px 20px), repeating-linear-gradient(90deg, #c7d3f3 0 10px, #d5def7 10px 20px)",
  border: "3px solid #8895b8",
};

const gatherCorridorStyle: CSSProperties = {
  position: "absolute",
  left: "220px",
  right: "154px",
  top: "188px",
  bottom: "126px",
  borderRadius: "24px",
  background:
    "repeating-linear-gradient(0deg, #f0e3ce 0 12px, #f6ebdb 12px 24px), repeating-linear-gradient(90deg, #eadfcb 0 14px, #f6ecdd 14px 28px)",
  border: "2px solid color-mix(in srgb, #c7b89e 72%, transparent)",
  boxShadow: "inset 0 0 0 2px color-mix(in srgb, #ffffff 44%, transparent)",
};

function gatherRoomStyle(accent: string, floor: string): CSSProperties {
  return {
    position: "absolute",
    overflow: "hidden",
    borderRadius: "20px",
    border: `3px solid ${accent}`,
    background: floor,
    boxShadow: "inset 0 0 0 2px color-mix(in srgb, #ffffff 36%, transparent)",
  };
}

function gatherDeskStyle(accent: string, width = 126): CSSProperties {
  return {
    width,
    height: "56px",
    borderRadius: "12px",
    border: `3px solid ${accent}`,
    background:
      "linear-gradient(180deg, #f8fafc 0 60%, #dfe6ef 60% 100%)",
    boxShadow: "inset 0 -5px 0 color-mix(in srgb, #64748b 22%, transparent)",
  };
}

const gatherMonitorStyle: CSSProperties = {
  width: "22px",
  height: "16px",
  borderRadius: "5px",
  border: "3px solid #475569",
  background: "linear-gradient(180deg, #7dd3fc 0%, #60a5fa 100%)",
  boxShadow: "0 3px 0 #475569",
};

const gatherLampStyle: CSSProperties = {
  width: "12px",
  height: "20px",
  borderRadius: "999px 999px 6px 6px",
  background: "linear-gradient(180deg, #fbbf24 0%, #f97316 100%)",
  boxShadow: "0 0 0 3px color-mix(in srgb, #ffffff 24%, transparent)",
};

function gatherAvatarHeadStyle(color: string, highlight = false): CSSProperties {
  return {
    position: "absolute",
    top: "4px",
    left: "50%",
    width: "28px",
    height: "28px",
    transform: "translateX(-50%)",
    borderRadius: "999px",
    border: `3px solid ${highlight ? "#111827" : "color-mix(in srgb, #0f172a 62%, transparent)"}`,
    background: `radial-gradient(circle at 35% 30%, #ffffff 0 18%, color-mix(in srgb, ${color} 24%, #fde68a) 18% 56%, color-mix(in srgb, ${color} 88%, #0f172a) 56% 100%)`,
    boxShadow: highlight ? "0 0 0 4px color-mix(in srgb, #ffffff 46%, transparent)" : "0 8px 14px rgba(15, 23, 42, 0.12)",
  };
}

function gatherAvatarBodyStyle(color: string, highlight = false): CSSProperties {
  return {
    position: "absolute",
    left: "50%",
    bottom: "6px",
    width: "40px",
    height: "30px",
    transform: "translateX(-50%)",
    borderRadius: "18px 18px 12px 12px",
    border: `3px solid ${highlight ? "#111827" : "color-mix(in srgb, #111827 72%, transparent)"}`,
    background: `linear-gradient(180deg, color-mix(in srgb, ${color} 82%, #ffffff) 0%, color-mix(in srgb, ${color} 96%, #111827) 100%)`,
    boxShadow: highlight ? "0 0 0 4px color-mix(in srgb, #ffffff 46%, transparent)" : "0 10px 18px rgba(15, 23, 42, 0.12)",
  };
}

function tabButtonStyle(active: boolean): CSSProperties {
  return {
    appearance: "none",
    border: "1px solid",
    borderColor: active
      ? "color-mix(in srgb, var(--foreground) 50%, var(--border))"
      : "color-mix(in srgb, var(--border) 82%, transparent)",
    borderRadius: "999px",
    background: active
      ? "color-mix(in srgb, var(--foreground) 12%, transparent)"
      : "transparent",
    color: "inherit",
    padding: "8px 14px",
    fontSize: "12px",
    fontWeight: active ? 700 : 500,
    cursor: "pointer",
    transition: "background 160ms ease, border-color 160ms ease, transform 160ms ease",
  };
}

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

function normalizeOperationsView(value: string | null | undefined): OperationsView {
  if (value === "flow") return "flow";
  if (value === "aghouse" || value === "gather") return "aghouse";
  if (value === "workbench") return "workbench";
  return "overview";
}

function readOperationsViewFromLocation(): OperationsView {
  if (typeof window === "undefined") return "overview";
  return normalizeOperationsView(new URLSearchParams(window.location.search).get("view"));
}

function writeOperationsViewToLocation(view: OperationsView) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (view === "overview") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  const nextHref = `${url.pathname}${url.search}${url.hash}`;
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextHref !== currentHref) {
    window.history.replaceState(window.history.state, "", nextHref);
  }
}

function pluginPagePath(companyPrefix: string | null | undefined, view?: OperationsView | "gather"): string {
  const basePath = hostPath(companyPrefix, `/${PAGE_ROUTE}`);
  const normalizedView = normalizeOperationsView(view);
  if (normalizedView === "overview") return basePath;
  return `${basePath}?view=${normalizedView}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatToken(value: string | null | undefined): string {
  if (!value) return "não definido";
  return TOKEN_LABELS[value] ?? value.replaceAll("_", " ").replaceAll("-", " ");
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
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
  description,
  eyebrow,
  collapsible = false,
  defaultOpen = true,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  eyebrow?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <div style={{ display: "grid", gap: "4px", minWidth: 0 }}>
          {eyebrow ? (
            <div style={{ fontSize: "11px", opacity: 0.65, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {eyebrow}
            </div>
          ) : null}
          <strong>{title}</strong>
          {description ? <div style={mutedTextStyle}>{description}</div> : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" }}>
          {action}
          {collapsible ? (
            <ActionButton
              type="button"
              icon={open ? ChevronUp : ChevronDown}
              aria-expanded={open}
              aria-label={open ? `Recolher ${title}` : `Expandir ${title}`}
              onClick={() => setOpen((current) => !current)}
            >
              {open ? "Recolher" : "Expandir"}
            </ActionButton>
          ) : null}
        </div>
      </div>
      {!collapsible || open ? <div style={layoutStack}>{children}</div> : null}
    </section>
  );
}

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon;
  tone?: "success" | "warn" | "info";
  variant?: "default" | "primary";
};

function ButtonLabel({
  icon: Icon,
  children,
}: {
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span style={buttonLabelStyle}>
      {Icon ? <Icon size={14} aria-hidden="true" style={{ flexShrink: 0 }} /> : null}
      <span>{children}</span>
    </span>
  );
}

function ActionButton({
  icon,
  tone,
  variant = "default",
  style,
  disabled,
  children,
  ...props
}: ActionButtonProps) {
  const resolvedStyle =
    variant === "primary"
      ? primaryButtonStyle
      : tone
        ? toneButtonStyle(tone)
        : buttonStyle;

  return (
    <button
      {...props}
      disabled={disabled}
      style={{
        ...resolvedStyle,
        ...(disabled ? disabledButtonStyle : null),
        ...style,
      }}
    >
      <ButtonLabel icon={icon}>{children}</ButtonLabel>
    </button>
  );
}

function FieldLabel({
  icon: Icon,
  children,
}: {
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span style={fieldLabelStyle}>
      {Icon ? <Icon size={14} aria-hidden="true" style={{ flexShrink: 0 }} /> : null}
      <span>{children}</span>
    </span>
  );
}

function ToggleField({
  icon,
  label,
  checked,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label style={toggleRowStyle}>
      <FieldLabel icon={icon}>{label}</FieldLabel>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
      />
    </label>
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

function HeroMetric({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  icon: LucideIcon;
}) {
  return (
    <div style={heroMetricStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
        <div style={{ fontSize: "11px", opacity: 0.68, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
        <div
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "10px",
            display: "grid",
            placeItems: "center",
            background: "color-mix(in srgb, var(--foreground) 10%, transparent)",
          }}
        >
          <Icon size={14} aria-hidden="true" />
        </div>
      </div>
      <div style={{ fontSize: "24px", fontWeight: 700, lineHeight: 1 }}>{value}</div>
      <div style={mutedTextStyle}>{detail}</div>
    </div>
  );
}

function GatherHudBadge({
  icon: Icon,
  value,
  label,
  tint,
}: {
  icon: LucideIcon;
  value: ReactNode;
  label: string;
  tint: string;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "10px",
        minWidth: "132px",
        padding: "10px 12px",
        borderRadius: "16px",
        border: "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
        background: "rgba(255, 255, 255, 0.82)",
        backdropFilter: "blur(10px)",
        boxShadow: "0 12px 24px rgba(15, 23, 42, 0.08)",
      }}
    >
      <div
        style={{
          width: "34px",
          height: "34px",
          borderRadius: "12px",
          display: "grid",
          placeItems: "center",
          background: tint,
          color: "#0f172a",
          flexShrink: 0,
        }}
      >
        <Icon size={16} aria-hidden="true" />
      </div>
      <div style={{ display: "grid", gap: "2px", minWidth: 0 }}>
        <strong style={{ fontSize: "15px", lineHeight: 1 }}>{value}</strong>
        <span style={{ fontSize: "11px", opacity: 0.68, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      </div>
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
          <ActionButton type="button" icon={Plus} onClick={onLoadMore}>
            Carregar mais 20
          </ActionButton>
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
        Esta superfície contextualiza a entidade atual e permite registrar um pulso de instrumentação diretamente do ponto onde o operador está trabalhando.
      </div>
      <JsonBlock value={context} />
      <ActionButton
        type="button"
        icon={Gauge}
        onClick={() => {
          if (!companyId) return;
          void writeMetric({ name: "surface_click", value: 1, companyId }).catch(console.error);
        }}
      >
        Registrar métrica
      </ActionButton>
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
          <div>Último job: {overview.data?.lastJob ? "registrado" : "sem histórico"}</div>
        </div>
      </MiniWidget>

      <MiniWidget title="Atalhos Operacionais" eyebrow="Ações">
        <div style={rowStyle}>
          <ActionButton
            type="button"
            icon={Target}
            tone="success"
            onClick={() =>
              toast({
                title: "Pulso operacional registrado",
                body: "Feedback imediato para confirmar ações concluídas na Central.",
                tone: "success",
              })}
          >
            Confirmar ação
          </ActionButton>
          <ActionButton
            type="button"
            icon={ShieldAlert}
            tone="warn"
            onClick={() =>
              toast({
                title: "Alerta operacional",
                body: "Use este padrão para sinalizar risco, dependência ou bloqueio.",
                tone: "warn",
              })}
          >
            Sinalizar alerta
          </ActionButton>
          <ActionButton
            type="button"
            icon={Compass}
            tone="info"
            onClick={() =>
              toast({
                title: "Abrir dashboard",
                body: "A Central pode devolver o operador para outra superfície nativa do host.",
                tone: "info",
                action: {
                  label: "Abrir",
                  href: hostPath(context.companyPrefix, "/dashboard"),
                },
              })}
          >
            Abrir com CTA
          </ActionButton>
        </div>
        <div style={rowStyle}>
          <ActionButton
            type="button"
            icon={Sparkles}
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
          </ActionButton>
          <ActionButton
            type="button"
            icon={RadioTower}
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
          </ActionButton>
          <ActionButton
            type="button"
            icon={Gauge}
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
          </ActionButton>
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

      <MiniWidget title="Acesso e Cobertura" eyebrow="Superfícies">
        <div style={{ display: "grid", gap: "4px", fontSize: "12px" }}>
          <div>Rota da empresa: {pluginPagePath(context.companyPrefix)}</div>
          <div>Launchers ativos: {overview.data?.runtimeLaunchers.length ?? 0}</div>
          <div>Slots com foco em projeto, issue e comentário</div>
          <div>Navegação lateral, widget, tabs e ações contextuais</div>
        </div>
      </MiniWidget>

      <MiniWidget title="Automação e Intake" eyebrow="Runtime">
        <div style={{ display: "grid", gap: "4px", fontSize: "12px" }}>
          <div>Jobs: {overview.data?.manifest.jobs.length ?? 0}</div>
          <div>Webhooks: {overview.data?.manifest.webhooks.length ?? 0}</div>
          <div>Ferramentas: {overview.data?.manifest.tools.length ?? 0}</div>
          <div>Registros recentes: {overview.data?.recentRecords.length ?? 0}</div>
        </div>
      </MiniWidget>

      <MiniWidget title="Estado Recente" eyebrow="Diagnósticos">
        <div style={mutedTextStyle}>
          Este bloco acompanha os últimos sinais úteis do runtime operacional.
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
    <Section
      title="Fila Operacional"
      eyebrow="Intake e follow-up"
      collapsible
      description="Registre follow-ups, avance status e mantenha a esteira operacional da empresa atual sem sair da Central."
      action={context.companyId ? <Pill label={`${issues.length} itens`} /> : undefined}
    >
      {!context.companyId ? (
        <div style={mutedTextStyle}>Selecione uma empresa para começar a organizar a fila operacional.</div>
      ) : (
        <>
          <div style={groupedGridStyle}>
            <div style={actionClusterStyle}>
              <strong>Novo follow-up</strong>
              <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) auto" }}>
                <input style={inputStyle} value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="Título da issue" />
                <input style={inputStyle} value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} placeholder="Descrição da issue" />
                <ActionButton type="button" variant="primary" icon={Plus} onClick={() => void handleCreate()}>
                  Criar issue
                </ActionButton>
              </div>
            </div>

            <div style={actionClusterStyle}>
              <strong>Estado da fila</strong>
              <StatusLine label="Items carregados" value={issues.length} />
              <StatusLine label="Escopo" value={context.companyId.slice(0, 8)} />
              <StatusLine label="Status da leitura" value={loading ? "sincronizando" : "atualizado"} />
            </div>
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
                    <ActionButton type="button" icon={Save} onClick={() => void handleSave(issue.id)}>
                      Salvar
                    </ActionButton>
                    <ActionButton type="button" icon={Trash2} onClick={() => void handleDelete(issue.id)}>
                      Excluir
                    </ActionButton>
                  </div>
                </div>
              );
            })}
            {!loading && issues.length === 0 ? <div style={mutedTextStyle}>Ainda não há items na fila desta empresa.</div> : null}
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
        <ActionButton type="button" variant="primary" icon={Plus} onClick={() => void handleCreate()}>
          Criar empresa
        </ActionButton>
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
                <ActionButton type="button" icon={Save} onClick={() => void handleSave(company.id)}>
                  Salvar
                </ActionButton>
                <ActionButton type="button" icon={Trash2} onClick={() => void handleDelete(company)} disabled={isCurrent}>
                  Excluir
                </ActionButton>
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
  const overview = usePluginOverview(context.companyId);

  return (
    <Section
      title="Pulso do turno"
      eyebrow="Visão geral"
      collapsible
      description="Leitura rápida da operação antes de abrir a fila ou entrar no workbench."
    >
      <div style={groupedGridStyle}>
        <div style={spotlightCardStyle}>
          <div style={{ fontSize: "13px", lineHeight: 1.6 }}>
            A Central concentra fila, execução e sinais em um único ponto de controle para o turno.
          </div>
          <div style={rowStyle}>
            <Pill label={`${overview.data?.counts.issues ?? 0} issues`} />
            <Pill label={`${overview.data?.counts.agents ?? 0} agentes`} />
            <Pill label={`${overview.data?.recentRecords.length ?? 0} sinais`} />
          </div>
        </div>

        <div style={actionClusterStyle}>
          <StatusLine label="Fila" value={`${overview.data?.counts.issues ?? 0} abertas para coordenação`} />
          <StatusLine label="Agentes" value={`${overview.data?.counts.agents ?? 0} prontos para acionar`} />
          <StatusLine label="Runtime" value={`${overview.data?.recentRecords.length ?? 0} sinais recentes`} />
        </div>
      </div>
    </Section>
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
    <Section
      title="Memória Operacional"
      eyebrow="Estado persistente"
      collapsible
      description="Persistência escopada por empresa para guardar cursores, checkpoints e confirmações operacionais."
      action={context.companyId ? <Pill label={stateKey} /> : undefined}
    >
      {!context.companyId ? (
        <div style={mutedTextStyle}>Selecione uma empresa para usar a memória operacional escopada.</div>
      ) : (
        <>
          <div style={groupedGridStyle}>
            <div style={spotlightCardStyle}>
              <div style={{ fontSize: "11px", opacity: 0.68, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Valor atual
              </div>
              <div style={{ fontSize: "30px", fontWeight: 700, lineHeight: 1 }}>{currentValue}</div>
              <div style={mutedTextStyle}>Armazenado em `company/{context.companyId}/{stateKey}`</div>
            </div>

            <div style={actionClusterStyle}>
              <strong>Ajuste rápido</strong>
              <div style={mutedTextStyle}>
                Use incrementos curtos para cursores e checkpoints, ou saltos maiores para confirmação de lotes operacionais.
              </div>
              <div style={rowStyle}>
                {[-10, -1, 1, 10].map((delta) => (
                  <ActionButton key={delta} type="button" icon={delta > 0 ? Plus : Minus} onClick={() => void adjust(delta)}>
                    {delta > 0 ? `+${delta}` : delta}
                  </ActionButton>
                ))}
                <ActionButton type="button" icon={RotateCcw} onClick={() => void reset()}>
                  Resetar
                </ActionButton>
              </div>
            </div>
          </div>
          <div style={actionClusterStyle}>
            <strong>Payload persistido</strong>
            <JsonBlock value={revenueState.data ?? { scopeKind: "company", stateKey, value: 0 }} />
          </div>
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
    <Section
      title="Execuções e Heartbeats"
      eyebrow="Estado vivo"
      collapsible
      description="Acompanhe execuções em andamento e heartbeats recentes para decidir quando intervir ou apenas observar."
      action={context.companyId ? <Pill label={`${liveRuns.length} ao vivo`} /> : undefined}
    >
      {!context.companyId ? (
        <div style={mutedTextStyle}>Selecione uma empresa para ler os dados de execução.</div>
      ) : (
        <div style={{ display: "grid", gap: "12px" }}>
          <div style={groupedGridStyle}>
            <div style={actionClusterStyle}>
              <strong>Execuções em andamento</strong>
              <div style={{ fontSize: "28px", fontWeight: 700, lineHeight: 1 }}>{liveRuns.length}</div>
              <div style={mutedTextStyle}>Visão imediata do que está ativo no host para a empresa atual.</div>
            </div>
            <div style={actionClusterStyle}>
              <strong>Heartbeats recentes</strong>
              <div style={{ fontSize: "28px", fontWeight: 700, lineHeight: 1 }}>{recentRuns.length}</div>
              <div style={mutedTextStyle}>Use como sinal de saúde antes de acionar pausas, retomadas ou investigações.</div>
            </div>
            <div style={actionClusterStyle}>
              <strong>Rota ativa</strong>
              <Pill label={pluginPagePath(context.companyPrefix)} />
              <div style={mutedTextStyle}>
                A Central roda diretamente no escopo da empresa para reduzir fricção no fluxo do operador.
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          <div style={subtleCardStyle}>
            <div style={sectionHeaderStyle}>
              <strong>Execuções ao Vivo</strong>
              <ActionButton type="button" icon={RefreshCw} onClick={() => void loadRuns()}>
                Atualizar
              </ActionButton>
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
        </div>
      )}
    </Section>
  );
}

function KitchenSinkEmbeddedApp({ context }: { context: PluginPageProps["context"] }) {
  return (
    <div style={pageShellStyle}>
      <div style={groupedGridStyle}>
        <KitchenSinkStorageDemo context={context} />
        <KitchenSinkIssueCrudDemo context={context} />
      </div>
      <KitchenSinkHostIntegrationDemo context={context} />
    </div>
  );
}

function OperationsWorkbench({ context }: { context: PluginPageProps["context"] }) {
  const companyId = context.companyId;
  const overview = usePluginOverview(companyId);
  const projects = usePluginData<ProjectRecord[]>("projects", companyId ? { companyId, limit: 20 } : {});
  const issues = usePluginData<IssueRecord[]>("issues", companyId ? { companyId, limit: 20 } : {});
  const goals = usePluginData<GoalRecord[]>("goals", companyId ? { companyId, limit: 20 } : {});
  const agents = usePluginData<AgentRecord[]>("agents", companyId ? { companyId } : {});
  const workspaceQuery = usePluginData<Array<{ id: string; name: string; path: string }>>(
    "workspaces",
    companyId && context.projectId ? { companyId, projectId: context.projectId } : {},
  );
  const progressStream = usePluginStream<{ step: number; total: number; message: string }>(
    STREAM_CHANNELS.progress,
    companyId ? { companyId } : undefined,
  );
  const agentStream = usePluginStream<{ eventType: string; message: string | null }>(
    STREAM_CHANNELS.agentChat,
    companyId ? { companyId } : undefined,
  );

  const [selectedProjectId, setSelectedProjectId] = useState(context.projectId ?? "");
  const [selectedIssueId, setSelectedIssueId] = useState("");
  const [selectedGoalId, setSelectedGoalId] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspacePath, setWorkspacePath] = useState<string>(DEFAULT_CONFIG.workspaceScratchFile);
  const [workspaceContent, setWorkspaceContent] = useState("Nota operacional da Central.");
  const [commandKey, setCommandKey] = useState<string>(SAFE_COMMANDS[0]?.key ?? "pwd");
  const [issueTitle, setIssueTitle] = useState("Issue operacional de acompanhamento");
  const [goalTitle, setGoalTitle] = useState("Marco operacional");
  const [toolMessage, setToolMessage] = useState("Resuma o estado operacional atual");
  const [toolOutput, setToolOutput] = useState<unknown>(null);
  const [jobOutput, setJobOutput] = useState<unknown>(null);
  const [webhookOutput, setWebhookOutput] = useState<unknown>(null);
  const [result, setResult] = useState<unknown>(null);

  const createIssue = usePluginAction("create-issue");
  const advanceIssueStatus = usePluginAction("advance-issue-status");
  const createGoal = usePluginAction("create-goal");
  const advanceGoalStatus = usePluginAction("advance-goal-status");
  const readWorkspaceFile = usePluginAction("read-workspace-file");
  const writeWorkspaceScratch = usePluginAction("write-workspace-scratch");
  const runProcess = usePluginAction("run-process");
  const invokeAgent = usePluginAction("invoke-agent");
  const pauseAgent = usePluginAction("pause-agent");
  const resumeAgent = usePluginAction("resume-agent");
  const askAgent = usePluginAction("ask-agent");
  const startProgressStream = usePluginAction("start-progress-stream");

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
    workspaceQuery.refresh();
  }

  async function executeTool(name: string) {
    if (!companyId || !selectedAgentId || !projectRef) {
      setToolOutput({ error: "Selecione empresa, projeto e agente antes de disparar a ferramenta." });
      return;
    }
    try {
      const toolName = `${PLUGIN_ID}:${name}`;
      const body =
        name === TOOL_NAMES.echo
          ? { message: toolMessage }
          : name === TOOL_NAMES.createIssue
            ? { title: issueTitle, description: "Criada pelo despachante operacional da Central." }
            : {};
      const response = await hostFetchJson(`/api/plugins/tools/execute`, {
        method: "POST",
        body: JSON.stringify({
          tool: toolName,
          parameters: body,
          runContext: {
            agentId: selectedAgentId,
            runId: `central-operacoes-${Date.now()}`,
            companyId,
            projectId: projectRef,
          },
        }),
      });
      setToolOutput(response);
      await refreshAll();
    } catch (error) {
      setToolOutput({ error: getErrorMessage(error) });
    }
  }

  async function fetchJobsAndTrigger() {
    try {
      const jobsResponse = await hostFetchJson<Array<{ id: string; jobKey: string }>>(`/api/plugins/${PLUGIN_ID}/jobs`);
      const job = jobsResponse.find((entry) => entry.jobKey === JOB_KEYS.heartbeat) ?? jobsResponse[0];
      if (!job) {
        setJobOutput({ error: "Nenhum job operacional foi encontrado." });
        return;
      }
      const triggerResult = await hostFetchJson(`/api/plugins/${PLUGIN_ID}/jobs/${job.id}/trigger`, {
        method: "POST",
      });
      setJobOutput({ jobs: jobsResponse, triggerResult });
      overview.refresh();
    } catch (error) {
      setJobOutput({ error: getErrorMessage(error) });
    }
  }

  async function sendWebhook() {
    try {
      const response = await hostFetchJson(`/api/plugins/${PLUGIN_ID}/webhooks/${WEBHOOK_KEYS.demo}`, {
        method: "POST",
        body: JSON.stringify({
          source: "central-operacoes-ui",
          companyId,
          projectId: projectRef || undefined,
          title: "Follow-up operacional criado por webhook",
          description: "Criado pela Central de Operações para validar intake externo.",
          sentAt: new Date().toISOString(),
        }),
      });
      setWebhookOutput(response);
      overview.refresh();
    } catch (error) {
      setWebhookOutput({ error: getErrorMessage(error) });
    }
  }

  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <Section
        title="Coordenação Operacional"
        eyebrow="Workbench"
        collapsible
        description="Agrupe criação de follow-ups, avanço de status e ativação de metas sem trocar de superfície."
        action={companyId ? <Pill label={`${(issues.data ?? []).length} issues`} /> : undefined}
      >
        <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <form
            style={actionClusterStyle}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId) return;
              void createIssue({ companyId, projectId: selectedProjectId || undefined, title: issueTitle })
                .then((next) => {
                  setResult(next);
                  return refreshAll();
                })
                .catch((error) => setResult({ error: getErrorMessage(error) }));
            }}
          >
            <strong>Criar follow-up</strong>
            <input style={inputStyle} value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} />
            <ActionButton type="submit" variant="primary" icon={Plus} disabled={!companyId}>Criar issue</ActionButton>
          </form>
          <form
            style={actionClusterStyle}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId || !selectedIssueId) return;
              void advanceIssueStatus({ companyId, issueId: selectedIssueId, status: "in_review" })
                .then((next) => {
                  setResult(next);
                  return refreshAll();
                })
                .catch((error) => setResult({ error: getErrorMessage(error) }));
            }}
          >
            <strong>Avançar issue</strong>
            <select style={inputStyle} value={selectedIssueId} onChange={(event) => setSelectedIssueId(event.target.value)}>
              {(issues.data ?? []).map((issue) => (
                <option key={issue.id} value={issue.id}>{issue.title}</option>
              ))}
            </select>
            <ActionButton type="submit" icon={Workflow} disabled={!companyId || !selectedIssueId}>Mover para em revisão</ActionButton>
          </form>
          <form
            style={actionClusterStyle}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId) return;
              void createGoal({ companyId, title: goalTitle })
                .then((next) => {
                  setResult(next);
                  return refreshAll();
                })
                .catch((error) => setResult({ error: getErrorMessage(error) }));
            }}
          >
            <strong>Criar marco</strong>
            <input style={inputStyle} value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} />
            <ActionButton type="submit" variant="primary" icon={Target} disabled={!companyId}>Criar meta</ActionButton>
          </form>
          <form
            style={actionClusterStyle}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId || !selectedGoalId) return;
              void advanceGoalStatus({ companyId, goalId: selectedGoalId, status: "active" })
                .then((next) => {
                  setResult(next);
                  return refreshAll();
                })
                .catch((error) => setResult({ error: getErrorMessage(error) }));
            }}
          >
            <strong>Ativar meta</strong>
            <select style={inputStyle} value={selectedGoalId} onChange={(event) => setSelectedGoalId(event.target.value)}>
              {(goals.data ?? []).map((goal) => (
                <option key={goal.id} value={goal.id}>{goal.title}</option>
              ))}
            </select>
            <ActionButton type="submit" icon={Play} disabled={!companyId || !selectedGoalId}>Mover para ativa</ActionButton>
          </form>
        </div>
      </Section>

      <Section
        title="Agentes, Ferramentas e Automação"
        eyebrow="Workbench"
        collapsible
        defaultOpen={false}
        description="Coordene agentes, dispare automações controladas e use ferramentas operacionais no mesmo grupo de execução."
        action={companyId ? <Pill label={`${(agents.data ?? []).length} agentes`} /> : undefined}
      >
        <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          <form
            style={actionClusterStyle}
            onSubmit={(event) => {
              event.preventDefault();
              if (!companyId || !selectedAgentId) return;
              void invokeAgent({ companyId, agentId: selectedAgentId, prompt: "Resuma o estado operacional atual." })
                .then((next) => setResult(next))
                .catch((error) => setResult({ error: getErrorMessage(error) }));
            }}
          >
            <strong>Coordenação de agentes</strong>
            <select style={inputStyle} value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
              {(agents.data ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
            <div style={rowStyle}>
              <ActionButton type="submit" variant="primary" icon={Bot} disabled={!companyId || !selectedAgentId}>Invocar</ActionButton>
              <ActionButton
                type="button"
                icon={Pause}
                onClick={() => {
                  if (!companyId || !selectedAgentId) return;
                  void pauseAgent({ companyId, agentId: selectedAgentId })
                    .then((next) => {
                      setResult(next);
                      agents.refresh();
                    })
                    .catch((error) => setResult({ error: getErrorMessage(error) }));
                }}
              >
                Pausar
              </ActionButton>
              <ActionButton
                type="button"
                icon={Play}
                onClick={() => {
                  if (!companyId || !selectedAgentId) return;
                  void resumeAgent({ companyId, agentId: selectedAgentId })
                    .then((next) => {
                      setResult(next);
                      agents.refresh();
                    })
                    .catch((error) => setResult({ error: getErrorMessage(error) }));
                }}
              >
                Retomar
              </ActionButton>
            </div>
            <ActionButton
              type="button"
              icon={MessageSquareText}
              onClick={() => {
                if (!companyId || !selectedAgentId) return;
                void askAgent({ companyId, agentId: selectedAgentId, prompt: "Dê um resumo operacional curto." })
                  .then((next) => setResult(next))
                  .catch((error) => setResult({ error: getErrorMessage(error) }));
              }}
            >
              Abrir stream de chat
            </ActionButton>
            <JsonBlock value={agentStream.events.slice(-8)} />
          </form>

          <div style={actionClusterStyle}>
            <strong>Automação</strong>
            <div style={rowStyle}>
              <ActionButton type="button" icon={RadioTower} onClick={() => void fetchJobsAndTrigger()}>
                Disparar heartbeat
              </ActionButton>
              <ActionButton type="button" icon={Webhook} onClick={() => void sendWebhook()}>
                Enviar webhook
              </ActionButton>
              <ActionButton
                type="button"
                icon={Activity}
                onClick={() => {
                  if (!companyId) return;
                  void startProgressStream({ companyId, steps: 4 })
                    .then((next) => setResult(next))
                    .catch((error) => setResult({ error: getErrorMessage(error) }));
                }}
              >
                Stream de progresso
              </ActionButton>
            </div>
            <JsonBlock value={jobOutput ?? overview.data?.lastJob ?? { note: "Sem job executado ainda." }} />
            <JsonBlock value={webhookOutput ?? overview.data?.lastWebhookIssue ?? overview.data?.lastWebhook ?? { note: "Sem webhook recebido ainda." }} />
            <JsonBlock value={progressStream.events.slice(-6)} />
          </div>

          <div style={actionClusterStyle}>
            <strong>Ferramentas operacionais</strong>
            <input style={inputStyle} value={toolMessage} onChange={(event) => setToolMessage(event.target.value)} />
            <div style={rowStyle}>
              <ActionButton type="button" icon={TerminalSquare} onClick={() => void executeTool(TOOL_NAMES.echo)}>Eco de nota</ActionButton>
              <ActionButton type="button" icon={Building2} onClick={() => void executeTool(TOOL_NAMES.companySummary)}>Resumo da empresa</ActionButton>
              <ActionButton type="button" icon={Plus} onClick={() => void executeTool(TOOL_NAMES.createIssue)}>Criar issue</ActionButton>
            </div>
            <JsonBlock value={toolOutput ?? { note: "Nenhuma ferramenta executada ainda." }} />
          </div>
        </div>
      </Section>

      <Section
        title="Workspace e Diagnósticos"
        eyebrow="Workbench"
        collapsible
        defaultOpen={false}
        description="Selecione workspaces, grave notas de apoio e rode diagnósticos controlados apenas quando houver necessidade explícita."
        action={companyId ? <Pill label={`${(workspaceQuery.data ?? []).length} workspaces`} /> : undefined}
      >
        <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          <div style={actionClusterStyle}>
            <strong>Selecionar projeto e workspace</strong>
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
            style={actionClusterStyle}
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
                .catch((error) => setResult({ error: getErrorMessage(error) }));
            }}
          >
            <strong>Notas operacionais</strong>
            <input style={inputStyle} value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} />
            <textarea style={{ ...inputStyle, minHeight: "88px" }} value={workspaceContent} onChange={(event) => setWorkspaceContent(event.target.value)} />
            <div style={rowStyle}>
              <ActionButton type="submit" icon={FilePenLine} disabled={!companyId || !selectedProjectId}>Gravar arquivo</ActionButton>
              <ActionButton
                type="button"
                icon={FileSearch}
                onClick={() => {
                  if (!companyId || !selectedProjectId) return;
                  void readWorkspaceFile({
                    companyId,
                    projectId: selectedProjectId,
                    workspaceId: workspaceId || undefined,
                    relativePath: workspacePath,
                  })
                    .then((next) => setResult(next))
                    .catch((error) => setResult({ error: getErrorMessage(error) }));
                }}
              >
                Ler arquivo
              </ActionButton>
            </div>
          </form>

          <form
            style={actionClusterStyle}
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
                .catch((error) => setResult({ error: getErrorMessage(error) }));
            }}
          >
            <strong>Diagnósticos controlados</strong>
            <select style={inputStyle} value={commandKey} onChange={(event) => setCommandKey(event.target.value)}>
              {SAFE_COMMANDS.map((command) => (
                <option key={command.key} value={command.key}>{command.label}</option>
              ))}
            </select>
            <ActionButton type="submit" icon={TerminalSquare} disabled={!companyId || !selectedProjectId}>Executar comando</ActionButton>
            <JsonBlock value={overview.data?.lastProcessResult ?? { note: "Nenhum diagnóstico executado ainda." }} />
          </form>
        </div>
      </Section>

      <Section
        title="Resultado Operacional"
        eyebrow="Workbench"
        collapsible
        defaultOpen={false}
        description="Saída consolidada das ações mais recentes para depuração rápida e conferência imediata."
        action={<Pill label={result ? "atualizado" : "aguardando"} />}
      >
        <JsonBlock value={result ?? { note: "Execute uma ação para ver o resultado aqui." }} />
      </Section>
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
        action={<ActionButton type="button" icon={RefreshCw} onClick={() => refreshAll()}>Atualizar</ActionButton>}
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
            <ActionButton type="submit" variant="primary" icon={Plus} disabled={!companyId}>Criar issue</ActionButton>
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
            <ActionButton type="submit" icon={Workflow} disabled={!companyId || !selectedIssueId}>Mover para em revisão</ActionButton>
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
            <ActionButton type="submit" variant="primary" icon={Target} disabled={!companyId}>Criar meta</ActionButton>
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
            <ActionButton type="submit" icon={Play} disabled={!companyId || !selectedGoalId}>Mover para ativa</ActionButton>
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
              <ActionButton type="submit" variant="primary" icon={Save}>Gravar estado</ActionButton>
              <ActionButton
                type="button"
                icon={Trash2}
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
              </ActionButton>
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
            <ActionButton type="submit" variant="primary" icon={Save}>Criar ou atualizar entidade</ActionButton>
            <JsonBlock value={entityQuery.data ?? []} />
          </form>
        </div>
      </Section>

      <Section title="Eventos e Streams">
        <div style={rowStyle}>
          <ActionButton
            type="button"
            variant="primary"
            icon={Sparkles}
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
          </ActionButton>
          <ActionButton
            type="button"
            icon={Activity}
            onClick={() => {
              if (!companyId) return;
              void startProgressStream({ companyId, steps: 5 })
                .then((next) => setResult(next))
                .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
            }}
          >
            Iniciar stream de progresso
          </ActionButton>
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
            <ActionButton type="submit" icon={Network}>Consultar URL</ActionButton>
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
            <ActionButton type="submit" icon={ShieldAlert}>Resolver referência</ActionButton>
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
              <ActionButton
                type="button"
                icon={Gauge}
                onClick={() => {
                  if (!companyId) return;
                  void writeMetric({ companyId, name: metricName, value: Number(metricValue || "1") })
                    .then((next) => setResult(next))
                    .catch((error) => setResult({ error: error instanceof Error ? error.message : String(error) }));
                }}
              >
                Gravar métrica
              </ActionButton>
              <ActionButton type="submit" icon={Sparkles} disabled={!companyId}>Gravar atividade</ActionButton>
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
              <ActionButton type="submit" icon={FilePenLine} disabled={!companyId || !selectedProjectId}>Gravar arquivo de notas</ActionButton>
              <ActionButton
                type="button"
                icon={FileSearch}
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
              </ActionButton>
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
            <ActionButton type="submit" icon={TerminalSquare} disabled={!companyId || !selectedProjectId}>Executar comando</ActionButton>
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
              <ActionButton type="submit" variant="primary" icon={Bot} disabled={!companyId || !selectedAgentId}>Invocar</ActionButton>
              <ActionButton
                type="button"
                icon={Pause}
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
              </ActionButton>
              <ActionButton
                type="button"
                icon={Play}
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
              </ActionButton>
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
            <ActionButton type="submit" icon={MessageSquareText} disabled={!companyId || !selectedAgentId}>Iniciar chat operacional</ActionButton>
            <JsonBlock value={agentStream.events.slice(-12)} />
          </form>
        </div>
      </Section>

      <Section title="Automações, Intake e Ferramentas">
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div style={layoutStack}>
            <strong>Job de Heartbeat</strong>
            <ActionButton type="button" icon={RadioTower} onClick={() => void fetchJobsAndTrigger()}>Disparar heartbeat</ActionButton>
            <JsonBlock value={jobOutput ?? overview.data?.lastJob ?? { note: "Ainda não há saída de job." }} />
          </div>
          <div style={layoutStack}>
            <strong>Webhook de Incidente</strong>
            <ActionButton type="button" icon={Webhook} onClick={() => void sendWebhook()}>Enviar webhook de incidente</ActionButton>
            <JsonBlock value={webhookOutput ?? overview.data?.lastWebhookIssue ?? overview.data?.lastWebhook ?? { note: "Nenhum webhook recebido ainda." }} />
          </div>
          <div style={layoutStack}>
            <strong>Despachante de Ferramentas</strong>
            <input style={inputStyle} value={toolMessage} onChange={(event) => setToolMessage(event.target.value)} />
            <div style={rowStyle}>
              <ActionButton type="button" icon={TerminalSquare} onClick={() => void executeTool(TOOL_NAMES.echo)}>Executar eco de nota</ActionButton>
              <ActionButton type="button" icon={Building2} onClick={() => void executeTool(TOOL_NAMES.companySummary)}>Executar resumo da empresa</ActionButton>
              <ActionButton type="button" icon={Plus} onClick={() => void executeTool(TOOL_NAMES.createIssue)}>Executar criação de issue</ActionButton>
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

function OperationsHero({ context }: { context: PluginPageProps["context"] }) {
  const overview = usePluginOverview(context.companyId);

  return (
    <section style={heroShellStyle}>
      <div style={{ display: "grid", gap: "8px" }}>
        <h1 style={{ margin: 0, fontSize: "30px", lineHeight: 1.05 }}>{PLUGIN_DISPLAY_NAME}</h1>
        <div style={{ ...mutedTextStyle, fontSize: "13px", opacity: 0.82 }}>
          Coordene fila, agentes e sinais em uma única superfície.
        </div>
      </div>

      <div style={heroMetricGridStyle}>
        <HeroMetric
          icon={FolderOpen}
          label="Projetos"
          value={overview.data?.counts.projects ?? 0}
          detail="escopo atual"
        />
        <HeroMetric
          icon={Target}
          label="Issues"
          value={overview.data?.counts.issues ?? 0}
          detail="fila ativa"
        />
        <HeroMetric
          icon={Bot}
          label="Agentes"
          value={overview.data?.counts.agents ?? 0}
          detail="prontos para coordenação"
        />
        <HeroMetric
          icon={Activity}
          label="Sinais"
          value={overview.data?.recentRecords.length ?? 0}
          detail="runtime recente"
        />
      </div>
    </section>
  );
}

function GatherDeskCluster({
  top,
  left,
  accent,
  width,
  monitors = 2,
  lamp = false,
}: {
  top: number;
  left: number;
  accent: string;
  width?: number;
  monitors?: number;
  lamp?: boolean;
}) {
  return (
    <div style={{ position: "absolute", top, left, display: "grid", gap: "6px", justifyItems: "center" }}>
      <div style={{ ...gatherDeskStyle(accent, width) }} />
      <div style={{ position: "absolute", top: 12, left: 16, display: "flex", gap: "8px", alignItems: "center" }}>
        {Array.from({ length: monitors }).map((_, index) => (
          <span key={index} style={gatherMonitorStyle} />
        ))}
        {lamp ? <span style={gatherLampStyle} /> : null}
      </div>
      <div
        style={{
          position: "absolute",
          top: width && width > 130 ? 44 : 42,
          left: "50%",
          width: width && width > 130 ? "64px" : "46px",
          height: "18px",
          transform: "translateX(-50%)",
          borderRadius: "999px",
          background: "#334155",
          opacity: 0.2,
        }}
      />
    </div>
  );
}

function GatherAvatar({
  top,
  left,
  name,
  detail,
  color,
  highlight = false,
}: {
  top: number;
  left: number;
  name: string;
  detail: string;
  color: string;
  highlight?: boolean;
}) {
  return (
    <div style={{ position: "absolute", top, left, display: "grid", justifyItems: "center", gap: "8px" }}>
      <div
        style={{
          padding: "6px 10px",
          borderRadius: "999px",
          border: `2px solid ${highlight ? "#111827" : "color-mix(in srgb, #111827 52%, transparent)"}`,
          background: "rgba(17, 24, 39, 0.88)",
          color: "#f8fafc",
          fontSize: "11px",
          fontWeight: 700,
          lineHeight: 1,
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          whiteSpace: "nowrap",
          boxShadow: "0 10px 24px rgba(15, 23, 42, 0.18)",
        }}
      >
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "999px",
            background: highlight ? "#22c55e" : color,
            boxShadow: `0 0 0 3px color-mix(in srgb, ${highlight ? "#22c55e" : color} 24%, transparent)`,
          }}
        />
        <span>{name}</span>
      </div>
      <div style={{ position: "relative", width: "54px", height: "66px" }}>
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: "0",
            width: "34px",
            height: "10px",
            transform: "translateX(-50%)",
            borderRadius: "999px",
            background: "rgba(15, 23, 42, 0.14)",
            filter: "blur(1px)",
          }}
        />
        <div style={gatherAvatarHeadStyle(color, highlight)} />
        <div style={gatherAvatarBodyStyle(color, highlight)} />
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: "14px",
            transform: "translateX(-50%)",
            padding: "3px 7px",
            borderRadius: "999px",
            background: "rgba(255, 255, 255, 0.88)",
            border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
            color: "#0f172a",
            fontSize: "10px",
            fontWeight: 800,
            lineHeight: 1,
            boxShadow: "0 8px 14px rgba(15, 23, 42, 0.08)",
          }}
        >
          {highlight ? "VO" : getInitials(name)}
        </div>
      </div>
      <div
        style={{
          padding: "4px 8px",
          borderRadius: "999px",
          background: "rgba(255, 255, 255, 0.84)",
          border: "1px solid color-mix(in srgb, var(--border) 76%, transparent)",
          fontSize: "10px",
          fontWeight: 700,
          color: "#334155",
          textAlign: "center",
          boxShadow: "0 8px 16px rgba(15, 23, 42, 0.06)",
          whiteSpace: "nowrap",
        }}
      >
        {detail}
      </div>
    </div>
  );
}

function GatherRoomLabel({
  icon: Icon,
  label,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  tone: string;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 12px",
        borderRadius: "999px",
        background: "rgba(255, 255, 255, 0.9)",
        border: `2px solid ${tone}`,
        fontSize: "12px",
        fontWeight: 700,
        color: "#1f2937",
        boxShadow: "0 8px 18px rgba(15, 23, 42, 0.12)",
      }}
    >
      <Icon size={14} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function OperationsGather({ context }: { context: PluginPageProps["context"] }) {
  const overview = usePluginOverview(context.companyId);
  const agents = usePluginData<AgentRecord[]>("agents", context.companyId ? { companyId: context.companyId } : {});

  const avatarNames = (agents.data ?? []).map((agent) => agent.name);
  const queueCount = overview.data?.counts.issues ?? 0;
  const projectCount = overview.data?.counts.projects ?? 0;
  const agentCount = overview.data?.counts.agents ?? 0;
  const signalCount = overview.data?.recentRecords.length ?? 0;
  const presence = [
    { name: "Você", detail: "corredor central", color: "#60a5fa", top: 366, left: 720, highlight: true },
    { name: avatarNames[0] ?? "Helix", detail: "follow-up", color: "#f97316", top: 304, left: 516 },
    { name: avatarNames[1] ?? "Neuro", detail: "fila crítica", color: "#22c55e", top: 308, left: 416 },
    { name: avatarNames[2] ?? "Orbit 2", detail: "intake", color: "#a855f7", top: 214, left: 188 },
    { name: avatarNames[3] ?? "Orbit", detail: "CX / NOC", color: "#ec4899", top: 454, left: 954 },
  ];
  const overlayPanelStyle: CSSProperties = {
    position: "absolute",
    zIndex: 5,
    padding: "14px",
    borderRadius: "20px",
    border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
    background: "rgba(255, 255, 255, 0.8)",
    backdropFilter: "blur(12px)",
    boxShadow: "0 18px 36px rgba(15, 23, 42, 0.12)",
  };

  return (
    <div style={pageShellStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              width: "42px",
              height: "42px",
              borderRadius: "14px",
              display: "grid",
              placeItems: "center",
              background: "color-mix(in srgb, var(--foreground) 10%, transparent)",
            }}
          >
            <Gamepad2 size={18} aria-hidden="true" />
          </div>
          <strong style={{ fontSize: "20px", lineHeight: 1.1 }}>AGhouse</strong>
        </div>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <GatherHudBadge icon={Users} value={presence.length} label="presenças" tint="color-mix(in srgb, #22c55e 18%, white)" />
          <GatherHudBadge icon={Target} value={queueCount} label="issues" tint="color-mix(in srgb, #f59e0b 18%, white)" />
          <GatherHudBadge icon={Bot} value={agentCount} label="agentes" tint="color-mix(in srgb, #60a5fa 18%, white)" />
        </div>
      </div>

      <section style={gatherMapShellStyle}>
        <div style={{ ...overlayPanelStyle, top: "18px", left: "18px", width: "188px" }}>
          <div style={{ fontSize: "11px", opacity: 0.62, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "10px" }}>
            Pulso
          </div>
          <div style={{ display: "grid", gap: "10px" }}>
            <StatusLine label="Projetos" value={`${projectCount} no escopo`} />
            <StatusLine label="Sinais" value={`${signalCount} recentes`} />
            <StatusLine label="Zonas" value="4 áreas ativas" />
          </div>
        </div>

        <div style={{ ...overlayPanelStyle, top: "18px", right: "18px", width: "216px" }}>
          <div style={{ fontSize: "11px", opacity: 0.62, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "10px" }}>
            Ao vivo
          </div>
          <div style={{ display: "grid", gap: "10px" }}>
            {presence.map((avatar) => (
              <div key={avatar.name} style={{ display: "grid", gridTemplateColumns: "10px minmax(0, 1fr)", alignItems: "center", gap: "10px" }}>
                <span
                  style={{
                    width: "10px",
                    height: "10px",
                    borderRadius: "999px",
                    background: avatar.highlight ? "#22c55e" : avatar.color,
                    boxShadow: `0 0 0 3px color-mix(in srgb, ${avatar.highlight ? "#22c55e" : avatar.color} 24%, transparent)`,
                  }}
                />
                <div style={{ display: "grid", gap: "2px", minWidth: 0 }}>
                  <span style={{ fontSize: "12px", fontWeight: 700, lineHeight: 1.2 }}>{avatar.name}</span>
                  <span style={mutedTextStyle}>{avatar.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={gatherGardenLeftStyle} />
        <div style={gatherGardenRightStyle} />
        <div style={gatherCampusCoreStyle} />
        <div style={gatherHallNorthStyle} />
        <div style={gatherCorridorStyle} />

        <div
          style={{
            ...gatherRoomStyle(
              "#8992be",
              "repeating-linear-gradient(0deg, #cfd6f5 0 12px, #d7def8 12px 24px), repeating-linear-gradient(90deg, #c9d2f2 0 12px, #d8e0fa 12px 24px)",
            ),
            top: "122px",
            left: "102px",
            width: "176px",
            height: "228px",
          }}
        >
          <div style={{ position: "absolute", top: "14px", left: "14px" }}>
            <GatherRoomLabel icon={Users} label="War Room" tone="#8992be" />
          </div>
          <GatherDeskCluster top={72} left={18} accent="#a27d5e" width={132} monitors={1} lamp />
          <div
            style={{
              position: "absolute",
              right: "18px",
              bottom: "22px",
              width: "62px",
              height: "62px",
              borderRadius: "999px",
              border: "3px solid #7c5f4d",
              background: "radial-gradient(circle at 30% 30%, #f8fafc 0 10px, #cbd5e1 10px 22px, #94a3b8 22px 100%)",
            }}
          />
        </div>

        <div
          style={{
            ...gatherRoomStyle(
              "#8d9d97",
              "repeating-linear-gradient(0deg, #d6ddeb 0 14px, #e2e7f3 14px 28px), repeating-linear-gradient(90deg, #d9dfeb 0 14px, #ecf0f8 14px 28px)",
            ),
            left: "98px",
            bottom: "92px",
            width: "194px",
            height: "232px",
          }}
        >
          <div style={{ position: "absolute", top: "14px", left: "14px" }}>
            <GatherRoomLabel icon={FolderOpen} label="Arquivo Vivo" tone="#8d9d97" />
          </div>
          <div
            style={{
              position: "absolute",
              left: "18px",
              right: "18px",
              bottom: "20px",
              display: "grid",
              gap: "10px",
            }}
          >
            <div style={{ height: "92px", borderRadius: "12px", border: "3px solid #64748b", background: "repeating-linear-gradient(90deg, #64748b 0 10px, #93a4ba 10px 18px)" }} />
            <div style={{ display: "flex", gap: "14px" }}>
              <div style={{ ...gatherDeskStyle("#6b7280", 64), height: "56px" }} />
              <div style={{ ...gatherDeskStyle("#6b7280", 64), height: "56px" }} />
            </div>
          </div>
        </div>

        <div
          style={{
            ...gatherRoomStyle(
              "#7a8a95",
              "repeating-linear-gradient(0deg, #dfe6ea 0 12px, #e7edf1 12px 24px), repeating-linear-gradient(90deg, #d7dee3 0 12px, #e7edf1 12px 24px)",
            ),
            top: "206px",
            left: "338px",
            width: "404px",
            height: "236px",
          }}
        >
          <div style={{ position: "absolute", top: "14px", left: "50%", transform: "translateX(-50%)" }}>
            <GatherRoomLabel icon={LayoutDashboard} label="Command Center" tone="#7a8a95" />
          </div>
          <GatherDeskCluster top={76} left={42} accent="#7a8a95" width={150} monitors={2} />
          <GatherDeskCluster top={76} left={210} accent="#7a8a95" width={150} monitors={3} lamp />
          <GatherDeskCluster top={156} left={98} accent="#7a8a95" width={176} monitors={2} />
          <div
            style={{
              position: "absolute",
              right: "26px",
              top: "126px",
              width: "26px",
              height: "46px",
              borderRadius: "14px",
              border: "3px solid #60a5fa",
              background: "linear-gradient(180deg, #bae6fd 0%, #38bdf8 100%)",
            }}
          />
        </div>

        <div
          style={{
            ...gatherRoomStyle(
              "#8f86a8",
              "repeating-linear-gradient(0deg, #cdd0ea 0 12px, #d9d7ef 12px 24px), repeating-linear-gradient(90deg, #cfcfe6 0 12px, #dddaf3 12px 24px)",
            ),
            left: "382px",
            bottom: "96px",
            width: "330px",
            height: "166px",
          }}
        >
          <div style={{ position: "absolute", top: "14px", left: "50%", transform: "translateX(-50%)" }}>
            <GatherRoomLabel icon={Sparkles} label="Lounge de Alinhamento" tone="#8f86a8" />
          </div>
          <div
            style={{
              position: "absolute",
              top: "74px",
              left: "34px",
              width: "118px",
              height: "58px",
              borderRadius: "16px",
              border: "3px solid #a16f46",
              background: "linear-gradient(180deg, #f59e0b 0%, #fdba74 100%)",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: "68px",
              right: "34px",
              width: "104px",
              height: "64px",
              borderRadius: "999px",
              border: "3px solid #a16f46",
              background: "linear-gradient(180deg, #fef3c7 0%, #fde68a 100%)",
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: "20px",
              left: "50%",
              transform: "translateX(-50%)",
              width: "160px",
              height: "16px",
              borderRadius: "999px",
              background: "rgba(51, 65, 85, 0.12)",
            }}
          />
        </div>

        <div
          style={{
            ...gatherRoomStyle(
              "#94a3b8",
              "repeating-linear-gradient(0deg, #e4e9f1 0 14px, #edf1f6 14px 28px), repeating-linear-gradient(90deg, #e0e6ef 0 14px, #eef3f8 14px 28px)",
            ),
            top: "232px",
            right: "132px",
            width: "248px",
            height: "288px",
          }}
        >
          <div style={{ position: "absolute", top: "14px", left: "50%", transform: "translateX(-50%)" }}>
            <GatherRoomLabel icon={Headphones} label="Pod CX / NOC" tone="#94a3b8" />
          </div>
          <GatherDeskCluster top={86} left={24} accent="#7c8aa1" width={186} monitors={2} />
          <GatherDeskCluster top={184} left={30} accent="#7c8aa1" width={174} monitors={2} lamp />
          <div
            style={{
              position: "absolute",
              top: "76px",
              right: "20px",
              width: "24px",
              height: "24px",
              borderRadius: "999px",
              background: "linear-gradient(180deg, #d8b4fe 0%, #c084fc 100%)",
              boxShadow: "0 0 0 3px color-mix(in srgb, #ffffff 44%, transparent)",
            }}
          />
        </div>

        <div
          style={{
            position: "absolute",
            bottom: "62px",
            right: "138px",
            display: "inline-flex",
            alignItems: "center",
            gap: "10px",
            padding: "10px 14px",
            borderRadius: "18px",
            border: "2px solid #7c8aa1",
            background: "rgba(255,255,255,0.9)",
            fontSize: "12px",
            fontWeight: 700,
            color: "#1f2937",
            boxShadow: "0 10px 22px rgba(15, 23, 42, 0.08)",
          }}
        >
          <Compass size={14} aria-hidden="true" />
          <span>Entrada / Navegação</span>
        </div>

        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: "18px",
            zIndex: 5,
            transform: "translateX(-50%)",
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            justifyContent: "center",
            maxWidth: "calc(100% - 84px)",
            padding: "10px 12px",
            borderRadius: "20px",
            border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
            background: "rgba(255, 255, 255, 0.8)",
            backdropFilter: "blur(12px)",
            boxShadow: "0 18px 36px rgba(15, 23, 42, 0.12)",
          }}
        >
          {[
            { icon: LayoutDashboard, label: "Command Center" },
            { icon: Users, label: "War Room" },
            { icon: Headphones, label: "CX / NOC" },
            { icon: FolderOpen, label: "Arquivo" },
            { icon: Sparkles, label: "Lounge" },
          ].map(({ icon: Icon, label }) => (
            <span
              key={label}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 10px",
                borderRadius: "999px",
                border: "1px solid color-mix(in srgb, var(--border) 76%, transparent)",
                background: "rgba(255, 255, 255, 0.92)",
                fontSize: "12px",
                fontWeight: 700,
                whiteSpace: "nowrap",
              }}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{label}</span>
            </span>
          ))}
        </div>

        {presence.map((avatar) => (
          <GatherAvatar
            key={`${avatar.name}-${avatar.top}-${avatar.left}`}
            top={avatar.top}
            left={avatar.left}
            name={avatar.name}
            detail={avatar.detail}
            color={avatar.color}
            highlight={avatar.highlight}
          />
        ))}
      </section>
    </div>
  );
}

export function KitchenSinkPage({ context }: PluginPageProps) {
  const [activeTab, setActiveTab] = useState<OperationsView>(() => readOperationsViewFromLocation());

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const syncFromUrl = () => setActiveTab(readOperationsViewFromLocation());
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  const tabs = [
    {
      id: "overview" as const,
      icon: LayoutDashboard,
      label: "Visão Geral",
      content: (
        <div style={pageShellStyle}>
          <KitchenSinkTopRow context={context} />
          <Section
            title="Radar do Runtime"
            eyebrow="Sinais rápidos"
            collapsible
            description="Indicadores curtos para confirmar saúde do runtime, ações rápidas e cobertura das superfícies operacionais."
          >
            <KitchenSinkPageWidgets context={context} />
          </Section>
          {context.entityId || context.entityType ? (
            <Section
              title="Contexto Atual"
              eyebrow="Superfície ativa"
              collapsible
              defaultOpen={false}
              description="Resumo do contexto ativo no host para evitar perda de orientação ao alternar entre projeto, issue e comentário."
            >
              <CompactSurfaceSummary label="Resumo contextual" />
            </Section>
          ) : null}
        </div>
      ),
    },
    {
      id: "flow" as const,
      icon: Workflow,
      label: "Fluxo Operacional",
      content: <KitchenSinkEmbeddedApp context={context} />,
    },
    {
      id: "aghouse" as const,
      icon: Gamepad2,
      label: "AGhouse",
      content: <OperationsGather context={context} />,
    },
    {
      id: "workbench" as const,
      icon: MonitorCog,
      label: "Workbench Avançado",
      content: <OperationsWorkbench context={context} />,
    },
  ];

  const activeTabConfig = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

  return (
    <div style={pageShellStyle}>
      <OperationsHero context={context} />

      <div style={{ display: "grid", gap: "10px" }}>
        <div style={tabRailStyle}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              style={tabButtonStyle(tab.id === activeTab)}
              onClick={() => {
                setActiveTab(tab.id);
                writeOperationsViewToLocation(tab.id);
              }}
            >
              <ButtonLabel icon={tab.icon}>{tab.label}</ButtonLabel>
            </button>
          ))}
        </div>
      </div>

      {activeTabConfig.content}
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
            A Central de Operações reúne intake, coordenação, automação, notas de workspace e diagnósticos controlados em um único cockpit operacional.
          </div>
          <div style={{ fontSize: "12px", opacity: 0.7 }}>
            Contexto atual da empresa: {context.companyId ?? "nenhum"}
          </div>
        </div>
        <div style={{ display: "grid", gap: "8px" }}>
          <strong>Risco e Modelo de Confiança</strong>
          <div style={{ fontSize: "12px", lineHeight: 1.5 }}>
            O acesso ao workspace e os diagnósticos locais executam como código confiável no host. Mantenha subprocessos desativados quando não houver necessidade explícita de inspeção local.
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gap: "12px" }}>
        <strong>Configurações</strong>
        <ToggleField
          icon={PanelsTopLeft}
          label="Exibir entrada na barra lateral"
          checked={configJson.showSidebarEntry !== false}
          onChange={(checked) => setField("showSidebarEntry", checked)}
        />
        <ToggleField
          icon={LayoutDashboard}
          label="Exibir painel lateral"
          checked={configJson.showSidebarPanel !== false}
          onChange={(checked) => setField("showSidebarPanel", checked)}
        />
        <ToggleField
          icon={FolderOpen}
          label="Exibir atalho lateral do projeto"
          checked={configJson.showProjectSidebarItem !== false}
          onChange={(checked) => setField("showProjectSidebarItem", checked)}
        />
        <ToggleField
          icon={MessageSquareText}
          label="Exibir anotação de comentário"
          checked={configJson.showCommentAnnotation !== false}
          onChange={(checked) => setField("showCommentAnnotation", checked)}
        />
        <ToggleField
          icon={Copy}
          label="Exibir ação contextual de comentário"
          checked={configJson.showCommentContextMenuItem !== false}
          onChange={(checked) => setField("showCommentContextMenuItem", checked)}
        />
        <ToggleField
          icon={FileSearch}
          label="Habilitar acesso ao workspace"
          checked={configJson.enableWorkspaceDemos !== false}
          onChange={(checked) => setField("enableWorkspaceDemos", checked)}
        />
        <ToggleField
          icon={ShieldAlert}
          label="Habilitar diagnósticos locais"
          checked={configJson.enableProcessDemos === true}
          onChange={(checked) => setField("enableProcessDemos", checked)}
        />
        <label style={{ display: "grid", gap: "6px" }}>
          <FieldLabel icon={Network}>URL do endpoint HTTP</FieldLabel>
          <input
            style={inputStyle}
            value={String(configJson.httpDemoUrl ?? DEFAULT_CONFIG.httpDemoUrl)}
            onChange={(event) => setField("httpDemoUrl", event.target.value)}
          />
        </label>
        <label style={{ display: "grid", gap: "6px" }}>
          <FieldLabel icon={ShieldAlert}>Referência de segredo</FieldLabel>
          <input
            style={inputStyle}
            value={String(configJson.secretRefExample ?? "")}
            onChange={(event) => setField("secretRefExample", event.target.value)}
          />
        </label>
        <label style={{ display: "grid", gap: "6px" }}>
          <FieldLabel icon={FilePenLine}>Arquivo de notas do workspace</FieldLabel>
          <input
            style={inputStyle}
            value={String(configJson.workspaceScratchFile ?? DEFAULT_CONFIG.workspaceScratchFile)}
            onChange={(event) => setField("workspaceScratchFile", event.target.value)}
          />
        </label>
      </div>

      {error ? <div style={{ color: "var(--destructive, #c00)", fontSize: "12px" }}>{error}</div> : null}

      <div style={rowStyle}>
        <ActionButton type="submit" variant="primary" icon={Save} disabled={saving}>
          {saving ? "Salvando…" : "Salvar configurações"}
        </ActionButton>
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
        <ActionButton
          type="button"
          icon={Gauge}
          onClick={() => {
            if (!context.companyId) return;
            void writeMetric({ companyId: context.companyId, name: "dashboard_click", value: 1 }).catch(console.error);
          }}
        >
          Registrar métrica
        </ActionButton>
      </div>
    </div>
  );
}

export function KitchenSinkSidebarLink({ context }: PluginSidebarProps) {
  const config = usePluginConfigData();
  if (config.data && config.data.showSidebarEntry === false) return null;
  const href = pluginPagePath(context.companyPrefix);
  const aghouseHref = pluginPagePath(context.companyPrefix, "aghouse");
  const isPluginPage = typeof window !== "undefined" && window.location.pathname === href;
  const activeView = isPluginPage ? readOperationsViewFromLocation() : "overview";
  const isAghouseActive = isPluginPage && activeView === "aghouse";
  return (
    <div className="flex flex-col gap-0.5">
      <a
        href={href}
        aria-current={isPluginPage ? "page" : undefined}
        className={[
          "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
          isPluginPage
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
      <div className="ml-5 border-l border-border/70 pl-2">
        <a
          href={aghouseHref}
          aria-current={isAghouseActive ? "page" : undefined}
          className={[
            "flex items-center gap-2 px-3 py-1.5 text-[12px] font-medium transition-colors",
            isAghouseActive
              ? "bg-accent/70 text-foreground"
              : "text-foreground/65 hover:bg-accent/40 hover:text-foreground",
          ].join(" ")}
        >
          <Gamepad2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">AGhouse</span>
        </a>
      </div>
    </div>
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
  return <CompactSurfaceSummary label="Resumo Operacional do Projeto" entityType="project" />;
}

export function KitchenSinkIssueTab({ context }: PluginDetailTabProps) {
  return <CompactSurfaceSummary label="Resumo Operacional da Issue" entityType="issue" />;
}

export function KitchenSinkTaskDetailView() {
  return <CompactSurfaceSummary label="Resumo Operacional da Task" entityType="issue" />;
}

export function KitchenSinkToolbarButton() {
  const context = useHostContext();
  const startProgress = usePluginAction("start-progress-stream");
  return (
    <ActionButton
      type="button"
      icon={Activity}
      onClick={() => {
        if (!context.companyId) return;
        void startProgress({ companyId: context.companyId, steps: 3 }).catch(console.error);
      }}
    >
      Ação Operacional
    </ActionButton>
  );
}

export function KitchenSinkContextMenuItem() {
  const context = useHostContext();
  const writeActivity = usePluginAction("write-activity");
  return (
    <ActionButton
      type="button"
      icon={Sparkles}
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
    </ActionButton>
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
      <ActionButton
        type="button"
        icon={Copy}
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
      </ActionButton>
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
        Use este modal como atalho operacional rápido quando a ação contextual exigir foco sem trocar de página.
      </div>
      <JsonBlock value={context.renderEnvironment ?? { note: "Nenhum metadado de ambiente de renderização disponível." }} />
    </div>
  );
}
