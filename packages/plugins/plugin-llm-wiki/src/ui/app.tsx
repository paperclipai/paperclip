import {
  AssigneePicker,
  FileTree,
  IssuesList as PluginIssuesList,
  ManagedRoutinesList as PluginManagedRoutinesList,
  MarkdownBlock,
  MarkdownEditor,
  ProjectPicker,
  usePluginAction,
  usePluginData,
  usePluginStream,
  usePluginToast,
  useHostLocation,
  useHostNavigation,
  type FileTreeNode,
  type ManagedRoutinesListItem,
  type PluginPageProps,
  type PluginRouteSidebarProps,
  type PluginSettingsPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { readIngestOperationIssueId, uploadIssueAttachmentFile } from "./issue-attachments.js";

// ---------------------------------------------------------------------------
// Shared design tokens — copied from the UX wireframe shared.css so the plugin
// looks identical inside the host whether or not host theme tokens are
// available at runtime.
// ---------------------------------------------------------------------------

const tokens = {
  border: "var(--border, oklch(0.269 0 0))",
  card: "var(--card, oklch(0.205 0 0))",
  bg: "var(--background, oklch(0.145 0 0))",
  fg: "var(--foreground, oklch(0.985 0 0))",
  muted: "var(--muted-foreground, oklch(0.708 0 0))",
  accent: "var(--accent, oklch(0.269 0 0))",
  primary: "var(--primary, oklch(0.985 0 0))",
  primaryFg: "var(--primary-foreground, oklch(0.205 0 0))",
  destructive: "var(--destructive, oklch(0.637 0.237 25.331))",
  pluginBg: "oklch(0.3 0.06 70)",
  pluginFg: "oklch(0.92 0.08 80)",
  pluginBorder: "oklch(0.55 0.15 70)",
  hiddenOpBg: "oklch(0.27 0.04 280)",
  hiddenOpFg: "oklch(0.85 0.08 280)",
  hiddenOpBorder: "oklch(0.45 0.1 280)",
  callout: { bg: "oklch(0.2 0.04 250)", fg: "oklch(0.85 0.08 250)", border: "oklch(0.4 0.1 250)" },
  statusDone: "oklch(0.65 0.16 145)",
  statusRunning: "oklch(0.7 0.13 200)",
  statusBlocked: "oklch(0.6 0.21 25)",
  statusInProgress: "oklch(0.58 0.18 280)",
  statusTodo: "oklch(0.6 0.17 250)",
  statusPaused: "oklch(0.72 0.15 70)",
};

type Tone = "todo" | "in_progress" | "in_review" | "done" | "blocked" | "running" | "paused" | "failed" | "queued" | "default";

const toneStyles: Record<Tone, CSSProperties> = {
  default: { background: "var(--secondary, oklch(0.269 0 0))", color: tokens.fg, border: `1px solid ${tokens.border}` },
  todo: { background: "oklch(0.27 0.06 250)", color: "oklch(0.85 0.1 250)" },
  in_progress: { background: "oklch(0.27 0.06 280)", color: "oklch(0.85 0.1 280)" },
  in_review: { background: "oklch(0.27 0.07 305)", color: "oklch(0.85 0.1 305)" },
  done: { background: "oklch(0.27 0.06 145)", color: "oklch(0.85 0.1 145)" },
  blocked: { background: "oklch(0.27 0.08 25)", color: "oklch(0.82 0.13 25)" },
  running: { background: "oklch(0.27 0.06 200)", color: "oklch(0.83 0.11 200)" },
  paused: { background: "oklch(0.27 0.07 70)", color: "oklch(0.85 0.1 70)" },
  failed: { background: "oklch(0.27 0.08 25)", color: "oklch(0.82 0.13 25)" },
  queued: { background: "oklch(0.27 0.06 250)", color: "oklch(0.85 0.1 250)" },
};

const fontStack = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const mobileMediaQuery = "(max-width: 767px)";
const PLUGIN_ID = "paperclipai.plugin-llm-wiki";
const WIKI_SIDEBAR_NAV_STATE_KEY = "paperclipWikiSidebarTreePath";
const ROUTE_SIDEBAR_EXPANDED_STORAGE_PREFIX = `${PLUGIN_ID}:route-sidebar-expanded:v2`;
const WIKI_TOC_STICKY_TOP = 88;
const WIKI_SPACE_PREFETCH_LIMIT = 8;
const DEFAULT_ROUTE_SIDEBAR_EXPANDED_PATHS = [
  "wiki",
  "wiki/sources",
  "wiki/projects",
  "wiki/entities",
  "wiki/concepts",
  "wiki/synthesis",
] as const;

// ---------------------------------------------------------------------------
// Shared types coming back from the worker.
// ---------------------------------------------------------------------------

type FolderStatus = {
  configured: boolean;
  path: string | null;
  realPath: string | null;
  access: "read" | "readWrite";
  readable: boolean;
  writable: boolean;
  requiredDirectories: string[];
  requiredFiles: string[];
  missingDirectories: string[];
  missingFiles: string[];
  healthy: boolean;
  problems: { code: string; message: string; path?: string }[];
  checkedAt: string;
};

type ManagedAgent = {
  status: string;
  source?: "managed" | "selected";
  agentId?: string | null;
  resourceKey?: string | null;
  details?: { name?: string; status?: string; adapterType?: string | null; icon?: string | null; urlKey?: string | null } | null;
  defaultDrift?: { entryFile: string; changedFiles: string[] } | null;
};

type ManagedProject = {
  status: string;
  source?: "managed" | "selected";
  projectId?: string | null;
  resourceKey?: string | null;
  details?: { name?: string; status?: string; color?: string | null } | null;
};

type ManagedRoutine = {
  status: string;
  routineId?: string | null;
  resourceKey?: string | null;
  missingRefs?: Array<{ pluginKey?: string; resourceKind: string; resourceKey: string }>;
  defaultDrift?: {
    changedFields: string[];
    defaultTitle?: string | null;
    defaultDescription?: string | null;
  } | null;
  routine?: {
    id?: string;
    title?: string;
    status?: string;
    assigneeAgentId?: string | null;
    projectId?: string | null;
    lastTriggeredAt?: string | null;
    lastEnqueuedAt?: string | null;
    managedByPlugin?: {
      pluginDisplayName?: string;
      resourceKey?: string;
    } | null;
  } | null;
  details?: {
    title?: string;
    status?: string;
    cronExpression?: string | null;
    enabled?: boolean;
    nextRunAt?: string | null;
    lastRunAt?: string | null;
    assigneeAgentId?: string | null;
  } | null;
};

type ManagedSkill = {
  status: string;
  skillId?: string | null;
  resourceKey?: string | null;
  defaultDrift?: { changedFiles: string[] } | null;
  skill?: {
    id?: string;
    name?: string;
    key?: string;
    description?: string | null;
  } | null;
  details?: {
    name?: string;
    key?: string;
    description?: string | null;
  } | null;
};

type OverviewData = {
  status: "ok";
  checkedAt: string;
  wikiId: string;
  folder: FolderStatus;
  managedAgent: ManagedAgent;
  managedProject: ManagedProject;
  managedSkills: ManagedSkill[];
  operationCount: number;
  eventIngestion: EventIngestionSettings;
  capabilities: string[];
  prompts: { query: string; lint: string };
};

type EventIngestionSettings = {
  enabled: boolean;
  sources: {
    issues: boolean;
    comments: boolean;
    documents: boolean;
  };
  wikiId: string;
  maxCharacters: number;
};

type WikiEventIngestionSource = "issues" | "comments" | "documents";

type PaperclipIngestionSourceScope =
  | { kind: "active_projects"; limit: number; statuses?: Array<"in_progress" | "todo" | "done"> }
  | { kind: "selected_projects"; projectIds: string[] }
  | { kind: "root_issues"; issueIds: string[] }
  | { kind: "company_all"; requiresBoardConfirmation: true };

type PaperclipIngestionProfile = {
  version: 1;
  enabled: boolean;
  sourceScopes: PaperclipIngestionSourceScope[];
  sourceKinds: {
    issues: boolean;
    comments: boolean;
    documents: boolean;
    attachments: "off" | "metadata_only";
    workProducts: "off" | "metadata_only";
  };
  cursor: {
    maxWindowCharacters: number;
    maxCharactersPerSource: number;
    minSourceAgeMinutes: number;
    maxWindowsPerRun: number;
    staleAfterHours: number;
  };
  backfill: {
    defaultStartAt?: string | null;
    defaultEndAt?: string | null;
    requireManualQueue: boolean;
  };
};

type PaperclipIngestionProfileData = {
  wikiId: string;
  space: Pick<WikiSpace, "id" | "slug" | "displayName" | "accessScope" | "status">;
  profile: PaperclipIngestionProfile;
  effectiveState: "enabled" | "disabled" | "policy_blocked" | "pending_approval" | "enabled_no_scopes";
  policyBlocks: string[];
  historicalPageCount: number;
  overlapCount: number;
};

type SettingsData = {
  folder: FolderStatus;
  managedAgent: ManagedAgent;
  managedProject: ManagedProject;
  managedRoutine?: ManagedRoutine;
  managedRoutines?: ManagedRoutine[];
  managedSkills?: ManagedSkill[];
  distillationPolicy?: {
    autoApplyAllowed: boolean;
    autoApplyRestriction: string | null;
    deploymentMode: "local_trusted" | "authenticated" | null;
    deploymentExposure: "private" | "public" | null;
  };
  eventIngestion: EventIngestionSettings;
  agentOptions: Array<{ id: string; name: string; status?: string | null; adapterType?: string | null; icon?: string | null; urlKey?: string | null }>;
  projectOptions: Array<{ id: string; name: string; status?: string | null; color?: string | null }>;
  capabilities: string[];
};

type WikiSpace = {
  id: string;
  companyId: string;
  wikiId: string;
  slug: string;
  displayName: string;
  spaceType: string;
  folderMode: string;
  rootFolderKey: string;
  pathPrefix: string | null;
  configuredRootPath: string | null;
  accessScope: string;
  ownerUserId: string | null;
  ownerAgentId: string | null;
  teamKey: string | null;
  settings: Record<string, unknown>;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
};

type WikiSpacesData = {
  spaces: WikiSpace[];
};

type WikiSpaceWithFolderStatus = WikiSpace & {
  relativeRoot: string;
  folder: FolderStatus;
};

const DEFAULT_SPACE_SLUG = "default";

type WikiPageRow = {
  path: string;
  title: string | null;
  pageType: string | null;
  backlinkCount: number;
  sourceCount: number;
  contentHash: string | null;
  updatedAt: string;
};

type WikiSourceRow = {
  rawPath: string;
  title: string | null;
  sourceType: string;
  url: string | null;
  status: string;
  createdAt: string;
};

type PagesData = {
  pages: WikiPageRow[];
  sources: WikiSourceRow[];
};

type PageContentData = {
  wikiId: string;
  path: string;
  contents: string;
  title: string | null;
  pageType: string | null;
  backlinks: string[];
  sourceRefs: Array<Record<string, unknown> | string>;
  updatedAt: string | null;
  hash: string;
};

type WikiOperationRow = {
  id: string;
  operationType: string;
  status: string;
  hiddenIssueId: string | null;
  hiddenIssueIdentifier: string | null;
  hiddenIssueTitle: string | null;
  hiddenIssueStatus: string | null;
  projectId: string | null;
  runIds: unknown[];
  costCents: number;
  warnings: unknown[];
  affectedPages: unknown[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type OperationsData = {
  operations: WikiOperationRow[];
};

type TemplateData = {
  path: string;
  contents: string;
  hash: string | null;
  exists: boolean;
};

type WikiFrontmatterValue = string | string[];

type WikiFrontmatterProperty = {
  key: string;
  value: WikiFrontmatterValue;
};

type ParsedWikiMarkdown = {
  body: string;
  frontmatter: WikiFrontmatterProperty[];
};

type WikiTocHeading = {
  id: string;
  text: string;
  level: number;
};

// ---------------------------------------------------------------------------
// Small presentational primitives.
// ---------------------------------------------------------------------------

function Badge({ children, tone = "default", style }: { children: ReactNode; tone?: Tone; style?: CSSProperties }) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      padding: "2px 8px",
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 500,
      whiteSpace: "nowrap",
      ...toneStyles[tone],
      ...style,
    }}>{children}</span>
  );
}

function HiddenOpBadge() {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      padding: "2px 8px",
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 500,
      background: tokens.hiddenOpBg,
      color: tokens.hiddenOpFg,
      border: `1px solid ${tokens.hiddenOpBorder}`,
    }}>📖 wiki task</span>
  );
}

function StatusIcon({ status }: { status: string }) {
  const map: Record<string, { color: string; filled?: boolean; pulse?: boolean }> = {
    done: { color: tokens.statusDone, filled: true },
    in_progress: { color: tokens.statusInProgress },
    running: { color: tokens.statusRunning, pulse: true },
    queued: { color: tokens.statusTodo },
    todo: { color: tokens.statusTodo },
    blocked: { color: tokens.statusBlocked },
    failed: { color: tokens.statusBlocked },
    paused: { color: tokens.statusPaused },
  };
  const tone = map[status] ?? { color: tokens.muted };
  return (
    <span style={{
      width: 12,
      height: 12,
      flexShrink: 0,
      borderRadius: "50%",
      border: `2px solid ${tone.color}`,
      background: tone.filled ? tone.color : "transparent",
      animation: tone.pulse ? "pcWikiPulse 1.6s infinite" : undefined,
    }} aria-hidden />
  );
}

function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <section style={{
      background: tokens.card,
      border: `1px solid ${tokens.border}`,
      borderRadius: 8,
      overflow: "hidden",
      minWidth: 0,
      ...style,
    }}>{children}</section>
  );
}

function CardHeader({ title, right, badges }: { title: ReactNode; right?: ReactNode; badges?: ReactNode }) {
  return (
    <div style={{
      padding: "12px 16px",
      borderBottom: `1px solid ${tokens.border}`,
      display: "flex",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 12,
      minWidth: 0,
    }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{title}</h3>
      {badges}
      {right ? <div style={{ marginLeft: "auto", minWidth: 0, maxWidth: "100%" }}>{right}</div> : null}
    </div>
  );
}

function CardBody({ children, padding = 16 }: { children: ReactNode; padding?: number | string }) {
  return <div style={{ padding }}>{children}</div>;
}

const unfilledSurfaceStyle: CSSProperties = {
  background: "transparent",
};

function PropRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", padding: "4px 0", fontSize: 13, gap: 12, minWidth: 0 }}>
      <span style={{ color: tokens.muted, fontSize: 12, flexShrink: 0 }}>{label}</span>
      <span style={{ flex: "1 1 160px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "normal", overflowWrap: "anywhere", textAlign: "right" }}>{value}</span>
    </div>
  );
}

function Tiny({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ fontSize: 11, color: tokens.muted, ...style }}>{children}</div>;
}

function Mono({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12, overflowWrap: "anywhere", wordBreak: "break-word", ...style }}>{children}</span>;
}

type ButtonVariant = "primary" | "default" | "ghost" | "destructive";
type ButtonSize = "sm" | "md";

function Button({
  variant = "default",
  size = "md",
  disabled,
  loading,
  onClick,
  children,
  type = "button",
  style,
  title,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  children: ReactNode;
  type?: "button" | "submit";
  style?: CSSProperties;
  title?: string;
}) {
  const palette: Record<ButtonVariant, CSSProperties> = {
    primary: {
      background: tokens.primary,
      color: tokens.primaryFg,
      border: `1px solid transparent`,
    },
    default: {
      background: tokens.card,
      color: tokens.fg,
      border: `1px solid ${tokens.border}`,
    },
    ghost: {
      background: "transparent",
      color: tokens.fg,
      border: `1px solid transparent`,
    },
    destructive: {
      background: "transparent",
      color: "oklch(0.7 0.2 25)",
      border: `1px solid oklch(0.5 0.18 25)`,
    },
  };
  return (
    <button
      type={type}
      title={title}
      disabled={disabled || loading}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: size === "sm" ? "3px 8px" : "6px 12px",
        borderRadius: 6,
        fontSize: size === "sm" ? 11 : 13,
        fontWeight: 500,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled || loading ? 0.5 : 1,
        fontFamily: fontStack,
        minWidth: 0,
        whiteSpace: "nowrap",
        ...palette[variant],
        ...style,
      }}
  >{children}</button>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        background: "oklch(0.2 0 0)",
        border: `1px solid ${tokens.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 13,
        color: tokens.fg,
        width: "100%",
        boxSizing: "border-box",
        minWidth: 0,
        fontFamily: fontStack,
        ...props.style,
      }}
    />
  );
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      style={{
        background: "oklch(0.2 0 0)",
        border: `1px solid ${tokens.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 13,
        color: tokens.fg,
        width: "100%",
        boxSizing: "border-box",
        minWidth: 0,
        minHeight: 96,
        fontFamily: fontStack,
        resize: "vertical",
        ...props.style,
      }}
    />
  );
}

type AutosaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

function AutosaveStatusLabel({ status, error }: { status: AutosaveStatus; error: string | null }) {
  if (status === "saving") return <Tiny>Saving…</Tiny>;
  if (status === "saved") return <Tiny>Saved</Tiny>;
  if (status === "dirty") return <Tiny>Unsaved changes</Tiny>;
  if (status === "error") return <Tiny style={{ color: "oklch(0.7 0.2 25)" }}>{error ?? "Autosave failed"}</Tiny>;
  return <Tiny>Autosave on</Tiny>;
}

function AutosaveMarkdownEditor({
  value,
  placeholder,
  minHeight,
  resetKey,
  onSave,
  onStatusChange,
}: {
  value: string;
  placeholder?: string;
  minHeight?: number;
  resetKey: string;
  onSave: (value: string) => Promise<void>;
  onStatusChange?: (status: AutosaveStatus) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [lastSaved, setLastSaved] = useState(value);
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value);
    setLastSaved(value);
    setStatus("idle");
    setError(null);
    onStatusChange?.("idle");
  }, [onStatusChange, resetKey, value]);

  useEffect(() => {
    if (draft === lastSaved) return;
    setStatus("dirty");
    setError(null);
    onStatusChange?.("dirty");
    const timeout = window.setTimeout(async () => {
      setStatus("saving");
      onStatusChange?.("saving");
      try {
        await onSave(draft);
        setLastSaved(draft);
        setStatus("saved");
        onStatusChange?.("saved");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
        onStatusChange?.("error");
      }
    }, 800);
    return () => window.clearTimeout(timeout);
  }, [draft, lastSaved, onSave, onStatusChange]);

  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <MarkdownEditor
        value={draft}
        onChange={setDraft}
        placeholder={placeholder}
        bordered
        contentClassName="min-h-[260px]"
        className="pc-wiki-markdown-editor"
      />
      <style>{`
        .pc-wiki-markdown-editor .mdxeditor-root-contenteditable {
          min-height: ${minHeight ?? 260}px;
        }
      `}</style>
      <AutosaveStatusLabel status={status} error={error} />
    </div>
  );
}

function Callout({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" | "danger" }) {
  const palette = tone === "danger"
    ? { bg: "oklch(0.22 0.06 25)", fg: "oklch(0.85 0.12 25)", border: "oklch(0.45 0.12 25)" }
    : tone === "warn"
      ? { bg: "oklch(0.22 0.06 70)", fg: "oklch(0.85 0.1 70)", border: "oklch(0.45 0.12 70)" }
      : tokens.callout;
  return (
    <div style={{
      background: palette.bg,
      color: palette.fg,
      border: `1px solid ${palette.border}`,
      borderRadius: 8,
      padding: "12px 14px",
      fontSize: 13,
      lineHeight: 1.55,
    }}>{children}</div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: tokens.border, margin: "16px 0" }} />;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useMediaQuery(query: string): boolean {
  const getSnapshot = () => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  };
  const [matches, setMatches] = useState(getSnapshot);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}

function useIsMobileLayout(): boolean {
  return useMediaQuery(mobileMediaQuery);
}

function useOverview(companyId: string | null) {
  const params = useMemo(() => companyId ? { companyId } : undefined, [companyId]);
  return usePluginData<OverviewData>("overview", params);
}

function useSettings(companyId: string | null) {
  const params = useMemo(() => companyId ? { companyId } : undefined, [companyId]);
  return usePluginData<SettingsData>("settings", params);
}

function usePages(companyId: string | null, opts: { includeRaw?: boolean; spaceSlug?: string | null } = {}) {
  const params = useMemo(() => {
    if (!companyId) return undefined;
    const next: Record<string, unknown> = { companyId, includeRaw: opts.includeRaw ?? true };
    if (opts.spaceSlug && opts.spaceSlug !== DEFAULT_SPACE_SLUG) next.spaceSlug = opts.spaceSlug;
    else if (opts.spaceSlug === DEFAULT_SPACE_SLUG) next.spaceSlug = DEFAULT_SPACE_SLUG;
    return next;
  }, [companyId, opts.includeRaw, opts.spaceSlug]);
  return usePluginData<PagesData>("pages", params);
}

function useSpaces(companyId: string | null) {
  const params = useMemo(() => companyId ? { companyId } : undefined, [companyId]);
  return usePluginData<WikiSpacesData>("spaces", params);
}

function useSpaceFolderStatus(companyId: string | null, spaceSlug: string | null) {
  const params = useMemo(() => {
    if (!companyId || !spaceSlug) return undefined;
    return { companyId, spaceSlug };
  }, [companyId, spaceSlug]);
  return usePluginData<WikiSpaceWithFolderStatus>("space", params);
}

function usePaperclipIngestionProfile(companyId: string | null, spaceSlug: string | null) {
  const params = useMemo(() => {
    if (!companyId || !spaceSlug) return undefined;
    return { companyId, spaceSlug };
  }, [companyId, spaceSlug]);
  return usePluginData<PaperclipIngestionProfileData>("paperclip-ingestion-profile", params);
}

function usePageContent(companyId: string | null, path: string | null, spaceSlug?: string | null) {
  const params = useMemo(() => {
    if (!companyId || !path) return undefined;
    const next: Record<string, unknown> = { companyId, path };
    if (spaceSlug) next.spaceSlug = spaceSlug;
    return next;
  }, [companyId, path, spaceSlug]);
  return usePluginData<PageContentData>("page-content", params);
}

function useOperations(companyId: string | null, filter: { operationType?: string | null; status?: string | null; spaceSlug?: string | null } = {}) {
  const params = useMemo(() => {
    if (!companyId) return undefined;
    return {
      companyId,
      operationType: filter.operationType ?? null,
      status: filter.status ?? null,
      spaceSlug: filter.spaceSlug ?? null,
    };
  }, [companyId, filter.operationType, filter.status, filter.spaceSlug]);
  return usePluginData<OperationsData>("operations", params);
}

function useTemplate(companyId: string | null, path: string) {
  const params = useMemo(() => {
    if (!companyId) return undefined;
    return { companyId, path };
  }, [companyId, path]);
  return usePluginData<TemplateData>("template", params);
}

type DistillationCursor = {
  id: string;
  sourceScope: string;
  scopeKey: string;
  projectId: string | null;
  projectName: string | null;
  projectColor: string | null;
  rootIssueId: string | null;
  rootIssueIdentifier: string | null;
  rootIssueTitle: string | null;
  lastProcessedAt: string | null;
  lastObservedAt: string | null;
  pendingEventCount: number;
  lastSourceHash: string | null;
  lastSuccessfulRunId: string | null;
};

type DistillationRun = {
  id: string;
  cursorId: string | null;
  workItemId: string | null;
  projectId: string | null;
  projectName: string | null;
  rootIssueId: string | null;
  rootIssueIdentifier: string | null;
  sourceWindowStart: string | null;
  sourceWindowEnd: string | null;
  sourceHash: string | null;
  status: string;
  costCents: number;
  retryCount: number;
  warnings: string[];
  metadata: Record<string, unknown>;
  operationIssueId: string | null;
  operationIssueIdentifier: string | null;
  operationIssueTitle: string | null;
  affectedPagePaths: string[];
  createdAt: string;
  updatedAt: string;
};

type DistillationWorkItem = {
  id: string;
  workItemKind: string;
  status: string;
  priority: string;
  projectId: string | null;
  rootIssueId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type DistillationPageBinding = {
  id: string;
  pagePath: string;
  projectId: string | null;
  projectName: string | null;
  rootIssueId: string | null;
  lastAppliedSourceHash: string | null;
  lastDistillationRunId: string | null;
  lastRunStatus: string | null;
  lastRunCompletedAt: string | null;
  lastRunSourceWindowEnd: string | null;
  lastRunSourceHash: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
};

type DistillationOverviewData = {
  cursors: DistillationCursor[];
  runs: DistillationRun[];
  workItems: DistillationWorkItem[];
  pageBindings: DistillationPageBinding[];
  reviewWorkItems: DistillationWorkItem[];
  counts: {
    cursors: number;
    runningRuns: number;
    failedRuns24h: number;
    reviewRequired: number;
  };
};

function useDistillationOverview(companyId: string | null) {
  const params = useMemo(() => (companyId ? { companyId } : undefined), [companyId]);
  return usePluginData<DistillationOverviewData>("distillation-overview", params);
}

type DistillationProvenanceData = {
  binding: DistillationPageBinding | null;
  runs: DistillationRun[];
  snapshot: {
    id: string;
    distillationRunId: string;
    sourceHash: string;
    maxCharacters: number;
    clipped: boolean;
    sourceRefs: Array<Record<string, unknown> | string>;
    metadata: Record<string, unknown>;
    createdAt: string;
  } | null;
  cursor: DistillationCursor | null;
};

function useDistillationProvenance(companyId: string | null, pagePath: string | null) {
  const params = useMemo(() => {
    if (!companyId || !pagePath) return undefined;
    return { companyId, pagePath };
  }, [companyId, pagePath]);
  return usePluginData<DistillationProvenanceData>("distillation-page-provenance", params);
}

function stripYamlInlineComment(value: string): string {
  let quote: "'" | "\"" | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const previous = value[i - 1];
    if ((char === "'" || char === "\"") && previous !== "\\") {
      quote = quote === char ? null : quote ?? char;
    }
    if (char === "#" && quote === null && (i === 0 || /\s/.test(previous ?? ""))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trim();
}

function unquoteYamlScalar(value: string): string {
  const trimmed = stripYamlInlineComment(value).trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseYamlInlineArray(value: string): string[] | null {
  const trimmed = stripYamlInlineComment(value).trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];

  const items: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    const previous = body[i - 1];
    if ((char === "'" || char === "\"") && previous !== "\\") {
      quote = quote === char ? null : quote ?? char;
      current += char;
      continue;
    }
    if (char === "," && quote === null) {
      const item = unquoteYamlScalar(current);
      if (item) items.push(item);
      current = "";
      continue;
    }
    current += char;
  }

  const item = unquoteYamlScalar(current);
  if (item) items.push(item);
  return items;
}

function parseFrontmatterValue(rawValue: string, followingList: string[]): WikiFrontmatterValue {
  const inlineArray = parseYamlInlineArray(rawValue);
  if (inlineArray) return inlineArray;
  if (!rawValue.trim() && followingList.length > 0) return followingList;
  return unquoteYamlScalar(rawValue);
}

function parseWikiFrontmatterBlock(block: string): WikiFrontmatterProperty[] {
  const lines = block.replace(/\r\n/g, "\n").split("\n");
  const properties: WikiFrontmatterProperty[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s+-\s+/.test(line)) continue;

    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2] ?? "";
    const followingList: string[] = [];
    let cursor = i + 1;
    while (cursor < lines.length) {
      const listMatch = lines[cursor]?.match(/^\s+-\s+(.+)$/);
      if (!listMatch) break;
      followingList.push(unquoteYamlScalar(listMatch[1] ?? ""));
      cursor += 1;
    }
    if (!rawValue.trim() && followingList.length > 0) i = cursor - 1;

    const value = parseFrontmatterValue(rawValue, followingList);
    if (Array.isArray(value) ? value.length > 0 : value.length > 0) {
      properties.push({ key, value });
    }
  }

  return properties;
}

function parseWikiMarkdown(contents: string): ParsedWikiMarkdown {
  const normalized = contents.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { body: contents, frontmatter: [] };
  }

  const closingMatch = normalized.slice(4).match(/\n(?:---|\.\.\.)[ \t]*(?:\n|$)/);
  if (!closingMatch || closingMatch.index == null) {
    return { body: contents, frontmatter: [] };
  }

  const frontmatterBlock = normalized.slice(4, closingMatch.index + 4);
  const bodyStart = 4 + closingMatch.index + closingMatch[0].length;
  return {
    body: normalized.slice(bodyStart).replace(/^\n+/, ""),
    frontmatter: parseWikiFrontmatterBlock(frontmatterBlock),
  };
}

function stripMarkdownHeadingSyntax(text: string): string {
  return text
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function slugifyWikiHeading(text: string): string {
  const slug = stripMarkdownHeadingSyntax(text)
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return slug || "section";
}

function extractWikiTocHeadings(markdownBody: string): WikiTocHeading[] {
  const lines = markdownBody.replace(/\r\n/g, "\n").split("\n");
  const headings: WikiTocHeading[] = [];
  const usedIds = new Map<string, number>();
  let fenced = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const match = line.match(/^\s{0,3}(#{2,4})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;

    const text = stripMarkdownHeadingSyntax(match[2] ?? "");
    if (!text) continue;

    const baseId = slugifyWikiHeading(text);
    const count = usedIds.get(baseId) ?? 0;
    usedIds.set(baseId, count + 1);
    headings.push({
      id: count === 0 ? baseId : `${baseId}-${count + 1}`,
      text,
      level: match[1]?.length ?? 2,
    });
  }

  return headings;
}

// ---------------------------------------------------------------------------
// Sidebar entry and settings page.
// ---------------------------------------------------------------------------

// Stroke-2, 16×16 lucide-react icons inlined here because plugin bundles
// cannot import `lucide-react` directly (host-only dep). Path data tracks the
// upstream lucide source 1:1 — keep them in sync if upstream changes.

type LucideIconProps = { size?: number };

function makeLucideIcon(paths: ReactNode) {
  return function LucideIcon({ size = 16 }: LucideIconProps) {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ width: size, height: size, display: "block" }}
      >
        {paths}
      </svg>
    );
  };
}

const BookOpenIcon = makeLucideIcon(
  <>
    <path d="M12 7v14" />
    <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
  </>,
);

const DownloadCloudIcon = makeLucideIcon(
  <>
    <path d="M12 13v8l-4-4" />
    <path d="m12 21 4-4" />
    <path d="M4.393 15.269A7 7 0 1 1 15.71 8.071" />
  </>,
);

const MessageSquareTextIcon = makeLucideIcon(
  <>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="M13 8H7" />
    <path d="M17 12H7" />
  </>,
);

const ListChecksIcon = makeLucideIcon(
  <>
    <path d="m3 17 2 2 4-4" />
    <path d="m3 7 2 2 4-4" />
    <path d="M13 6h8" />
    <path d="M13 12h8" />
    <path d="M13 18h8" />
  </>,
);

const HistoryIcon = makeLucideIcon(
  <>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </>,
);

const SlidersHorizontalIcon = makeLucideIcon(
  <>
    <line x1="21" x2="14" y1="4" y2="4" />
    <line x1="10" x2="3" y1="4" y2="4" />
    <line x1="21" x2="12" y1="12" y2="12" />
    <line x1="8" x2="3" y1="12" y2="12" />
    <line x1="21" x2="16" y1="20" y2="20" />
    <line x1="12" x2="3" y1="20" y2="20" />
    <line x1="14" x2="14" y1="2" y2="6" />
    <line x1="8" x2="8" y1="10" y2="14" />
    <line x1="16" x2="16" y1="18" y2="22" />
  </>,
);

const FolderOpenIcon = makeLucideIcon(
  <>
    <path d="M6 14h.01" />
    <path d="M3 6h5l2 2h11v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </>,
);

const ActivityIcon = makeLucideIcon(
  <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.5.5 0 0 1-.96 0L9.24 3.18a.5.5 0 0 0-.96 0l-2.35 8.36A2 2 0 0 1 4 13H2" />,
);

const InfoIcon = makeLucideIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </>,
);

const SparklesIcon = makeLucideIcon(
  <>
    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
    <path d="M5 3v4" />
    <path d="M19 17v4" />
    <path d="M3 5h4" />
    <path d="M17 19h4" />
  </>,
);

const RefreshIcon = makeLucideIcon(
  <>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </>,
);

const ExternalLinkIcon = makeLucideIcon(
  <>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </>,
);

const ClockIcon = makeLucideIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </>,
);

const AlertTriangleIcon = makeLucideIcon(
  <>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </>,
);

const XIcon = makeLucideIcon(
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
);

const ChevronLeftIcon = makeLucideIcon(<path d="m15 18-6-6 6-6" />);

const ChevronRightIcon = makeLucideIcon(<path d="m9 6 6 6-6 6" />);

const ChevronDownIcon = makeLucideIcon(<path d="m6 9 6 6 6-6" />);

const PlusIcon = makeLucideIcon(
  <>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </>,
);

const PlusCircleIcon = makeLucideIcon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8" />
    <path d="M8 12h8" />
  </>,
);

const FolderIcon = makeLucideIcon(<path d="M3 7h6l2 2h10v10H3z" />);

const MoreHorizontalIcon = makeLucideIcon(
  <>
    <circle cx="6" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="18" cy="12" r="1" />
  </>,
);

const ArchiveIcon = makeLucideIcon(
  <>
    <path d="M3 6h18v4H3z" />
    <path d="M5 10v10h14V10" />
    <path d="M10 14h4" />
  </>,
);

const PencilIcon = makeLucideIcon(
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
  </>,
);

export function SidebarLink({ context }: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  return (
    <a
      {...hostNavigation.linkProps("/wiki")}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="shrink-0">
        <BookOpenIcon />
      </span>
      <span className="flex-1 truncate">Wiki</span>
    </a>
  );
}

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const isMobile = useIsMobileLayout();
  return (
    <main style={{ padding: isMobile ? 16 : 24, maxWidth: isMobile ? "none" : 1040, minWidth: 0, fontFamily: fontStack, color: tokens.fg }}>
      <SettingsBody context={context} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Main wiki page: section shell for Pages / Ask / Ingest / Lint / History /
// Settings. Wiki navigation uses path segments so pages can be deep-linked as
// `/:companyPrefix/wiki/page/path/to/file`. Legacy query-param links are still
// accepted as a compatibility fallback.
// ---------------------------------------------------------------------------

type SectionKey = "browse" | "ingest" | "query" | "lint" | "history" | "settings";

const SECTIONS: ReadonlyArray<{
  key: SectionKey;
  label: string;
  Icon: (props: LucideIconProps) => ReactElement;
  description: string;
}> = [
  { key: "browse", label: "Wiki", Icon: BookOpenIcon, description: "Open wiki pages and raw sources from the sidebar." },
  { key: "query", label: "Ask", Icon: MessageSquareTextIcon, description: "Ask the Wiki Maintainer agent a cited question against the local wiki." },
  { key: "ingest", label: "Add Content", Icon: PlusCircleIcon, description: "Capture a new source into the active space and queue an ingest operation." },
  { key: "lint", label: "Lint", Icon: ListChecksIcon, description: "Run structural checks for orphan pages, missing backlinks, and stale provenance." },
  { key: "history", label: "History", Icon: HistoryIcon, description: "Inspect recent LLM Wiki operation issues." },
  { key: "settings", label: "Settings", Icon: SlidersHorizontalIcon, description: "Folder, agent, project, and routine configuration scoped to this company." },
];

const TOP_TOOL_KEYS: ReadonlySet<SectionKey> = new Set<SectionKey>(["query", "ingest"]);
const BOTTOM_TOOL_KEYS: ReadonlySet<SectionKey> = new Set<SectionKey>(["history", "settings"]);
const TOP_TOOL_SECTIONS = SECTIONS.filter((section) => TOP_TOOL_KEYS.has(section.key));
const BOTTOM_TOOL_SECTIONS = SECTIONS.filter((section) => BOTTOM_TOOL_KEYS.has(section.key));
const SECTION_KEYS: ReadonlySet<SectionKey> = new Set(SECTIONS.map((s) => s.key));
const LEGACY_SECTION_ALIASES: Readonly<Partial<Record<string, SectionKey>>> = {
  operations: "history",
};

function isSectionKey(value: string | null | undefined): value is SectionKey {
  return typeof value === "string" && SECTION_KEYS.has(value as SectionKey);
}

function normalizeSectionKey(value: string | null | undefined): SectionKey | null {
  if (typeof value !== "string") return null;
  return LEGACY_SECTION_ALIASES[value] ?? (isSectionKey(value) ? value : null);
}

function readSectionFromSearch(search: string): SectionKey {
  const params = new URLSearchParams(search);
  const raw = params.get("section");
  return normalizeSectionKey(raw) ?? "browse";
}

function decodeRouteSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function readWikiRouteSegments(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean);
  const wikiIndex = segments.findIndex((segment) => decodeRouteSegment(segment).toLowerCase() === "wiki");
  if (wikiIndex === -1) return [];
  return segments.slice(wikiIndex + 1).map(decodeRouteSegment);
}

// Strip an optional `spaces/<slug>` prefix from the wiki route segments.
// Returns the active space slug (defaults to "default") and the remaining segments
// after that prefix so existing section/page parsing keeps working unchanged.
function readWikiSpaceContext(pathname: string): { spaceSlug: string; rest: string[] } {
  const segments = readWikiRouteSegments(pathname);
  if (segments[0] === "spaces" && typeof segments[1] === "string" && segments[1].length > 0) {
    return { spaceSlug: segments[1], rest: segments.slice(2) };
  }
  return { spaceSlug: DEFAULT_SPACE_SLUG, rest: segments };
}

function readActiveSpaceSlugFromLocation(pathname: string): string {
  return readWikiSpaceContext(pathname).spaceSlug;
}

function readSectionFromLocation(pathname: string, search: string): SectionKey {
  const [firstSegment] = readWikiSpaceContext(pathname).rest;
  if (firstSegment === "page") return "browse";
  return normalizeSectionKey(firstSegment) ?? readSectionFromSearch(search);
}

function readSettingsSectionFromLocation(pathname: string): SettingsSectionKey {
  const [firstSegment, secondSegment] = readWikiSpaceContext(pathname).rest;
  if (firstSegment !== "settings") return "root";
  if (secondSegment === "maintainer" || secondSegment === "project") return "root";
  return SETTINGS_SECTIONS.some((section) => section.key === secondSegment)
    ? secondSegment as SettingsSectionKey
    : "root";
}

function readSettingsSpaceSlugFromLocation(pathname: string): string | null {
  const segs = readWikiSpaceContext(pathname).rest;
  if (segs[0] !== "settings" || segs[1] !== "spaces") return null;
  const slug = segs[2];
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}

function buildSpacePrefix(spaceSlug: string): string {
  return spaceSlug && spaceSlug !== DEFAULT_SPACE_SLUG
    ? `/wiki/spaces/${encodeURIComponent(spaceSlug)}`
    : `/wiki`;
}

function buildSectionHref(section: SectionKey, spaceSlug: string = DEFAULT_SPACE_SLUG): string {
  const prefix = buildSpacePrefix(spaceSlug);
  return section === "browse" ? prefix : `${prefix}/${section}`;
}

function buildSettingsSectionHref(settingsSection: SettingsSectionKey | "spaces", spaceSlug: string = DEFAULT_SPACE_SLUG, slug?: string): string {
  const prefix = buildSpacePrefix(spaceSlug);
  if (settingsSection === "spaces" && slug) {
    return `${prefix}/settings/spaces/${encodeURIComponent(slug)}`;
  }
  if (settingsSection === "root") return `${prefix}/settings`;
  return `${prefix}/settings/${settingsSection}`;
}

function readSelectedTreePathFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get("page")?.trim();
  return raw || null;
}

function readSelectedTreePathFromLocation(pathname: string, search: string): string | null {
  const [firstSegment, ...rest] = readWikiSpaceContext(pathname).rest;
  if (firstSegment === "page") {
    return treePathFromRouteSegments(rest);
  }
  return readSelectedTreePathFromSearch(search);
}

function buildPageHref(treePath: string, spaceSlug: string = DEFAULT_SPACE_SLUG): string {
  const prefix = buildSpacePrefix(spaceSlug);
  const encodedPath = routeSegmentsFromTreePath(treePath).map((segment) => encodeURIComponent(segment)).join("/");
  return encodedPath ? `${prefix}/page/${encodedPath}` : prefix;
}

function wikiSidebarNavigationState(treePath: string): Record<typeof WIKI_SIDEBAR_NAV_STATE_KEY, string> {
  return { [WIKI_SIDEBAR_NAV_STATE_KEY]: treePath };
}

function readSidebarSelectedPathFromNavigationState(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[WIKI_SIDEBAR_NAV_STATE_KEY];
  return typeof value === "string" && value.trim() ? value : null;
}

function routeSidebarExpandedStorageKey(companyId: string | null | undefined): string {
  return `${ROUTE_SIDEBAR_EXPANDED_STORAGE_PREFIX}:${companyId ?? "global"}`;
}

function readRouteSidebarExpandedPaths(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set(DEFAULT_ROUTE_SIDEBAR_EXPANDED_PATHS);

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return new Set(DEFAULT_ROUTE_SIDEBAR_EXPANDED_PATHS);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_ROUTE_SIDEBAR_EXPANDED_PATHS);
    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0));
  } catch {
    return new Set(DEFAULT_ROUTE_SIDEBAR_EXPANDED_PATHS);
  }
}

function writeRouteSidebarExpandedPaths(storageKey: string, paths: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...paths].sort()));
  } catch {
    // Ignore storage failures; the tree still works for the current render.
  }
}

const ROOT_WIKI_LINK_PAGES = new Set(["WIKI.md", "AGENTS.md", "IDEA.md", "index.md", "log.md"]);

function splitWikiLinkTarget(target: string): { path: string; fragment: string | null } | null {
  const trimmed = target.trim();
  if (!trimmed || /^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return null;

  const hashIndex = trimmed.indexOf("#");
  const rawPath = (hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed)
    .trim()
    .replace(/^\/+/, "");
  if (
    !rawPath ||
    rawPath.includes("\\") ||
    rawPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }

  const fragment = hashIndex >= 0 ? trimmed.slice(hashIndex + 1).trim() || null : null;
  return { path: rawPath, fragment };
}

function withMarkdownExtension(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

function normalizeWikiLinkPagePath(target: string): { path: string; fragment: string | null } | null {
  const parsed = splitWikiLinkTarget(target);
  if (!parsed) return null;

  let path = withMarkdownExtension(parsed.path);
  if (!path.startsWith("wiki/") && !path.startsWith("raw/") && !ROOT_WIKI_LINK_PAGES.has(path)) {
    path = `wiki/${path}`;
  }

  return { path, fragment: parsed.fragment };
}

function buildWikiLinkHref(target: string, resolveHref: (to: string) => string): string | null {
  const normalized = normalizeWikiLinkPagePath(target);
  if (!normalized) return null;

  const href = resolveHref(buildPageHref(normalized.path));
  return normalized.fragment ? `${href}#${encodeURIComponent(normalized.fragment)}` : href;
}

function routeSegmentsFromTreePath(treePath: string): string[] {
  return treePath.split("/").filter(Boolean);
}

function treePathFromRouteSegments(segments: string[]): string | null {
  if (segments.length === 0) return null;
  const [firstSegment, ...rest] = segments;
  if (firstSegment === "templates") {
    const templatePath = rest.join("/").trim();
    return templatePath || null;
  }
  const routePath = segments.join("/").trim();
  return routePath || null;
}

function firstSelectableTreePath(data: PagesData | null | undefined): string | null {
  const firstPage = data?.pages.find((p) => p.path !== "wiki/index.md" && p.path !== "index.md") ?? data?.pages[0] ?? null;
  if (firstPage) return firstPage.path;
  const firstSource = data?.sources[0] ?? null;
  if (firstSource) return firstSource.rawPath;
  return TEMPLATE_PATHS[0] ?? null;
}

function contentPathFromTreePath(treePath: string | null): string | null {
  return treePath;
}

function isEditableWikiPagePath(path: string): boolean {
  return path === "WIKI.md"
    || path === "AGENTS.md"
    || path === "IDEA.md"
    || path === "index.md"
    || path === "log.md"
    || path.startsWith("wiki/");
}

export function WikiPage({ context }: PluginPageProps) {
  const { pathname, search } = useHostLocation();
  const isMobile = useIsMobileLayout();
  const section = useMemo(() => readSectionFromLocation(pathname, search), [pathname, search]);
  const settingsSection = useMemo(() => readSettingsSectionFromLocation(pathname), [pathname]);
  const activeSpaceSlug = useMemo(() => readActiveSpaceSlugFromLocation(pathname), [pathname]);
  const settingsSpaceSlug = useMemo(() => readSettingsSpaceSlugFromLocation(pathname), [pathname]);
  const overview = useOverview(context.companyId);
  const [isDragActive, setIsDragActive] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<StagedIngestFile[]>([]);
  const [isIngestModalOpen, setIsIngestModalOpen] = useState(false);

  const resetDragState = useCallback(() => {
    setIsDragActive(false);
  }, []);

  const stageFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const now = Date.now();
    setStagedFiles((current) => [
      ...current,
      ...files.map((file, index) => ({
        id: `${now}-${index}-${file.name}-${file.size}-${file.lastModified}`,
        file,
      })),
    ]);
    setIsIngestModalOpen(true);
  }, []);

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(true);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    resetDragState();
  }, [resetDragState]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    resetDragState();
    stageFiles(Array.from(event.dataTransfer.files ?? []));
  }, [resetDragState, stageFiles]);

  useEffect(() => {
    if (!isDragActive) return;
    const handleWindowDragLeave = (event: DragEvent) => {
      const leftViewport =
        event.clientX <= 0 ||
        event.clientY <= 0 ||
        event.clientX >= window.innerWidth ||
        event.clientY >= window.innerHeight;
      if (leftViewport) resetDragState();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") resetDragState();
    };
    window.addEventListener("dragend", resetDragState);
    window.addEventListener("drop", resetDragState);
    window.addEventListener("blur", resetDragState);
    window.addEventListener("dragleave", handleWindowDragLeave);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("dragend", resetDragState);
      window.removeEventListener("drop", resetDragState);
      window.removeEventListener("blur", resetDragState);
      window.removeEventListener("dragleave", handleWindowDragLeave);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isDragActive, resetDragState]);

  if (!context.companyId) {
    return <main style={{ ...shellStyle, height: isMobile ? "auto" : "100%", minHeight: isMobile ? "auto" : 600 }}>Choose a company to open the LLM Wiki.</main>;
  }

  return (
    <main
      style={{ ...shellStyle, position: "relative", height: isMobile ? "auto" : "100%", minHeight: isMobile ? "auto" : 600 }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <style>{`@keyframes pcWikiPulse { 0%,100% { opacity:1 } 50% { opacity:0.45 } }`}</style>
      <section style={{ flex: 1, minHeight: isMobile ? "auto" : 0, overflow: isMobile ? "visible" : "hidden", display: "flex" }}>
        {overview.error ? (
          <div style={{ padding: 24, flex: 1 }}>
            <Callout tone="danger">LLM Wiki bridge error: {overview.error.message}</Callout>
          </div>
        ) : !overview.data ? (
          <div style={{ padding: 24, flex: 1, color: tokens.muted, fontSize: 13 }}>Loading wiki…</div>
        ) : !overview.data.folder.healthy ? (
          <UnconfiguredFolder context={context} folder={overview.data.folder} refresh={overview.refresh} />
        ) : section === "browse" ? (
          <BrowseTab context={context} />
        ) : section === "ingest" ? (
          <IngestTab context={context} refreshOverview={overview.refresh} />
        ) : section === "query" ? (
          <QueryTab context={context} overview={overview.data} />
        ) : section === "lint" ? (
          <SettingsTab context={context} initialSection="lint" />
        ) : section === "history" ? (
          <HistoryTab context={context} overview={overview.data} />
        ) : (
          <SettingsTab context={context} initialSection={settingsSection} />
        )}
      </section>
      {isDragActive ? <WikiPageDropOverlay onClose={resetDragState} /> : null}
      {isIngestModalOpen ? (
        <IngestFilesModal
          companyId={context.companyId}
          files={stagedFiles}
          initialSpaceSlug={activeSpaceSlug}
          onAddFiles={stageFiles}
          onRemoveFile={(id) => setStagedFiles((current) => current.filter((item) => item.id !== id))}
          onClose={() => {
            setIsIngestModalOpen(false);
            setStagedFiles([]);
          }}
          onIngested={() => {
            overview.refresh();
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("pc-wiki-ingest-queued"));
            }
          }}
        />
      ) : null}
    </main>
  );
}

type StagedIngestFile = {
  id: string;
  file: File;
};

function isFileDrag(event: React.DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function WikiPageDropOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      data-testid="llm-wiki-page-drop-overlay"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        pointerEvents: "auto",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "color-mix(in oklab, var(--background, oklch(0.145 0 0)) 72%, transparent)",
        backdropFilter: "blur(3px)",
      }}
    >
      <button
        type="button"
        aria-label="Close ingest drop overlay"
        title="Close"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          width: 34,
          height: 34,
          borderRadius: 8,
          border: `1px solid ${tokens.border}`,
          background: "color-mix(in oklab, var(--card, oklch(0.205 0 0)) 90%, transparent)",
          color: tokens.fg,
          display: "inline-grid",
          placeItems: "center",
          cursor: "pointer",
          boxShadow: "0 10px 30px rgba(0,0,0,0.28)",
        }}
      >
        <XIcon size={16} />
      </button>
      <div style={{
        width: "min(520px, 100%)",
        borderRadius: 8,
        border: `1.5px dashed ${tokens.pluginBorder}`,
        background: "color-mix(in oklab, var(--card, oklch(0.205 0 0)) 92%, transparent)",
        color: tokens.fg,
        padding: "28px 24px",
        textAlign: "center",
        boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
      }}>
        <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, borderRadius: 8, background: tokens.pluginBg, color: tokens.pluginFg, marginBottom: 12 }}>
          <DownloadCloudIcon size={24} />
        </div>
        <div style={{ fontSize: 18, fontWeight: 650, marginBottom: 6 }}>Drop to ingest into LLM Wiki</div>
        <Tiny>Files will be staged for review before the wiki maintainer queues ingest operations.</Tiny>
      </div>
    </div>
  );
}

function IngestFilesModal({
  companyId,
  files,
  onAddFiles,
  onRemoveFile,
  onClose,
  onIngested,
  initialSpaceSlug,
}: {
  companyId: string;
  files: StagedIngestFile[];
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (id: string) => void;
  onClose: () => void;
  onIngested: () => void;
  initialSpaceSlug: string;
}) {
  const ingest = usePluginAction("ingest-source");
  const toast = usePluginToast();
  const spacesQuery = useSpaces(companyId);
  const spaces = useMemo(() => {
    const list = spacesQuery.data?.spaces ?? [];
    return [...list].sort(compareSpaces);
  }, [spacesQuery.data]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [targetSpaceSlug, setTargetSpaceSlug] = useState(initialSpaceSlug || DEFAULT_SPACE_SLUG);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const targetSpace = useMemo(() => spaces.find((s) => s.slug === targetSpaceSlug) ?? null, [spaces, targetSpaceSlug]);

  const requestClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  async function confirm() {
    if (busy || files.length === 0) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      for (const item of files) {
        const contents = await item.file.text();
        const result = await ingest({
          companyId,
          spaceSlug: targetSpaceSlug,
          sourceType: "file",
          title: item.file.name,
          url: null,
          contents,
          metadata: {
            fileName: item.file.name,
            fileSize: item.file.size,
            fileType: item.file.type || null,
            lastModified: item.file.lastModified,
          },
        });
        await uploadIssueAttachmentFile({
          companyId,
          issueId: readIngestOperationIssueId(result),
          file: item.file,
        });
      }
      const count = files.length;
      const spaceLabel = targetSpace?.displayName ?? targetSpaceSlug;
      toast({ tone: "success", title: `Files queued for ingest into ${spaceLabel}`, body: `${count} ${count === 1 ? "file" : "files"} captured into raw sources and attached to ingest tasks.` });
      onIngested();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMsg(message);
      toast({ tone: "error", title: "File ingest failed", body: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="llm-wiki-ingest-modal-title"
      data-testid="llm-wiki-ingest-modal"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) requestClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1010,
        display: "grid",
        placeItems: "center",
        padding: 18,
        background: "rgba(0,0,0,0.52)",
      }}
    >
      <div style={{
        width: "min(680px, 100%)",
        maxHeight: "min(720px, calc(100vh - 36px))",
        overflow: "auto",
        background: tokens.card,
        color: tokens.fg,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
      }}>
        <div style={{ padding: "16px 18px", borderBottom: `1px solid ${tokens.border}`, display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: tokens.pluginBg, color: tokens.pluginFg, display: "grid", placeItems: "center", flexShrink: 0 }}>
            <DownloadCloudIcon size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="llm-wiki-ingest-modal-title" style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Ingest files into {targetSpace?.displayName ?? targetSpaceSlug}</h2>
            <Tiny style={{ marginTop: 4 }}>
              Review the staged files, switch the destination space if needed, then queue them as LLM
              Wiki ingest operations. This is manual file ingest - Paperclip-derived distillation always
              routes to the default space regardless of the destination picked here.
            </Tiny>
          </div>
          <Button size="sm" variant="ghost" onClick={requestClose} disabled={busy} title="Close ingest modal">Close</Button>
        </div>
        <div style={{ padding: 18, display: "grid", gap: 14 }}>
          <SpacePicker
            spaces={spaces}
            activeSpaceSlug={targetSpaceSlug}
            loading={spacesQuery.loading}
            error={spacesQuery.error?.message ?? null}
            isOpen={pickerOpen}
            onToggle={() => setPickerOpen((v) => !v)}
            onClose={() => setPickerOpen(false)}
            onSelect={(slug) => {
              setPickerOpen(false);
              setTargetSpaceSlug(slug);
            }}
            onCreate={() => {
              setPickerOpen(false);
              setCreateOpen(true);
            }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Badge tone="running">{files.length} staged</Badge>
            <Button size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>Add files</Button>
            <input
              ref={inputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(event) => {
                onAddFiles(Array.from(event.currentTarget.files ?? []));
                event.currentTarget.value = "";
              }}
            />
          </div>
          <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 8, overflow: "hidden" }}>
            {files.length === 0 ? (
              <div style={{ padding: 16 }}><Tiny>No files staged.</Tiny></div>
            ) : files.map((item) => (
              <div key={item.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 12px", borderBottom: `1px solid ${tokens.border}`, minWidth: 0 }}>
                <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <strong style={{ display: "block", fontSize: 13, overflowWrap: "anywhere" }}>{item.file.name}</strong>
                  <Tiny>{formatFileSize(item.file.size)}{item.file.type ? ` · ${item.file.type}` : ""}</Tiny>
                </div>
                <Button size="sm" variant="ghost" onClick={() => onRemoveFile(item.id)} disabled={busy}>Remove</Button>
              </div>
            ))}
          </div>
          {errorMsg ? <Callout tone="danger">{errorMsg}</Callout> : null}
          <Callout>
            Confirming captures each file into <Mono>{targetSpaceSlug}/raw/</Mono>, attaches the original file to the ingest task, and initiates a task for the Wiki Maintainer to process.
          </Callout>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button variant="ghost" onClick={requestClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={confirm} disabled={files.length === 0} loading={busy}>Capture & ingest into {targetSpace?.displayName ?? targetSpaceSlug}</Button>
          </div>
        </div>
      </div>
      {createOpen ? (
        <CreateSpaceModal
          companyId={companyId}
          existingSlugs={new Set(spaces.map((s) => s.slug))}
          onClose={() => setCreateOpen(false)}
          onCreated={(space) => {
            setCreateOpen(false);
            spacesQuery.refresh();
            setTargetSpaceSlug(space.slug);
          }}
        />
      ) : null}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

// ---------------------------------------------------------------------------
// Wiki route sidebar — replaces the company sidebar while the user is on a
// `/wiki` route. Mirrors the shell of the host's CompanySettingsSidebar so
// users see a familiar takeover.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Create-space modal — opened from the sidebar `+` icon and also reachable
// from the edit-space settings sub-nav. Disables the "Cloud" type and the
// "Existing absolute path" folder source per the PAP-3640 security review.
// ---------------------------------------------------------------------------

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function CreateSpaceModal({
  companyId,
  existingSlugs,
  onClose,
  onCreated,
}: {
  companyId: string;
  existingSlugs: ReadonlySet<string>;
  onClose: () => void;
  onCreated: (space: WikiSpace) => void;
}) {
  const create = usePluginAction("create-space");
  const toast = usePluginToast();
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);
  const [folderMode, setFolderMode] = useState<"managed_subfolder" | "existing_local_folder">("managed_subfolder");
  const [accessScope, setAccessScope] = useState<"shared" | "personal" | "team">("shared");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const isMobile = useIsMobileLayout();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [busy, onClose]);

  const effectiveSlug = slug.trim() || (slugDirty ? "" : slugify(displayName));

  const slugError = (() => {
    if (!effectiveSlug) return null;
    if (effectiveSlug === DEFAULT_SPACE_SLUG) return "Slug 'default' is reserved.";
    if (!SLUG_PATTERN.test(effectiveSlug)) return "Use 2-40 chars: lowercase letters, numbers, hyphens.";
    if (existingSlugs.has(effectiveSlug)) return "A space with this slug already exists.";
    return null;
  })();

  const canSubmit = displayName.trim().length > 0 && effectiveSlug.length > 0 && !slugError && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const result = await create({
        companyId,
        slug: effectiveSlug,
        displayName: displayName.trim(),
        folderMode,
        accessScope,
      }) as { status: "created"; space: WikiSpace };
      toast({ tone: "success", title: "Space created", body: `${result.space.displayName} is ready for ingest.` });
      onCreated(result.space);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      toast({ tone: "error", title: "Could not create space", body: msg });
    } finally {
      setBusy(false);
    }
  }

  const previewName = displayName.trim() || "your-space";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-space-modal-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "grid",
        placeItems: isMobile ? "end" : "center",
        padding: isMobile ? 0 : 18,
        background: "rgba(0,0,0,0.52)",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        style={{
          width: isMobile ? "100%" : "min(560px, 100%)",
          maxHeight: isMobile ? "92vh" : "min(760px, calc(100vh - 36px))",
          overflow: "auto",
          background: tokens.card,
          color: tokens.fg,
          border: `1px solid ${tokens.border}`,
          borderRadius: isMobile ? "12px 12px 0 0" : 8,
          boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
          fontFamily: fontStack,
        }}
      >
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${tokens.border}`, display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: tokens.pluginBg, color: tokens.pluginFg, display: "grid", placeItems: "center", flexShrink: 0 }}>
            <FolderIcon size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="create-space-modal-title" style={{ margin: 0, fontSize: 17, fontWeight: 650 }}>Create a shared space</h2>
            <Tiny style={{ marginTop: 4 }}>
              Spaces partition wiki pages, sources, and manual ingest into separate slug-prefixed folders
              under the wiki root. Paperclip distillation and event capture always write into the
              default space and skip new spaces created here - per-space Paperclip routing is a later
              phase.
            </Tiny>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy} title="Close">Close</Button>
        </div>
        <div style={{ padding: 20, display: "grid", gap: 16 }}>
          <FormField label="Display name">
            <TextInput
              value={displayName}
              autoFocus
              onChange={(event) => {
                setDisplayName(event.target.value);
                if (!slugDirty) setSlug("");
              }}
              placeholder="Team research"
              maxLength={120}
            />
          </FormField>
          <FormField
            label="Slug"
            help={slugError ?? `Stored as the URL segment and the on-disk folder. Defaults to ${slugify(displayName) || "auto-derived from display name"}.`}
            tone={slugError ? "danger" : "muted"}
          >
            <TextInput
              value={slug || (slugDirty ? "" : slugify(displayName))}
              onChange={(event) => {
                setSlugDirty(true);
                setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
              }}
              placeholder="team-research"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
            />
          </FormField>
          <FormField label="Type">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <SegmentedOption selected label="Folder" onClick={() => undefined} />
              <SegmentedOption disabled label="Cloud" suffix="Coming soon" onClick={() => undefined} />
            </div>
          </FormField>
          <FormField label="Folder source" help="New managed folders create a slug-scoped subfolder under your wiki root. Existing folders must already live under the same wiki root.">
            <div style={{ display: "grid", gap: 8 }}>
              <FolderModeRow
                checked={folderMode === "managed_subfolder"}
                onSelect={() => setFolderMode("managed_subfolder")}
                label="New managed folder"
                help={`Creates spaces/${previewName.replace(/\s+/g, "-").toLowerCase()}/ under the configured wiki root with the standard skeleton.`}
              />
              <FolderModeRow
                checked={folderMode === "existing_local_folder"}
                onSelect={() => setFolderMode("existing_local_folder")}
                label="Existing folder under wiki root"
                help="Re-use a sub-folder you've already created inside the wiki root. The folder path is stored in the space settings."
              />
              <FolderModeRow
                disabled
                checked={false}
                onSelect={() => undefined}
                label="Existing absolute path"
                help="Pending host capability — security review (PAP-3640) gates this until host-managed dynamic local-folder bindings ship."
                suffix="Disabled"
              />
            </div>
          </FormField>
          <FormField label="Access scope" help="Access scope is metadata only. It does not currently enforce who can read or write the space, and it does not change which Paperclip sources reach the space.">
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 8 }}>
              <ScopeTile
                selected={accessScope === "shared"}
                onSelect={() => setAccessScope("shared")}
                label="Shared"
                help="Visible to everyone in this company."
              />
              <ScopeTile
                selected={accessScope === "personal"}
                onSelect={() => setAccessScope("personal")}
                label="Personal"
                help="Future scope — stored only."
                tag="Future"
              />
              <ScopeTile
                selected={accessScope === "team"}
                onSelect={() => setAccessScope("team")}
                label="Team"
                help="Future scope — stored only."
                tag="Future"
              />
            </div>
          </FormField>
          {errorMsg ? <Callout tone="danger">{errorMsg}</Callout> : null}
        </div>
        <div style={{
          padding: "12px 20px",
          borderTop: `1px solid ${tokens.border}`,
          display: "flex",
          gap: 8,
          justifyContent: isMobile ? "stretch" : "flex-end",
          flexWrap: "wrap",
          position: isMobile ? "sticky" : "static",
          bottom: 0,
          background: tokens.card,
        }}>
          <Button variant="ghost" onClick={onClose} disabled={busy} style={{ flex: isMobile ? 1 : undefined }}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={busy} style={{ flex: isMobile ? 1 : undefined }}>Create space</Button>
        </div>
      </div>
    </div>
  );
}

function FormField({ label, help, tone = "muted", children }: { label: ReactNode; help?: ReactNode; tone?: "muted" | "danger"; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: tokens.fg }}>{label}</label>
      {children}
      {help ? (
        <span style={{ fontSize: 11, color: tone === "danger" ? "oklch(0.78 0.18 25)" : tokens.muted, lineHeight: 1.4 }}>{help}</span>
      ) : null}
    </div>
  );
}

function SegmentedOption({ label, selected, disabled, suffix, onClick }: { label: string; selected?: boolean; disabled?: boolean; suffix?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-pressed={selected}
      aria-disabled={disabled}
      style={{
        padding: "8px 14px",
        borderRadius: 6,
        border: `1px solid ${selected ? tokens.border : tokens.border}`,
        background: selected ? tokens.accent : "transparent",
        color: disabled ? tokens.muted : tokens.fg,
        fontSize: 13,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: fontStack,
      }}
    >
      <span>{label}</span>
      {suffix ? (
        <span style={{
          fontSize: 10,
          fontWeight: 500,
          padding: "1px 6px",
          borderRadius: 3,
          border: `1px dashed ${tokens.border}`,
          color: tokens.muted,
        }}>{suffix}</span>
      ) : null}
    </button>
  );
}

function FolderModeRow({ checked, onSelect, label, help, disabled, suffix }: { checked: boolean; onSelect: () => void; label: string; help: string; disabled?: boolean; suffix?: string }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onSelect}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 8,
        border: `1px solid ${checked ? tokens.fg : tokens.border}`,
        background: "transparent",
        color: tokens.fg,
        textAlign: "left",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        fontFamily: fontStack,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          border: `2px solid ${checked ? tokens.fg : tokens.muted}`,
          flexShrink: 0,
          marginTop: 2,
          background: checked ? tokens.fg : "transparent",
        }}
      />
      <div style={{ display: "grid", gap: 2, flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
          {suffix ? <Badge tone="default" style={{ fontSize: 10 }}>{suffix}</Badge> : null}
        </div>
        <span style={{ fontSize: 11, color: tokens.muted, lineHeight: 1.4 }}>{help}</span>
      </div>
    </button>
  );
}

function ScopeTile({ selected, onSelect, label, help, tag }: { selected: boolean; onSelect: () => void; label: string; help: string; tag?: string }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        border: `1px solid ${selected ? tokens.fg : tokens.border}`,
        background: selected ? tokens.accent : "transparent",
        color: tokens.fg,
        textAlign: "left",
        display: "grid",
        gap: 4,
        cursor: "pointer",
        fontFamily: fontStack,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
        {tag ? <Badge tone="default" style={{ fontSize: 10 }}>{tag}</Badge> : null}
      </div>
      <span style={{ fontSize: 11, color: tokens.muted, lineHeight: 1.4 }}>{help}</span>
    </button>
  );
}

function compareSpaces(a: WikiSpace, b: WikiSpace): number {
  if (a.slug === DEFAULT_SPACE_SLUG && b.slug !== DEFAULT_SPACE_SLUG) return -1;
  if (b.slug === DEFAULT_SPACE_SLUG && a.slug !== DEFAULT_SPACE_SLUG) return 1;
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
}

function activeWikiSpaces(spaces: WikiSpace[]): WikiSpace[] {
  return spaces.filter((space) => space.status !== "archived");
}

function spaceTreeKey(spaceSlug: string, path: string): string {
  return `${spaceSlug}::${path}`;
}

function SpacePageContentWarmup({ companyId, path, spaceSlug }: { companyId: string | null; path: string; spaceSlug: string }) {
  usePageContent(companyId, path, spaceSlug);
  return null;
}

function SpacePagesWarmup({ companyId, spaceSlug }: { companyId: string | null; spaceSlug: string }) {
  const pages = usePages(companyId, { includeRaw: true, spaceSlug });
  const selectedTreePath = firstSelectableTreePath(pages.data);
  const selected = contentPathFromTreePath(selectedTreePath);
  return selected ? <SpacePageContentWarmup companyId={companyId} path={selected} spaceSlug={spaceSlug} /> : null;
}

export function WikiRouteSidebar({ context }: PluginRouteSidebarProps) {
  const hostNavigation = useHostNavigation();
  const { pathname, search, state } = useHostLocation();
  const activeSection = useMemo(() => readSectionFromLocation(pathname, search), [pathname, search]);
  const activeSpaceSlug = useMemo(() => readActiveSpaceSlugFromLocation(pathname), [pathname]);
  const companyName = context.companyPrefix ?? "Company";
  const spacesQuery = useSpaces(context.companyId);
  const spaces = useMemo(() => {
    const list = spacesQuery.data?.spaces ?? [];
    if (list.length === 0) return list;
    return activeWikiSpaces(list).sort(compareSpaces);
  }, [spacesQuery.data]);
  const pages = usePages(context.companyId, { includeRaw: true, spaceSlug: activeSpaceSlug });
  const activeSpaceNodes = useMemo(
    () => buildBrowseTree(pages.data?.pages ?? [], pages.data?.sources ?? []),
    [pages.data],
  );
  const warmupSpaces = useMemo(() => {
    const active = spaces.find((space) => space.slug === activeSpaceSlug);
    const rest = spaces.filter((space) => space.slug !== activeSpaceSlug);
    return (active ? [active, ...rest] : rest).slice(0, WIKI_SPACE_PREFETCH_LIMIT);
  }, [spaces, activeSpaceSlug]);
  const storageKey = useMemo(() => routeSidebarExpandedStorageKey(context.companyId), [context.companyId]);
  const [expandedRaw, setExpandedRaw] = useState<Set<string>>(() => readRouteSidebarExpandedPaths(storageKey));
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);
  const [spaceCollapse, setSpaceCollapse] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);

  useEffect(() => {
    if (activeSection !== "browse") return;
    const sidebarSelectedPath = readSidebarSelectedPathFromNavigationState(state);
    if (sidebarSelectedPath === null) return;
    setSelectedTreePath(sidebarSelectedPath);
  }, [activeSection, state]);

  useEffect(() => {
    setExpandedRaw(readRouteSidebarExpandedPaths(storageKey));
  }, [storageKey]);

  useEffect(() => {
    writeRouteSidebarExpandedPaths(storageKey, expandedRaw);
  }, [expandedRaw, storageKey]);

  useEffect(() => {
    const ancestors = expandedAncestors(selectedTreePath);
    if (ancestors.length === 0) return;
    const slug = activeSpaceSlug;
    setExpandedRaw((current) => {
      const next = new Set(current);
      let changed = false;
      for (const ancestor of ancestors) {
        const key = spaceTreeKey(slug, ancestor);
        if (next.has(key)) continue;
        next.add(key);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [selectedTreePath, activeSpaceSlug]);

  // Project the per-space-prefixed expanded paths down to the active space's
  // bare paths so FileTree (which is space-agnostic) can read them directly.
  // Legacy entries written before this change have no `slug::` prefix and are
  // treated as belonging to the default space.
  const expandedForActiveSpace = useMemo(() => {
    const next = new Set<string>();
    const prefix = `${activeSpaceSlug}::`;
    for (const entry of expandedRaw) {
      if (entry.startsWith(prefix)) {
        next.add(entry.slice(prefix.length));
      } else if (!entry.includes("::") && activeSpaceSlug === DEFAULT_SPACE_SLUG) {
        next.add(entry);
      }
    }
    return next;
  }, [expandedRaw, activeSpaceSlug]);

  const handleToggleDir = (dirPath: string) => {
    const key = spaceTreeKey(activeSpaceSlug, dirPath);
    setExpandedRaw((current) => {
      const next = new Set(current);
      // For the default space, legacy un-prefixed entries also need to be
      // removed so that the projection (which falls through legacy keys to
      // default) does not leave a "ghost" expansion after a collapse click.
      if (next.has(key)) {
        next.delete(key);
        if (activeSpaceSlug === DEFAULT_SPACE_SLUG) next.delete(dirPath);
      } else if (activeSpaceSlug === DEFAULT_SPACE_SLUG && next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleSpaceCollapse = (slug: string) => {
    setSpaceCollapse((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const renderToolLink = ({ key, label, Icon }: (typeof SECTIONS)[number]) => {
    const isLegacyLintSettingsActive = key === "settings" && activeSection === "lint";
    const isActive = key === activeSection || isLegacyLintSettingsActive;
    return (
      <a
        key={key}
        {...hostNavigation.linkProps(buildSectionHref(key, activeSpaceSlug))}
        aria-current={isActive ? "page" : undefined}
        className={[
          "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors",
          isActive && !isLegacyLintSettingsActive
            ? "bg-accent text-foreground"
            : isActive
              ? "text-foreground"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
        ].join(" ")}
        style={{ textDecoration: "none" }}
      >
        <span aria-hidden="true" className="shrink-0">
          <Icon />
        </span>
        <span className="flex-1 truncate">{label}</span>
      </a>
    );
  };

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      {warmupSpaces.map((space) => (
        <SpacePagesWarmup key={space.slug} companyId={context.companyId} spaceSlug={space.slug} />
      ))}
      <div className="flex flex-col gap-1 px-3 py-3 shrink-0">
        <a
          {...hostNavigation.linkProps("/dashboard")}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          style={{ textDecoration: "none" }}
        >
          <span aria-hidden="true" className="shrink-0">
            <ChevronLeftIcon size={14} />
          </span>
          <span className="truncate">{companyName}</span>
        </a>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto border-t border-border px-3 py-3">
        <nav aria-label="Wiki primary" className="mb-3">
          <div className="flex flex-col gap-0.5">
            {TOP_TOOL_SECTIONS.map(renderToolLink)}
          </div>
        </nav>
        <div className="mb-1 flex items-center gap-1 px-2 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground" style={{ height: 24 }}>
          <span
            className="flex-1 truncate"
            title="Destination spaces. Browsing and manual ingest happen in the active space; Paperclip distillation always writes into the default space in Phase 1."
          >
            Shared Spaces
          </span>
          <button
            type="button"
            aria-label="Create space"
            title="Create space"
            onClick={() => setCreateOpen(true)}
            style={{
              width: 22,
              height: 22,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              background: "transparent",
              color: tokens.muted,
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            <PlusIcon size={14} />
          </button>
        </div>
        {spacesQuery.error ? (
          <div style={{ padding: "6px 8px", fontSize: 11, color: tokens.statusBlocked }}>
            Failed to load spaces: {spacesQuery.error.message}
          </div>
        ) : null}
        {spaces.length === 0 && spacesQuery.loading ? (
          <Tiny style={{ padding: "6px 8px" }}>Loading spaces…</Tiny>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {spaces.map((space) => {
            const isActiveSpace = space.slug === activeSpaceSlug;
            const collapsed = spaceCollapse.has(space.slug);
            const showTree = isActiveSpace && !collapsed;
            return (
              <div key={space.slug} style={{ position: "relative" }}>
                <SpaceRow
                  space={space}
                  active={isActiveSpace}
                  expanded={showTree}
                  hostNavigation={hostNavigation}
                  onToggleCollapse={() => {
                    if (!isActiveSpace) {
                      setSpaceCollapse((current) => {
                        if (!current.has(space.slug)) return current;
                        const next = new Set(current);
                        next.delete(space.slug);
                        return next;
                      });
                      hostNavigation.navigate(buildSectionHref("browse", space.slug));
                    } else {
                      toggleSpaceCollapse(space.slug);
                    }
                  }}
                  onMenuToggle={() => setOpenMenuFor((curr) => curr === space.slug ? null : space.slug)}
                  menuOpen={openMenuFor === space.slug}
                  onMenuClose={() => setOpenMenuFor(null)}
                  onArchived={(slug) => {
                    spacesQuery.refresh();
                    setOpenMenuFor(null);
                    setSpaceCollapse((current) => {
                      if (!current.has(slug)) return current;
                      const next = new Set(current);
                      next.delete(slug);
                      return next;
                    });
                    if (activeSpaceSlug === slug) {
                      hostNavigation.navigate(buildSectionHref("browse", DEFAULT_SPACE_SLUG));
                    }
                  }}
                  activeSpaceSlug={activeSpaceSlug}
                  companyId={context.companyId}
                />
                {showTree ? (
                  <div style={{ paddingLeft: 18, marginTop: 2, marginBottom: 6 }}>
                    <FileTree
                      nodes={activeSpaceNodes}
                      selectedFile={selectedTreePath}
                      expandedPaths={expandedForActiveSpace}
                      onSelectFile={(path) => {
                        setSelectedTreePath(path);
                        hostNavigation.navigate(buildPageHref(path, space.slug), { state: wikiSidebarNavigationState(path) });
                      }}
                      onToggleDir={handleToggleDir}
                      wrapLabels={false}
                      loading={pages.loading}
                      error={pages.error ? { message: pages.error.message } : null}
                      empty={{ title: "No pages yet", description: "Add content to populate this space." }}
                      ariaLabel={`Wiki pages in ${space.displayName}`}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <nav
        aria-label="Wiki secondary"
        className="shrink-0 border-t border-border px-3 py-3"
      >
        <div className="flex flex-col gap-0.5">
          {BOTTOM_TOOL_SECTIONS.map(renderToolLink)}
        </div>
      </nav>
      {createOpen && context.companyId ? (
        <CreateSpaceModal
          companyId={context.companyId}
          existingSlugs={new Set(spaces.map((s) => s.slug))}
          onClose={() => setCreateOpen(false)}
          onCreated={(space) => {
            setCreateOpen(false);
            spacesQuery.refresh();
            hostNavigation.navigate(buildSectionHref("browse", space.slug));
          }}
        />
      ) : null}
    </aside>
  );
}

function SpaceRow({
  space,
  active,
  expanded,
  hostNavigation,
  onToggleCollapse,
  onMenuToggle,
  menuOpen,
  onMenuClose,
  onArchived,
  activeSpaceSlug,
  companyId,
}: {
  space: WikiSpace;
  active: boolean;
  expanded: boolean;
  hostNavigation: ReturnType<typeof useHostNavigation>;
  onToggleCollapse: () => void;
  onMenuToggle: () => void;
  menuOpen: boolean;
  onMenuClose: () => void;
  onArchived: (slug: string) => void;
  activeSpaceSlug: string;
  companyId: string | null;
}) {
  const [hover, setHover] = useState(false);
  const isDefault = space.slug === DEFAULT_SPACE_SLUG;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : active ? "Expand" : "Open"} ${space.displayName} space`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        borderRadius: 6,
        cursor: "pointer",
        background: active ? tokens.accent : "transparent",
        position: "relative",
      }}
      onClick={onToggleCollapse}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onToggleCollapse();
      }}
    >
      <span aria-hidden="true" style={{ color: tokens.muted, display: "flex", flexShrink: 0, transform: expanded ? "rotate(0)" : "rotate(0)" }}>
        {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
      </span>
      <span aria-hidden="true" style={{ color: tokens.muted, display: "flex", flexShrink: 0 }}>
        <FolderIcon size={16} />
      </span>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: tokens.fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {space.displayName}
      </span>
      {space.accessScope === "personal" ? (
        <Badge tone="default" style={{ height: 18, padding: "0 6px", fontSize: 10 }}>personal</Badge>
      ) : space.accessScope === "team" ? (
        <Badge tone="default" style={{ height: 18, padding: "0 6px", fontSize: 10 }}>team</Badge>
      ) : null}
      <button
        type="button"
        aria-label={`${space.displayName} space menu`}
        title="Space menu"
        onClick={(event) => {
          event.stopPropagation();
          onMenuToggle();
        }}
        style={{
          opacity: hover || menuOpen ? 1 : 0,
          transition: "opacity 80ms ease",
          width: 22,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          background: "transparent",
          color: tokens.fg,
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        <MoreHorizontalIcon size={14} />
      </button>
      {menuOpen ? (
        <SpaceRowMenu
          space={space}
          isDefault={isDefault}
          hostNavigation={hostNavigation}
          activeSpaceSlug={activeSpaceSlug}
          companyId={companyId}
          onClose={onMenuClose}
          onArchived={onArchived}
        />
      ) : null}
    </div>
  );
}

function SpaceRowMenu({
  space,
  isDefault,
  hostNavigation,
  activeSpaceSlug,
  companyId,
  onClose,
  onArchived,
}: {
  space: WikiSpace;
  isDefault: boolean;
  hostNavigation: ReturnType<typeof useHostNavigation>;
  activeSpaceSlug: string;
  companyId: string | null;
  onClose: () => void;
  onArchived: (slug: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const archive = usePluginAction("archive-space");
  const bootstrap = usePluginAction("bootstrap-space");
  const toast = usePluginToast();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (!ref.current) return;
      if (event.target instanceof Node && ref.current.contains(event.target)) return;
      onClose();
    };
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  const handleArchive = async () => {
    if (!companyId || isDefault || busy) return;
    if (typeof window !== "undefined" && !window.confirm(`Archive ${space.displayName}? Pages remain on disk; you can restore later through the plugin API or by un-archiving from the database.`)) {
      return;
    }
    setBusy(true);
    try {
      await archive({ companyId, spaceSlug: space.slug });
      toast({ tone: "success", title: "Space archived", body: `${space.displayName} hidden from sidebar.` });
      onArchived(space.slug);
    } catch (err) {
      toast({ tone: "error", title: "Archive failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    if (!companyId || busy) return;
    setBusy(true);
    try {
      await bootstrap({ companyId, spaceSlug: space.slug });
      toast({ tone: "success", title: "Space refreshed", body: `${space.displayName} index re-bootstrapped.` });
      onClose();
    } catch (err) {
      toast({ tone: "error", title: "Refresh failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      onClick={(event) => event.stopPropagation()}
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        right: 0,
        zIndex: 30,
        minWidth: 220,
        background: tokens.card,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        boxShadow: "0 12px 36px rgba(0,0,0,0.45)",
        padding: 4,
      }}
    >
      <SpaceMenuItem
        label="Edit space"
        Icon={PencilIcon}
        onClick={() => {
          onClose();
          hostNavigation.navigate(buildSettingsSectionHref("spaces", activeSpaceSlug, space.slug));
        }}
      />
      <SpaceMenuItem
        label="Refresh index"
        Icon={RefreshIcon}
        onClick={handleRefresh}
        disabled={busy}
      />
      <SpaceMenuItem
        label="Open ingest"
        Icon={PlusCircleIcon}
        onClick={() => {
          onClose();
          hostNavigation.navigate(buildSectionHref("ingest", space.slug));
        }}
      />
      <SpaceMenuDivider />
      <SpaceMenuItem
        label={isDefault ? "Archive space (default cannot be archived)" : "Archive space…"}
        Icon={ArchiveIcon}
        onClick={handleArchive}
        disabled={isDefault || busy}
        destructive
      />
    </div>
  );
}

function SpaceMenuItem({
  label,
  Icon,
  onClick,
  disabled,
  destructive,
}: {
  label: string;
  Icon: (props: LucideIconProps) => ReactElement;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 10px",
        background: "transparent",
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        color: destructive ? "oklch(0.7 0.2 25)" : tokens.fg,
        opacity: disabled ? 0.5 : 1,
        fontSize: 13,
        textAlign: "left",
        borderRadius: 4,
        fontFamily: fontStack,
      }}
      onMouseEnter={(event) => {
        if (disabled) return;
        event.currentTarget.style.background = tokens.accent;
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "transparent";
      }}
    >
      <span aria-hidden="true" style={{ display: "flex", color: destructive ? "oklch(0.7 0.2 25)" : tokens.muted }}>
        <Icon size={14} />
      </span>
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  );
}

function SpaceMenuDivider() {
  return <div style={{ height: 1, background: tokens.border, margin: "4px 0" }} />;
}

const shellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 600,
  background: tokens.bg,
  color: tokens.fg,
  fontFamily: fontStack,
  fontSize: 14,
};

// ---------------------------------------------------------------------------
// Pre-flight: prompt for folder before any tab can be useful.
// ---------------------------------------------------------------------------

function UnconfiguredFolder({ context, folder, refresh }: { context: { companyId: string | null }; folder?: FolderStatus; refresh: () => void }) {
  const bootstrap = usePluginAction("bootstrap-root");
  const toast = usePluginToast();
  const isMobile = useIsMobileLayout();
  const [path, setPath] = useState(folder?.path ?? "");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const configuredButUnhealthy = Boolean(folder?.configured);

  useEffect(() => {
    setPath(folder?.path ?? "");
  }, [folder?.path]);

  async function submit() {
    if (!context.companyId || !path.trim()) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const result = await bootstrap({ companyId: context.companyId, path: path.trim() });
      const written = (result as { writtenFiles?: string[] }).writtenFiles ?? [];
      toast({ tone: "success", title: "Wiki root configured", body: written.length ? `Created ${written.length} bootstrap file(s).` : "Existing files preserved." });
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMsg(message);
      toast({ tone: "error", title: "Could not configure wiki root", body: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ flex: 1, padding: isMobile ? 16 : 28, display: "grid", placeItems: "start", overflow: isMobile ? "visible" : "auto", minWidth: 0 }}>
      <Card style={{ maxWidth: 720, width: "100%" }}>
        <CardHeader title={configuredButUnhealthy ? "Repair wiki root folder" : "Choose a wiki root folder"} />
        <CardBody>
          <Tiny style={{ marginBottom: 12 }}>
            {configuredButUnhealthy
              ? "The configured wiki root is not ready. Update the path or repair it to recreate required baseline files."
              : "Pick an absolute path on this machine. The plugin creates "}
            {!configuredButUnhealthy ? <><Mono>raw/</Mono>, <Mono>wiki/</Mono>, <Mono>AGENTS.md</Mono>, <Mono>IDEA.md</Mono>, <Mono>wiki/index.md</Mono>, and <Mono>wiki/log.md</Mono> if they don't already exist.</> : null}
          </Tiny>
          {folder?.problems?.length ? (
            <Callout tone="danger">
              <div style={{ display: "grid", gap: 6 }}>
                {folder.problems.map((problem, index) => (
                  <div key={`${problem.code}:${problem.path ?? index}`}>
                    {problem.message}{problem.path ? <> <Mono>{problem.path}</Mono></> : null}
                  </div>
                ))}
              </div>
            </Callout>
          ) : null}
          <div style={{ display: "grid", gap: 12 }}>
            {folder ? <FolderHealthChecklist folder={folder} /> : null}
            <FolderPathPicker
              value={path}
              onChange={setPath}
              onApply={submit}
              applyLabel={configuredButUnhealthy ? "Repair & bootstrap" : "Configure & bootstrap"}
              busy={busy}
              disabled={!path.trim()}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button variant="ghost" onClick={() => refresh()}>I already configured it</Button>
            </div>
            {errorMsg ? <Callout tone="danger">{errorMsg}</Callout> : null}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browse tab: selected page detail. The route sidebar owns the file tree.
// ---------------------------------------------------------------------------

const TEMPLATE_PATHS = ["AGENTS.md", "IDEA.md"] as const;
const BASELINE_DIRECTORIES = ["raw", "wiki", "wiki/sources", "wiki/projects", "wiki/entities", "wiki/concepts", "wiki/synthesis"] as const;
const BASELINE_FILES = [...TEMPLATE_PATHS, "wiki/index.md", "wiki/log.md"] as const;
const BASELINE_TREE_ORDER = new Map<string, number>([
  ["AGENTS.md", 0],
  ["IDEA.md", 1],
  ["raw", 2],
  ["wiki", 3],
  ["wiki/index.md", 0],
  ["wiki/log.md", 1],
  ["wiki/sources", 2],
  ["wiki/projects", 3],
  ["wiki/entities", 4],
  ["wiki/concepts", 5],
  ["wiki/synthesis", 6],
]);

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function ensureDir(roots: FileTreeNode[], dirPath: string): FileTreeNode {
  const segments = dirPath.split("/").filter(Boolean);
  let parentChildren = roots;
  let currentPath = "";
  let currentNode: FileTreeNode | null = null;
  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    let next = parentChildren.find((c) => c.kind === "dir" && c.path === currentPath);
    if (!next) {
      next = { name: segment, path: currentPath, kind: "dir", children: [] };
      parentChildren.push(next);
    }
    parentChildren = next.children;
    currentNode = next;
  }
  if (!currentNode) {
    throw new Error(`ensureDir called with empty path`);
  }
  return currentNode;
}

function pageDisplayName(path: string, title: string | null): string {
  const trimmed = title?.trim();
  return trimmed ? trimmed : basename(path);
}

function treeDisplayName(path: string, title: string | null): string {
  return (BASELINE_FILES as readonly string[]).includes(path) ? basename(path) : pageDisplayName(path, title);
}

function buildBrowseTree(
  pages: WikiPageRow[],
  sources: WikiSourceRow[],
): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const seenPaths = new Set<string>();

  for (const dirPath of BASELINE_DIRECTORIES) {
    ensureDir(roots, dirPath);
  }

  if (sources.length > 0) {
    const rawDir = ensureDir(roots, "raw");
    for (const source of sources) {
      seenPaths.add(source.rawPath);
      const node: FileTreeNode = {
        name: pageDisplayName(source.rawPath, source.title),
        path: source.rawPath,
        kind: "file",
        children: [],
      };
      rawDir.children.push(node);
    }
  }

  for (const page of pages) {
    seenPaths.add(page.path);
    const parentDir = dirname(page.path);
    const file: FileTreeNode = {
      name: treeDisplayName(page.path, page.title),
      path: page.path,
      kind: "file",
      children: [],
    };
    if (parentDir) {
      ensureDir(roots, parentDir).children.push(file);
    } else {
      roots.push(file);
    }
  }

  // Add the baseline files using their real wiki-root paths so the browser
  // mirrors the on-disk default layout even before metadata has been indexed.
  for (const path of BASELINE_FILES) {
    if (seenPaths.has(path)) continue;
    const parentDir = dirname(path);
    const node = {
      name: basename(path),
      path,
      kind: "file" as const,
      children: [],
      action: path,
    };
    seenPaths.add(path);
    if (parentDir) {
      ensureDir(roots, parentDir).children.push(node);
      continue;
    }
    roots.push({
      ...node,
      name: path,
    });
  }

  function sortNodes(nodes: FileTreeNode[]) {
    nodes.sort((a, b) => {
      const orderA = BASELINE_TREE_ORDER.get(a.path);
      const orderB = BASELINE_TREE_ORDER.get(b.path);
      if (orderA != null || orderB != null) return (orderA ?? Number.MAX_SAFE_INTEGER) - (orderB ?? Number.MAX_SAFE_INTEGER);
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.kind === "dir") sortNodes(node.children);
    }
  }
  sortNodes(roots);

  return roots;
}

function expandedAncestors(path: string | null): string[] {
  if (!path) return [];
  const out: string[] = [];
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (let i = 0; i < segments.length - 1; i++) {
    current = current ? `${current}/${segments[i]}` : segments[i];
    out.push(current);
  }
  return out;
}

function BrowseTab({ context }: { context: { companyId: string | null } }) {
  const { pathname, search } = useHostLocation();
  const activeSpaceSlug = useMemo(() => readActiveSpaceSlugFromLocation(pathname), [pathname]);
  const pages = usePages(context.companyId, { includeRaw: true, spaceSlug: activeSpaceSlug });
  const isMobile = useIsMobileLayout();
  const selectedTreePath = readSelectedTreePathFromLocation(pathname, search) ?? firstSelectableTreePath(pages.data);
  const selected = contentPathFromTreePath(selectedTreePath);

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: isMobile ? "visible" : "auto" }}>
      {pages.loading && !selected ? (
        <div style={{ padding: isMobile ? 16 : 28, color: tokens.muted, fontSize: 13 }}>Loading pages…</div>
      ) : pages.error && !selected ? (
        <div style={{ padding: isMobile ? 16 : 28 }}><Callout tone="danger">Failed to load pages: {pages.error.message}</Callout></div>
      ) : (
        <PageDetail context={context} path={selected} spaceSlug={activeSpaceSlug} />
      )}
    </div>
  );
}

function PageDetail({ context, path, spaceSlug }: { context: { companyId: string | null }; path: string | null; spaceSlug?: string }) {
  const content = usePageContent(context.companyId, path, spaceSlug ?? null);
  const writePage = usePluginAction("write-page");
  const toast = usePluginToast();
  const hostNavigation = useHostNavigation();
  const isMobile = useIsMobileLayout();
  const markdownBodyRef = useRef<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [savedHash, setSavedHash] = useState<string | null>(null);
  const [provenanceOpen, setProvenanceOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(true);
  const [activeTocId, setActiveTocId] = useState<string | null>(null);
  const parsedMarkdown = useMemo(() => parseWikiMarkdown(content.data?.contents ?? ""), [content.data?.contents]);
  const tocHeadings = useMemo(() => extractWikiTocHeadings(parsedMarkdown.body), [parsedMarkdown.body]);

  useEffect(() => {
    setEditing(false);
    setSavedHash(null);
    setTocOpen(true);
    setActiveTocId(null);
  }, [path]);

  useEffect(() => {
    if (!content.data || editing) return;
    const root = markdownBodyRef.current;
    if (!root) return;
    const renderedHeadings = Array.from(root.querySelectorAll("h2, h3, h4"));
    tocHeadings.forEach((heading, index) => {
      const element = renderedHeadings[index];
      if (element instanceof HTMLElement) {
        element.id = heading.id;
      }
    });
  }, [content.data, editing, tocHeadings]);

  useEffect(() => {
    if (!content.data || editing || tocHeadings.length === 0) return;
    const root = markdownBodyRef.current;
    if (!root) return;

    const scrollParent = findScrollableAncestor(root);
    const updateActiveHeading = () => {
      const containerTop = scrollParent instanceof HTMLElement ? scrollParent.getBoundingClientRect().top : 0;
      const activationY = containerTop + 96;
      let activeId = tocHeadings[0]?.id ?? null;

      for (const heading of tocHeadings) {
        const element = root.ownerDocument.getElementById(heading.id);
        if (!(element instanceof HTMLElement)) continue;
        if (!root.contains(element)) continue;
        if (element.getBoundingClientRect().top <= activationY) {
          activeId = heading.id;
        } else {
          break;
        }
      }

      setActiveTocId(activeId);
    };

    updateActiveHeading();
    scrollParent.addEventListener("scroll", updateActiveHeading, { passive: true });
    window.addEventListener("resize", updateActiveHeading);
    return () => {
      scrollParent.removeEventListener("scroll", updateActiveHeading);
      window.removeEventListener("resize", updateActiveHeading);
    };
  }, [content.data, editing, tocHeadings]);

  const editable = path ? isEditableWikiPagePath(path) : false;
  const resolveWikiLinkHref = useCallback(
    (target: string) => buildWikiLinkHref(target, hostNavigation.resolveHref),
    [hostNavigation.resolveHref],
  );
  const handleTocClick = useCallback((event: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    const root = markdownBodyRef.current;
    const target = root?.ownerDocument.getElementById(id);
    if (!(target instanceof HTMLElement)) return;
    if (root && !root.contains(target)) return;
    event.preventDefault();
    setActiveTocId(id);
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    if (typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${id}`);
    }
  }, []);
  const savePageContents = useCallback(async (nextContents: string) => {
    if (!context.companyId || !content.data || !editable || !path) return;
    const result = await writePage({
        companyId: context.companyId,
        wikiId: content.data.wikiId,
        spaceSlug: spaceSlug ?? null,
        path,
        contents: nextContents,
        expectedHash: savedHash ?? content.data.hash,
        summary: `Edited ${path} from the LLM Wiki page`,
    }) as { hash?: string };
    if (typeof result.hash === "string") setSavedHash(result.hash);
  }, [context.companyId, content.data, editable, path, savedHash, writePage, spaceSlug]);

  if (!path) return <div style={{ padding: isMobile ? 16 : 28, color: tokens.muted, fontSize: 13 }}>Pick a page from the tree.</div>;
  if (content.loading) return <div style={{ padding: isMobile ? 16 : 28, color: tokens.muted, fontSize: 13 }}>Loading {path}…</div>;
  if (content.error && path.startsWith("raw/")) {
    return (
      <div style={{ padding: isMobile ? 16 : 28, display: "grid", gap: 12 }}>
        <Callout tone="warn">
          The captured source <Mono>{path}</Mono> is indexed but no longer exists in the configured wiki folder. Refresh the wiki or re-ingest the source to restore it.
        </Callout>
        <Tiny>{content.error.message}</Tiny>
      </div>
    );
  }
  if (content.error) return <div style={{ padding: isMobile ? 16 : 28 }}><Callout tone="danger">Failed to read {path}: {content.error.message}</Callout></div>;
  if (!content.data) return <div style={{ padding: isMobile ? 16 : 28, color: tokens.muted, fontSize: 13 }}>No content for {path}.</div>;
  const { contents, title, sourceRefs, updatedAt, hash } = content.data;
  const visibleFrontmatter = parsedMarkdown.frontmatter.filter((property) => property.key.toLowerCase() !== "title");
  const displayTitle = (BASELINE_FILES as readonly string[]).includes(path) ? basename(path) : title ?? basename(path);
  const folderPath = dirname(path);

  const isDistilledProjectPage = path.startsWith("wiki/projects/");
  const showToc = !editing && tocHeadings.length > 0;
  const displaySourceRefs = sourceRefs
    .map((ref, index) => ({
      id: sourceRefIdentity(ref, index),
      label: formatSourceRef(ref, index),
      hasDisplayText: typeof ref === "string" || readSourceRefField(ref, "title") !== null,
    }))
    .filter((ref) => ref.hasDisplayText);

  return (
    <article style={{ padding: isMobile ? "16px" : "24px 28px", display: "grid", gap: isMobile ? 12 : 14, minWidth: 0 }}>
      <header style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap", minWidth: 0 }}>
          <div style={{ flex: "1 1 260px", minWidth: 0 }}>
            {folderPath ? <Tiny style={{ display: "block", marginBottom: 6 }}><Mono>{folderPath}</Mono></Tiny> : null}
            <h1 style={{ margin: 0, fontSize: isMobile ? 20 : 22, overflowWrap: "anywhere" }}>{displayTitle}</h1>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {isDistilledProjectPage ? (
              <Button size="sm" variant="ghost" onClick={() => setProvenanceOpen(true)} title="Show source provenance and freshness">
                <InfoIcon size={12} /> Provenance
              </Button>
            ) : null}
            {editable && !editing ? (
              <Button size="sm" onClick={() => { setSavedHash(hash); setEditing(true); }}>Edit page</Button>
            ) : editable ? (
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); content.refresh(); }}>Done</Button>
            ) : (
              <Badge>read-only source</Badge>
            )}
          </div>
        </div>
        <Tiny>Updated {updatedAt ? formatTime(updatedAt) : "—"}</Tiny>
      </header>
      {isDistilledProjectPage && path ? (
        <FreshnessChip companyId={context.companyId} pagePath={path} companyPrefix={(context as { companyPrefix?: string | null }).companyPrefix ?? null} />
      ) : null}
      {editing ? (
        <>
          <AutosaveMarkdownEditor
            key={`${path}:${hash}`}
            resetKey={`${path}:${hash}`}
            value={contents}
            placeholder={`Edit ${path}`}
            minHeight={isMobile ? 260 : 420}
            onSave={async (nextContents) => {
              await savePageContents(nextContents);
              toast({ tone: "success", title: `${path} saved` });
            }}
          />
        </>
      ) : (
        <div
          data-testid="llm-wiki-page-content-layout"
          style={{
            display: "grid",
            gridTemplateColumns: showToc && !isMobile ? `minmax(0, 1fr) ${tocOpen ? "minmax(180px, 240px)" : "36px"}` : "minmax(0, 1fr)",
            gap: showToc && !isMobile ? (tocOpen ? 24 : 10) : 0,
            alignItems: "start",
            minWidth: 0,
          }}
        >
          <div style={{ display: "grid", gap: isMobile ? 12 : 14, minWidth: 0 }}>
            <div ref={markdownBodyRef} style={{ minWidth: 0, fontSize: 13, lineHeight: 1.65 }}>
              <FrontmatterProperties properties={visibleFrontmatter} />
              <MarkdownBlock
                content={parsedMarkdown.body}
                enableWikiLinks
                resolveWikiLinkHref={resolveWikiLinkHref}
              />
              {displaySourceRefs.length > 0 ? (
                <section aria-label="Paperclip source refs" style={{ marginTop: 16, display: "grid", gap: 6 }}>
                  <Tiny style={{ fontWeight: 650 }}>Paperclip source refs</Tiny>
                  <ul style={{ margin: 0, paddingLeft: 18, color: tokens.muted, fontSize: 12, lineHeight: 1.5 }}>
                    {displaySourceRefs.map((ref) => (
                      <li key={ref.id}>{ref.label}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </div>
          {showToc ? (
            <OnThisPagePane
              headings={tocHeadings}
              activeHeadingId={activeTocId}
              open={tocOpen}
              onToggle={() => setTocOpen((current) => !current)}
              onHeadingClick={handleTocClick}
              mobile={isMobile}
            />
          ) : null}
        </div>
      )}
      {provenanceOpen && path ? (
        <ProvenanceDrawer
          companyId={context.companyId}
          pagePath={path}
          onClose={() => setProvenanceOpen(false)}
        />
      ) : null}
    </article>
  );
}

function findScrollableAncestor(element: HTMLElement): HTMLElement | Window {
  let current: HTMLElement | null = element.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return window;
}

function OnThisPagePane({
  headings,
  activeHeadingId,
  open,
  onToggle,
  onHeadingClick,
  mobile,
}: {
  headings: WikiTocHeading[];
  activeHeadingId: string | null;
  open: boolean;
  onToggle: () => void;
  onHeadingClick: (event: React.MouseEvent<HTMLAnchorElement>, id: string) => void;
  mobile: boolean;
}) {
  const contentId = "llm-wiki-on-this-page";
  const currentHeadingId = activeHeadingId ?? headings[0]?.id ?? null;
  const shellRef = useRef<HTMLElement | null>(null);
  const [fixedFrame, setFixedFrame] = useState<{ left: number; top: number; width: number } | null>(null);

  useEffect(() => {
    if (mobile) {
      setFixedFrame(null);
      return;
    }
    const shell = shellRef.current;
    if (!shell) return;

    let animationFrame = 0;
    const updateFrame = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const rect = shell.getBoundingClientRect();
        const top = Math.max(WIKI_TOC_STICKY_TOP, rect.top);
        setFixedFrame((current) => {
          if (
            current &&
            Math.abs(current.left - rect.left) < 0.5 &&
            Math.abs(current.top - top) < 0.5 &&
            Math.abs(current.width - rect.width) < 0.5
          ) {
            return current;
          }
          return { left: rect.left, top, width: rect.width };
        });
      });
    };

    updateFrame();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateFrame);
    resizeObserver?.observe(shell);
    window.addEventListener("resize", updateFrame);
    window.addEventListener("scroll", updateFrame, true);
    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateFrame);
      window.removeEventListener("scroll", updateFrame, true);
    };
  }, [mobile, open]);

  const paneStyle: CSSProperties = mobile ? {} : fixedFrame ? {
    position: "fixed",
    top: fixedFrame.top,
    left: fixedFrame.left,
    width: fixedFrame.width,
    maxHeight: `calc(100vh - ${fixedFrame.top + 16}px)`,
    overflowY: "auto",
    zIndex: 2,
  } : {
    position: "sticky",
    top: WIKI_TOC_STICKY_TOP,
  };

  return (
    <aside
      ref={shellRef}
      aria-label="On this page"
      style={{
        order: mobile ? -1 : 0,
        minWidth: 0,
        minHeight: mobile ? undefined : open ? 120 : 24,
        alignSelf: "start",
      }}
    >
      <div style={{
        ...paneStyle,
        borderLeft: open ? `1px solid ${tokens.border}` : 0,
        paddingLeft: open ? 10 : 0,
      }}>
        <button
          type="button"
          aria-label={open ? "Collapse on this page" : "Expand on this page"}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={onToggle}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: open ? "space-between" : "center",
            gap: 10,
            width: "100%",
            border: 0,
            background: "transparent",
            color: tokens.fg,
            padding: open ? "0 0 8px" : "0",
            fontFamily: fontStack,
            fontSize: 12,
            fontWeight: 650,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          {open ? <span>On this page</span> : null}
          <span aria-hidden="true" style={{ color: tokens.muted, transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 120ms ease" }}>
            <ChevronLeftIcon size={13} />
          </span>
        </button>
        {open ? (
          <nav id={contentId} style={{ display: "grid", gap: 2 }}>
            {headings.map((heading) => {
              const active = heading.id === currentHeadingId;
              return (
                <a
                  key={heading.id}
                  href={`#${heading.id}`}
                  aria-current={active ? "location" : undefined}
                  onClick={(event) => onHeadingClick(event, heading.id)}
                  style={{
                    display: "block",
                    padding: `3px 0 3px ${Math.max(0, heading.level - 2) * 12}px`,
                    color: active ? tokens.fg : tokens.muted,
                    fontSize: 12,
                    fontWeight: active ? 700 : 450,
                    lineHeight: 1.35,
                    textDecoration: "none",
                    overflowWrap: "anywhere",
                  }}
                >
                  {heading.text}
                </a>
              );
            })}
          </nav>
        ) : null}
      </div>
    </aside>
  );
}

function FreshnessChip({ companyId, pagePath, companyPrefix }: { companyId: string | null; pagePath: string; companyPrefix: string | null }) {
  const provenance = useDistillationProvenance(companyId, pagePath);
  const binding = provenance.data?.binding ?? null;
  const cursor = provenance.data?.cursor ?? null;

  if (provenance.loading && !provenance.data) {
    return <FreshnessChipShell tone="info" icon={<ClockIcon size={14} />}>Checking distillation cursor…</FreshnessChipShell>;
  }
  if (!binding) return null;

  const lastEnd = binding.lastRunSourceWindowEnd ?? binding.lastRunCompletedAt;
  const status = binding.lastRunStatus ?? "unknown";
  const sourceCount = (() => {
    const meta = binding.metadata as Record<string, unknown>;
    const refs = Array.isArray(meta.sourceRefs) ? meta.sourceRefs.length : null;
    return refs;
  })();
  const isStale = (() => {
    if (status === "failed" || status === "refused_cost_cap") return true;
    if (!lastEnd) return true;
    const diff = Date.now() - Date.parse(lastEnd);
    return Number.isFinite(diff) ? diff > 72 * 60 * 60 * 1000 : true;
  })();
  const isFailed = status === "failed" || status === "refused_cost_cap";
  const isRunning = status === "running";

  const tone: "info" | "warn" | "danger" | "running" = isFailed ? "danger" : isStale ? "warn" : isRunning ? "running" : "info";
  const projectLink = cursor && cursor.projectId && companyPrefix ? `/${companyPrefix}/projects/${cursor.projectId}` : null;

  return (
    <FreshnessChipShell
      tone={tone}
      icon={isFailed ? <AlertTriangleIcon size={14} /> : isRunning ? <ActivityIcon size={14} /> : <ClockIcon size={14} />}
    >
      <span><strong>Current as of {lastEnd ? formatTimestamp(lastEnd) : "—"}.</strong>
        {sourceCount ? ` ${sourceCount} sources in this window. ` : " "}
        Cursor at <Mono>{lastEnd ?? "—"}</Mono>.
      </span>
      {projectLink ? (
        <a href={projectLink} style={{ marginLeft: 8, color: "inherit", textDecoration: "underline" }}>
          Open Paperclip for live state →
        </a>
      ) : null}
    </FreshnessChipShell>
  );
}

function FreshnessChipShell({ tone, icon, children }: { tone: "info" | "warn" | "danger" | "running"; icon: ReactNode; children: ReactNode }) {
  const palette = tone === "danger"
    ? { bg: "oklch(0.22 0.06 25)", fg: "oklch(0.85 0.12 25)", border: "oklch(0.45 0.12 25)" }
    : tone === "warn"
      ? { bg: "oklch(0.22 0.06 70)", fg: "oklch(0.85 0.1 70)", border: "oklch(0.45 0.12 70)" }
      : tone === "running"
        ? { bg: "oklch(0.22 0.06 200)", fg: "oklch(0.85 0.11 200)", border: "oklch(0.45 0.12 200)" }
        : tokens.callout;
  return (
    <div style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      padding: "8px 12px",
      borderRadius: 999,
      background: palette.bg,
      color: palette.fg,
      border: `1px solid ${palette.border}`,
      fontSize: 12.5,
      lineHeight: 1.5,
      flexWrap: "wrap",
    }}>
      {icon}
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        {children}
      </div>
    </div>
  );
}

function readSourceRefField(ref: Record<string, unknown>, field: string): string | null {
  const value = ref[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function sourceRefIdentity(ref: Record<string, unknown> | string, fallbackIndex: number): string {
  if (typeof ref === "string") return ref;
  const issueIdentifier = readSourceRefField(ref, "issueIdentifier");
  const issueId = readSourceRefField(ref, "issueId");
  const commentId = readSourceRefField(ref, "commentId");
  const documentKey = readSourceRefField(ref, "documentKey");
  const documentId = readSourceRefField(ref, "documentId");
  const kind = readSourceRefField(ref, "kind");
  const parts = [kind, issueIdentifier ?? issueId, commentId, documentKey ?? documentId].filter(Boolean);
  return parts.length > 0 ? parts.join(":") : `source-ref-${fallbackIndex}`;
}

function formatSourceRef(ref: Record<string, unknown> | string, fallbackIndex: number): string {
  if (typeof ref === "string") return ref;

  const kind = readSourceRefField(ref, "kind");
  const issue = readSourceRefField(ref, "issueIdentifier") ?? readSourceRefField(ref, "issueId");
  const title = readSourceRefField(ref, "title");
  const commentId = readSourceRefField(ref, "commentId");
  const documentKey = readSourceRefField(ref, "documentKey");
  const documentId = readSourceRefField(ref, "documentId");

  const primary = issue ?? sourceRefIdentity(ref, fallbackIndex);
  const suffix = kind === "comment" && commentId
    ? ` comment ${commentId.slice(0, 8)}`
    : kind === "document" && (documentKey || documentId)
      ? ` document ${documentKey ?? documentId?.slice(0, 8)}`
      : kind ? ` ${kind}` : "";
  return title ? `${primary}${suffix} - ${title}` : `${primary}${suffix}`;
}

function ProvenanceDrawer({ companyId, pagePath, onClose }: { companyId: string | null; pagePath: string; onClose: () => void }) {
  const isMobile = useIsMobileLayout();
  const provenance = useDistillationProvenance(companyId, pagePath);
  const data = provenance.data;
  const binding = data?.binding ?? null;
  const cursor = data?.cursor ?? null;
  const snapshot = data?.snapshot ?? null;
  const runs = data?.runs ?? [];

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(0 0 0 / 0.55)",
        zIndex: 50,
        display: "flex",
        justifyContent: isMobile ? "stretch" : "flex-end",
        alignItems: isMobile ? "flex-end" : "stretch",
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          background: tokens.bg,
          borderLeft: isMobile ? undefined : `1px solid ${tokens.border}`,
          borderTop: isMobile ? `1px solid ${tokens.border}` : undefined,
          width: isMobile ? "100%" : 420,
          maxWidth: "100%",
          maxHeight: isMobile ? "85vh" : "100vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${tokens.border}`, display: "flex", alignItems: "center", gap: 10 }}>
          <InfoIcon size={16} />
          <strong style={{ fontSize: 14, flex: 1 }}>Provenance</strong>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <XIcon size={14} />
          </Button>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          {provenance.loading && !data ? <Tiny>Loading provenance…</Tiny> : null}
          {!binding && !provenance.loading ? <Callout>This page is not currently bound to a distillation cursor. It may be hand-authored or pre-distillation.</Callout> : null}
          {binding ? (
            <Card>
              <CardBody padding={14}>
                <PropRow label="Page path" value={<Mono>{binding.pagePath}</Mono>} />
                <PropRow label="Source hash" value={<Mono>{binding.lastRunSourceHash?.slice(0, 16) ?? "—"}…</Mono>} />
                <PropRow label="Cursor end" value={<Mono>{binding.lastRunSourceWindowEnd ? formatTimestamp(binding.lastRunSourceWindowEnd) : "—"}</Mono>} />
                <PropRow label="Last run status" value={<Badge tone={runStatusTone(binding.lastRunStatus ?? "")}>{binding.lastRunStatus ?? "—"}</Badge>} />
                <PropRow label="Project" value={binding.projectName ?? "—"} />
                <PropRow label="Updated" value={formatTimestamp(binding.updatedAt)} />
              </CardBody>
            </Card>
          ) : null}
          {cursor ? (
            <Card>
              <CardHeader title="Cursor" />
              <CardBody padding={14}>
                <PropRow label="Scope" value={cursor.sourceScope} />
                <PropRow label="Pending events" value={String(cursor.pendingEventCount)} />
                <PropRow label="Last observed" value={formatTimestamp(cursor.lastObservedAt)} />
                <PropRow label="Last processed" value={formatTimestamp(cursor.lastProcessedAt)} />
              </CardBody>
            </Card>
          ) : null}
          {snapshot ? (
            <Card>
              <CardHeader title="Sources in this window" />
              <CardBody padding={14}>
                <Tiny style={{ marginBottom: 8 }}>{snapshot.sourceRefs.length} ref{snapshot.sourceRefs.length === 1 ? "" : "s"}{snapshot.clipped ? " · clipped" : ""}</Tiny>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: tokens.muted, lineHeight: 1.5 }}>
                  {snapshot.sourceRefs.slice(0, 8).map((ref, index) => {
                    const obj = typeof ref === "object" && ref ? ref as Record<string, unknown> : null;
                    const id = obj && typeof obj.id === "string" ? obj.id : typeof ref === "string" ? ref : `ref-${index}`;
                    const kind = obj && typeof obj.kind === "string" ? obj.kind : null;
                    const title = obj && typeof obj.title === "string" ? obj.title : null;
                    return (
                      <li key={`${id}-${index}`} style={{ marginBottom: 4 }}>
                        <Mono>{id}</Mono>
                        {kind ? ` · ${kind}` : ""}
                        {title ? ` · ${title}` : ""}
                      </li>
                    );
                  })}
                </ul>
                {snapshot.sourceRefs.length > 8 ? <Tiny style={{ marginTop: 6 }}>{`+${snapshot.sourceRefs.length - 8} more`}</Tiny> : null}
              </CardBody>
            </Card>
          ) : null}
          {runs.length > 0 ? (
            <Card>
              <CardHeader title="Operations affecting this page" />
              <CardBody padding={0}>
                <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                  {runs.slice(0, 8).map((run) => (
                    <li key={run.id} style={{ padding: "10px 14px", borderBottom: `1px solid ${tokens.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Mono style={{ fontSize: 12 }}>{run.operationIssueIdentifier ?? `op-${run.id.slice(0, 6)}`}</Mono>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <Tiny>{formatTimestamp(run.updatedAt)}</Tiny>
                        <Mono style={{ fontSize: 11 }}>{formatCostCents(run.costCents)}</Mono>
                        <Badge tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FrontmatterProperties({ properties }: { properties: WikiFrontmatterProperty[] }) {
  if (properties.length === 0) return null;

  return (
    <details
      open
      style={{
        marginBottom: 20,
        paddingBottom: 16,
        borderBottom: `1px solid ${tokens.border}`,
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          color: tokens.fg,
          fontSize: 13,
          fontWeight: 650,
          listStylePosition: "outside",
          marginBottom: 10,
        }}
      >
        Properties
      </summary>
      <dl style={{ display: "grid", gap: 8, margin: 0, maxWidth: 720 }}>
        {properties.map((property) => (
          <div
            key={property.key}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(96px, 0.32fr) minmax(0, 1fr)",
              gap: 12,
              alignItems: "baseline",
              minWidth: 0,
            }}
          >
            <dt style={{ color: tokens.muted, fontSize: 12, minWidth: 0, overflowWrap: "anywhere" }}>{property.key}</dt>
            <dd style={{ margin: 0, minWidth: 0 }}>
              <FrontmatterValue value={property.value} />
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function FrontmatterValue({ value }: { value: WikiFrontmatterValue }) {
  if (Array.isArray(value)) {
    return (
      <span style={{ display: "flex", flexWrap: "wrap", gap: 6, minWidth: 0 }}>
        {value.map((item) => (
          <span
            key={item}
            style={{
              display: "inline-flex",
              alignItems: "center",
              minWidth: 0,
              maxWidth: "100%",
              padding: "1px 7px",
              borderRadius: 999,
              background: "var(--secondary, oklch(0.269 0 0))",
              color: tokens.fg,
              fontSize: 12,
              lineHeight: 1.5,
              overflowWrap: "anywhere",
            }}
          >
            {item}
          </span>
        ))}
      </span>
    );
  }

  return (
    <span style={{ color: tokens.fg, fontSize: 13, overflowWrap: "anywhere" }}>
      {value}
    </span>
  );
}

function Row({ primary, secondary, right }: { primary: ReactNode; secondary?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 12,
      padding: "8px 12px",
      borderBottom: `1px solid ${tokens.border}`,
      fontSize: 13,
      minWidth: 0,
    }}>
      <div style={{ flex: "1 1 220px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "normal", overflowWrap: "anywhere" }}>{primary}</div>
      {secondary ? <div style={{ flex: "0 1 auto", minWidth: 0, color: tokens.muted, fontSize: 12, overflowWrap: "anywhere" }}>{secondary}</div> : null}
      {right ? <div style={{ marginLeft: "auto", minWidth: 0, display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>{right}</div> : null}
    </div>
  );
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const diffMs = Date.now() - date.getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return date.toLocaleDateString();
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Ingest tab.
// ---------------------------------------------------------------------------

function IngestTab({ context, refreshOverview }: { context: { companyId: string | null }; refreshOverview: () => void }) {
  const { pathname } = useHostLocation();
  const activeSpaceSlug = useMemo(() => readActiveSpaceSlugFromLocation(pathname), [pathname]);
  const spacesQuery = useSpaces(context.companyId);
  const spaces = useMemo(() => {
    const list = spacesQuery.data?.spaces ?? [];
    return activeWikiSpaces(list).sort(compareSpaces);
  }, [spacesQuery.data]);
  const ingest = usePluginAction("ingest-source");
  const toast = usePluginToast();
  const hostNavigation = useHostNavigation();
  const isMobile = useIsMobileLayout();
  const [url, setUrl] = useState("");
  const [pasted, setPasted] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const activeSpace = useMemo(() => {
    return spaces.find((space) => space.slug === activeSpaceSlug)
      ?? spaces.find((space) => space.slug === DEFAULT_SPACE_SLUG)
      ?? null;
  }, [spaces, activeSpaceSlug]);

  const canSubmit = !!context.companyId && (pasted.trim().length > 0 || url.trim().length > 0) && !busy;

  useEffect(() => {
    const refresh = () => refreshOverview();
    window.addEventListener("pc-wiki-ingest-queued", refresh);
    return () => window.removeEventListener("pc-wiki-ingest-queued", refresh);
  }, [refreshOverview]);

  async function submit() {
    if (!context.companyId) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      let contents = pasted.trim();
      let sourceType: "url" | "text" = "text";
      let resolvedTitle = title.trim();
      if (url.trim()) {
        sourceType = "url";
        contents = pasted.trim() || `Captured URL: ${url.trim()}\n\n_Plugin needs to fetch the URL — placeholder body for the alpha._`;
        resolvedTitle = resolvedTitle || url.trim();
      } else {
        resolvedTitle = resolvedTitle || pasted.split("\n", 1)[0]?.slice(0, 80) || "Pasted source";
      }
      await ingest({
        companyId: context.companyId,
        spaceSlug: activeSpaceSlug,
        sourceType,
        url: url.trim() || null,
        title: resolvedTitle,
        contents,
      });
      const spaceLabel = activeSpace?.displayName ?? activeSpaceSlug;
      toast({ tone: "success", title: `Source captured into ${spaceLabel}`, body: `Operation issue created. Check History to inspect.` });
      setUrl("");
      setPasted("");
      setTitle("");
      refreshOverview();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMsg(message);
      toast({ tone: "error", title: "Ingest failed", body: message });
    } finally {
      setBusy(false);
    }
  }

  const spaceLabel = activeSpace?.displayName ?? activeSpaceSlug;

  return (
    <div style={{ flex: 1, minHeight: isMobile ? "auto" : 0, minWidth: 0, overflow: isMobile ? "visible" : "auto" }}>
      <div style={{
        padding: isMobile ? "16px" : "24px 28px",
        maxWidth: 920,
        minWidth: 0,
      }}>
        <div style={{ marginBottom: 4, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: tokens.muted }}>Add Content</div>
        <h2 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 650 }}>Capture into <span style={{ color: tokens.fg }}>{spaceLabel}</span></h2>
        <Tiny style={{ marginBottom: 18 }}>
          Each capture queues an ingest operation scoped to <Mono>{activeSpaceSlug}</Mono>. Files land in that space's <Mono>raw/</Mono> folder and the Wiki Maintainer proposes a patch.
        </Tiny>
        <div style={{ display: "grid", gap: 14, marginBottom: 18 }}>
          <SpacePicker
            spaces={spaces}
            activeSpaceSlug={activeSpaceSlug}
            loading={spacesQuery.loading}
            error={spacesQuery.error?.message ?? null}
            isOpen={spaceMenuOpen}
            onToggle={() => setSpaceMenuOpen((v) => !v)}
            onClose={() => setSpaceMenuOpen(false)}
            onSelect={(slug) => {
              setSpaceMenuOpen(false);
              hostNavigation.navigate(buildSectionHref("ingest", slug));
            }}
            onCreate={() => {
              setSpaceMenuOpen(false);
              setCreateOpen(true);
            }}
          />
          <div>
            <label style={{ fontSize: 11, color: tokens.muted, display: "block", marginBottom: 6 }}>Drop files anywhere on this page</label>
            <div style={{
              minHeight: isMobile ? 180 : 230,
              border: `1.5px dashed ${tokens.pluginBorder}`,
              borderRadius: 8,
              padding: isMobile ? 20 : 30,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              alignItems: "center",
              gap: 10,
              textAlign: "center",
              color: tokens.muted,
              background: tokens.pluginBg,
            }}>
              <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 46, height: 46, borderRadius: 8, background: tokens.card, color: tokens.pluginFg, border: `1px solid ${tokens.pluginBorder}` }}>
                <DownloadCloudIcon size={24} />
              </div>
              <div style={{ fontSize: 16, fontWeight: 650, color: tokens.fg }}>Drop source files here</div>
              <Tiny>Review staged files before queueing maintainer tasks.</Tiny>
            </div>
          </div>
          <div data-testid="llm-wiki-ingest-manual-separator" aria-hidden="true" style={{ display: "flex", alignItems: "center", gap: 12, color: tokens.muted, fontSize: 11, fontWeight: 650, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            <span style={{ height: 1, flex: 1, background: tokens.border }} />
            <span>or</span>
            <span style={{ height: 1, flex: 1, background: tokens.border }} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: tokens.muted, display: "block", marginBottom: 4 }}>Source title (optional)</label>
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Karpathy LLM Wiki gist" />
          </div>
          <div>
            <label style={{ fontSize: 11, color: tokens.muted, display: "block", marginBottom: 4 }}>URL</label>
            <TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/article" />
          </div>
          <div>
            <label style={{ fontSize: 11, color: tokens.muted, display: "block", marginBottom: 4 }}>Paste markdown / text</label>
            <TextArea value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste source content…" rows={8} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={busy}>+ Capture & ingest</Button>
        </div>
        {errorMsg ? <div style={{ marginTop: 14 }}><Callout tone="danger">{errorMsg}</Callout></div> : null}
      </div>
      {createOpen && context.companyId ? (
        <CreateSpaceModal
          companyId={context.companyId}
          existingSlugs={new Set(spaces.map((s) => s.slug))}
          onClose={() => setCreateOpen(false)}
          onCreated={(space) => {
            setCreateOpen(false);
            spacesQuery.refresh();
            hostNavigation.navigate(buildSectionHref("ingest", space.slug));
          }}
        />
      ) : null}
    </div>
  );
}

function SpacePicker({
  spaces,
  activeSpaceSlug,
  loading,
  error,
  isOpen,
  onToggle,
  onClose,
  onSelect,
  onCreate,
}: {
  spaces: WikiSpace[];
  activeSpaceSlug: string;
  loading: boolean;
  error: string | null;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSelect: (slug: string) => void;
  onCreate: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = spaces.find((s) => s.slug === activeSpaceSlug);
  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: MouseEvent) => {
      if (!ref.current) return;
      if (event.target instanceof Node && ref.current.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, onClose]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <label style={{ fontSize: 11, color: tokens.muted, display: "block", marginBottom: 4 }}>Space</label>
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "oklch(0.2 0 0)",
          border: `1px solid ${tokens.border}`,
          borderRadius: 6,
          padding: "8px 10px",
          color: tokens.fg,
          fontFamily: fontStack,
          fontSize: 13,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <FolderIcon size={14} />
        <span style={{ flex: 1, fontWeight: 600 }}>{active?.displayName ?? activeSpaceSlug}</span>
        {active ? (
          <Badge tone="default" style={{ fontSize: 10, padding: "0 6px" }}>{active.accessScope}</Badge>
        ) : null}
        <ChevronDownIcon size={14} />
      </button>
      <div style={{ marginTop: 6, fontSize: 11, color: tokens.muted, lineHeight: 1.4 }}>
        Defaults to the space you opened. Switching now re-routes the page so deep links carry the destination.
      </div>
      {isOpen ? (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 25,
            background: tokens.card,
            border: `1px solid ${tokens.border}`,
            borderRadius: 8,
            boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
            padding: 4,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {error ? <div style={{ padding: 10, fontSize: 12, color: tokens.statusBlocked }}>{error}</div> : null}
          {loading ? <div style={{ padding: 10 }}><Tiny>Loading spaces…</Tiny></div> : null}
          {spaces.map((space) => (
            <button
              key={space.slug}
              type="button"
              role="option"
              aria-selected={space.slug === activeSpaceSlug}
              onClick={() => onSelect(space.slug)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                background: space.slug === activeSpaceSlug ? tokens.accent : "transparent",
                border: "none",
                borderRadius: 6,
                color: tokens.fg,
                fontSize: 13,
                fontFamily: fontStack,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <FolderIcon size={14} />
              <span style={{ flex: 1, fontWeight: 600 }}>{space.displayName}</span>
              <span style={{ fontSize: 10, color: tokens.muted, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{space.slug}</span>
            </button>
          ))}
          <SpaceMenuDivider />
          <button
            type="button"
            onClick={onCreate}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              background: "transparent",
              border: "none",
              borderRadius: 6,
              color: "oklch(0.78 0.13 250)",
              fontSize: 13,
              fontFamily: fontStack,
              cursor: "pointer",
              textAlign: "left",
              fontWeight: 600,
            }}
          >
            <PlusIcon size={14} />
            <span>New shared space…</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function OperationCard({ op }: { op: WikiOperationRow }) {
  return (
    <Card>
      <div style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
          <StatusIcon status={op.status} />
          <strong style={{ flex: "1 1 180px", minWidth: 0, fontSize: 13, overflowWrap: "anywhere" }}>{op.hiddenIssueTitle ?? `LLM Wiki ${op.operationType}`}</strong>
          <Badge tone={statusTone(op.status)} style={{ marginLeft: "auto" }}>{op.status}</Badge>
        </div>
        <Tiny style={{ marginTop: 4 }}>
          {op.operationType.toUpperCase()} · started {formatTime(op.createdAt)} · op-{op.id.slice(0, 6)}
          {op.hiddenIssueIdentifier ? <> · <Mono>{op.hiddenIssueIdentifier}</Mono></> : null}
        </Tiny>
        {Array.isArray(op.warnings) && op.warnings.length > 0 ? (
          <Tiny style={{ marginTop: 4, color: tokens.statusBlocked }}>
            {op.warnings.length} warning{op.warnings.length === 1 ? "" : "s"}
          </Tiny>
        ) : null}
      </div>
    </Card>
  );
}

function statusTone(status: string): Tone {
  if (status === "done") return "done";
  if (status === "running" || status === "in_progress") return "running";
  if (status === "blocked" || status === "failed") return "failed";
  if (status === "queued" || status === "todo") return "todo";
  if (status === "paused") return "paused";
  return "default";
}

// ---------------------------------------------------------------------------
// Ask tab.
// ---------------------------------------------------------------------------

type QueryThreadEntry = {
  id: string;
  prompt: string;
  operationId: string | null;
  querySessionId: string | null;
  hiddenIssueIdentifier: string | null;
  channel: string | null;
  status: "queued" | "running" | "done" | "error";
  createdAt: string;
  answer: string;
  errorMessage?: string;
};

type QueryStreamEvent = {
  type: string;
  operationId?: string;
  querySessionId?: string;
  message?: string | null;
  payload?: Record<string, unknown> | null;
  eventType?: string;
  stream?: string | null;
  answer?: string;
};

function QueryTab({ context, overview }: { context: { companyId: string | null }; overview: OverviewData }) {
  const startQuery = usePluginAction("start-query");
  const fileAsPage = usePluginAction("file-as-page");
  const toast = usePluginToast();
  const { pathname } = useHostLocation();
  const activeSpaceSlug = useMemo(() => readActiveSpaceSlugFromLocation(pathname), [pathname]);
  const isMobile = useIsMobileLayout();
  const [thread, setThread] = useState<QueryThreadEntry[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [filePath, setFilePath] = useState("wiki/concepts/new-page.md");
  const [fileBody, setFileBody] = useState("");
  const [filing, setFiling] = useState<string | null>(null);
  const fileSource = useMemo(() => {
    for (let i = thread.length - 1; i >= 0; i -= 1) {
      const entry = thread[i];
      if (entry.answer.trim()) return entry;
    }
    return null;
  }, [thread]);

  const activeEntry = useMemo(() => {
    for (let i = thread.length - 1; i >= 0; i -= 1) {
      const entry = thread[i];
      if (entry.status === "running" || entry.status === "queued") return entry;
    }
    return null;
  }, [thread]);

  const stream = usePluginStream<QueryStreamEvent>(activeEntry?.channel ?? "llm-wiki:idle", {
    companyId: context.companyId ?? undefined,
  });

  useEffect(() => {
    if (!activeEntry || !stream.lastEvent) return;
    const event = stream.lastEvent;
    setThread((prev) => prev.map((entry) => {
      if (entry.id !== activeEntry.id) return entry;
      if (event.type === "agent.event" && event.eventType === "chunk" && event.message && event.stream !== "stderr") {
        return { ...entry, answer: entry.answer + event.message, status: "running" };
      }
      if (event.type === "query.done") {
        return { ...entry, status: "done", answer: event.answer ?? entry.answer };
      }
      if (event.type === "query.error") {
        return { ...entry, status: "error", errorMessage: event.message ?? "agent session error" };
      }
      return entry;
    }));
    if (event.type === "query.done" && event.answer && !fileBody.trim()) {
      setFileBody(event.answer);
    }
  }, [fileBody, stream.lastEvent, activeEntry?.id]);

  async function send() {
    if (!context.companyId || !prompt.trim()) return;
    setBusy(true);
    const entryId = `q-${Date.now()}`;
    setThread((prev) => [...prev, {
      id: entryId,
      prompt: prompt.trim(),
      operationId: null,
      querySessionId: null,
      hiddenIssueIdentifier: null,
      channel: null,
      status: "queued",
      createdAt: new Date().toISOString(),
      answer: "",
    }]);
    try {
      const res = await startQuery({ companyId: context.companyId, spaceSlug: activeSpaceSlug, question: prompt.trim() });
      const result = res as {
        operationId: string;
        querySessionId?: string;
        channel?: string;
        issue?: { identifier?: string | null };
      };
      setThread((prev) => prev.map((entry) =>
        entry.id === entryId ? {
          ...entry,
          operationId: result.operationId,
          querySessionId: result.querySessionId ?? result.operationId,
          hiddenIssueIdentifier: result.issue?.identifier ?? null,
          channel: result.channel ?? `llm-wiki:query:${result.operationId}`,
          status: "running",
        } : entry,
      ));
      setPrompt("");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setThread((prev) => prev.map((entry) =>
        entry.id === entryId ? { ...entry, status: "error", errorMessage: message } : entry,
      ));
      toast({ tone: "error", title: "Ask failed", body: message });
    } finally {
      setBusy(false);
    }
  }

  async function fileAnswer(entry?: QueryThreadEntry) {
    const source = entry ?? fileSource;
    const answer = fileBody.trim() || source?.answer.trim() || "";
    if (!context.companyId || !filePath.trim() || !answer) return;
    setFiling(source?.id ?? "manual");
    try {
      await fileAsPage({
        companyId: context.companyId,
        wikiId: overview.wikiId,
        spaceSlug: activeSpaceSlug,
        path: filePath.trim(),
        question: source?.prompt,
        answer,
        querySessionId: source?.querySessionId,
      });
      toast({ tone: "success", title: "Answer filed", body: `Wrote ${filePath.trim()} and recorded a file-as-page task.` });
      setFileBody("");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast({ tone: "error", title: "Could not file answer", body: message });
    } finally {
      setFiling(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", flex: 1, minHeight: isMobile ? "auto" : 0, minWidth: 0 }}>
      <div style={{ flex: 1, padding: isMobile ? "16px" : "24px 28px", overflow: isMobile ? "visible" : "auto", minWidth: 0 }}>
        {thread.length === 0 ? (
          <Callout>
            Ask the wiki anything. Each question initiates a task assigned to the Wiki Maintainer. The answer streams below; you can promote useful answers into a wiki page.
          </Callout>
        ) : null}
        <div style={{ display: "grid", gap: 22, marginTop: 18 }}>
          {thread.map((entry) => (
            <div key={entry.id}>
              <Tiny style={{ marginBottom: 4 }}>You · {formatTime(entry.createdAt)}</Tiny>
              <div style={{ background: tokens.card, border: `1px solid ${tokens.border}`, padding: "10px 12px", borderRadius: 8, fontSize: 13 }}>{entry.prompt}</div>
              <Tiny style={{ marginTop: 8 }}>
                Wiki Maintainer · {entry.status}
                {entry.hiddenIssueIdentifier ? <> · <Mono>{entry.hiddenIssueIdentifier}</Mono></> : null}
              </Tiny>
              {entry.status === "error" ? (
                <div style={{ marginTop: 6 }}><Callout tone="danger">{entry.errorMessage}</Callout></div>
              ) : (
                <pre style={{
                  margin: "8px 0 0",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: "ui-sans-serif, system-ui, sans-serif",
                  fontSize: 13,
                  lineHeight: 1.65,
                  color: tokens.fg,
                }}>{entry.answer || (entry.status === "running" ? "Streaming…" : "")}</pre>
              )}
              {entry.answer.trim() && entry.status === "done" ? (
                <div style={{ marginTop: 10, border: `1px dashed ${tokens.border}`, borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 13 }}>📑 File this answer as a wiki page?</strong>
                    <Tiny style={{ marginLeft: isMobile ? 0 : "auto", width: isMobile ? "100%" : undefined }}>Path: <Mono>{filePath}</Mono></Tiny>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <TextInput value={filePath} onChange={(e) => setFilePath(e.target.value)} style={{ maxWidth: isMobile ? "none" : 360 }} />
                    <Button size="sm" variant="primary" onClick={() => fileAnswer(entry)} disabled={!filePath.trim()} loading={filing === entry.id}>Accept &amp; file</Button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div style={{ borderTop: `1px solid ${tokens.border}`, paddingTop: 14, marginTop: 22 }}>
          <TextArea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ask the wiki…" rows={3} />
          <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button variant="primary" size="sm" onClick={send} disabled={!prompt.trim()} loading={busy}>Send (⌘↵)</Button>
            <Badge>Cite: wiki + raw</Badge>
            <Badge>Max steps: 6</Badge>
            <Tiny style={{ marginLeft: "auto" }}>Streamed via agent session · maintainer task</Tiny>
          </div>
        </div>
      </div>
      <aside style={{
        width: isMobile ? "auto" : 320,
        borderLeft: isMobile ? "none" : `1px solid ${tokens.border}`,
        borderTop: isMobile ? `1px solid ${tokens.border}` : "none",
        padding: isMobile ? "16px" : "18px 20px",
        overflow: isMobile ? "visible" : "auto",
        minWidth: 0,
      }}>
        <Tiny style={{ marginBottom: 8 }}>SESSION</Tiny>
        <PropRow label="Wiki" value={overview.wikiId} />
        <PropRow label="Project" value={overview.managedProject.details?.name ?? overview.managedProject.status} />
        <PropRow label="Agent" value={overview.managedAgent.details?.name ?? overview.managedAgent.status} />
        <PropRow label="Operations" value={overview.operationCount} />
        <PropRow label="Stream" value={stream.connected ? "live" : stream.connecting ? "connecting…" : "idle"} />
        <Divider />
        <Tiny style={{ marginBottom: 8 }}>ASK PROMPT</Tiny>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "ui-monospace, monospace", fontSize: 12, color: tokens.muted }}>{overview.prompts.query}</pre>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lint tab.
// ---------------------------------------------------------------------------

function LintTab({ context, overview, refreshOverview }: { context: { companyId: string | null }; overview: OverviewData; refreshOverview: () => void }) {
  const isMobile = useIsMobileLayout();
  return (
    <div style={{ flex: 1, minHeight: isMobile ? "auto" : 0, overflow: isMobile ? "visible" : "auto", padding: isMobile ? "16px" : "24px 28px", display: "grid", gap: isMobile ? 14 : 18, minWidth: 0 }}>
      <LintPanelContent context={context} overview={overview} refreshOverview={refreshOverview} />
    </div>
  );
}

function SettingsLintPanel({ context }: { context: { companyId: string | null } }) {
  const overview = useOverview(context.companyId);

  if (overview.error) {
    return <SettingsPanel title="Lint" badge={<HiddenOpBadge />} description="Run structural checks for orphan pages, missing backlinks, and stale provenance.">
      <Callout tone="danger">LLM Wiki bridge error: {overview.error.message}</Callout>
    </SettingsPanel>;
  }

  if (!overview.data) {
    return <SettingsPanel title="Lint" badge={<HiddenOpBadge />} description="Run structural checks for orphan pages, missing backlinks, and stale provenance.">
      <Tiny>Loading lint controls…</Tiny>
    </SettingsPanel>;
  }

  return (
    <SettingsPanel
      title="Lint"
      badge={<HiddenOpBadge />}
      description="Run structural checks for orphan pages, missing backlinks, and stale provenance."
    >
      <LintPanelContent context={context} overview={overview.data} refreshOverview={overview.refresh} showHeading={false} />
    </SettingsPanel>
  );
}

function LintPanelContent({
  context,
  overview,
  refreshOverview,
  showHeading = true,
}: {
  context: { companyId: string | null };
  overview: OverviewData;
  refreshOverview: () => void;
  showHeading?: boolean;
}) {
  const create = usePluginAction("create-operation");
  const { pathname } = useHostLocation();
  const activeSpaceSlug = useMemo(() => readActiveSpaceSlugFromLocation(pathname), [pathname]);
  const operations = useOperations(context.companyId, { operationType: "lint", spaceSlug: activeSpaceSlug });
  const toast = usePluginToast();
  const isMobile = useIsMobileLayout();
  const [busy, setBusy] = useState(false);

  async function runLint() {
    if (!context.companyId) return;
    setBusy(true);
    try {
      await create({
        companyId: context.companyId,
        spaceSlug: activeSpaceSlug,
        operationType: "lint",
        title: `Run LLM Wiki lint · ${activeSpaceSlug}`,
        prompt: overview.prompts.lint,
      });
      toast({ tone: "success", title: "Lint queued", body: "Lint runs as a Wiki Maintainer task. Findings will appear here once the run completes." });
      operations.refresh();
      refreshOverview();
    } catch (err) {
      toast({ tone: "error", title: "Could not run lint", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const recent = operations.data?.operations ?? [];
  const latestDone = recent.find((op) => op.status === "done");
  const findings = Array.isArray(latestDone?.warnings) ? (latestDone!.warnings as Record<string, unknown>[]) : [];
  const counts = aggregateLintFindings(findings);

  return (
    <div style={{ display: "grid", gap: isMobile ? 14 : 18, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {showHeading ? <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Lint</h2> : null}
        <Badge style={unfilledSurfaceStyle}>{recent.length} run{recent.length === 1 ? "" : "s"}</Badge>
        <Button variant="primary" size="sm" onClick={runLint} loading={busy} style={{ marginLeft: isMobile ? 0 : "auto" }}>▶ Run lint now</Button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
        <StatCard label="Findings" value={String(counts.total)} hint={latestDone ? `last run ${formatTime(latestDone.createdAt)}` : "no runs yet"} />
        <StatCard label="Critical" value={String(counts.critical)} hint="contradictions / conflict" tone={counts.critical > 0 ? "danger" : undefined} />
        <StatCard label="Orphans" value={String(counts.orphan)} hint="no inbound backlinks" />
        <StatCard label="Stale" value={String(counts.stale)} hint="provenance > 30d" />
        <StatCard label="Index drift" value={String(counts.index)} hint="wiki/index.md / wiki/log.md" />
      </div>
      <Card style={unfilledSurfaceStyle}>
        <CardHeader title="Findings" badges={<HiddenOpBadge />} right={<Tiny>Lint runs as a Wiki Maintainer task. Critical findings can optionally open visible follow-up issues — toggle in Settings → Lint policy.</Tiny>} />
        <CardBody padding={0}>
          {findings.length === 0 ? (
            <div style={{ padding: 16, color: tokens.muted, fontSize: 13 }}>
              {latestDone ? "Latest lint run reported no findings." : "No completed lint runs yet. Use ▶ Run lint now to start one."}
            </div>
          ) : findings.map((f, idx) => {
            const severityTone: Tone = f.severity === "critical" ? "failed" : f.severity === "orphan" ? "paused" : "default";
            return (
              <Row
                key={idx}
                primary={
                  <span>
                    <Badge tone={severityTone} style={severityTone === "default" ? unfilledSurfaceStyle : undefined}>
                      {String(f.severity ?? "info")}
                    </Badge>
                    <span style={{ marginLeft: 8 }}>{String(f.message ?? f.title ?? "(no description)")}</span>
                  </span>
                }
                secondary={f.path ? <Mono>{String(f.path)}</Mono> : null}
              />
            );
          })}
        </CardBody>
      </Card>
      <Card style={unfilledSurfaceStyle}>
        <CardHeader title="Recent lint runs" />
        <CardBody padding={0}>
          {recent.length === 0 ? <div style={{ padding: 12, color: tokens.muted, fontSize: 13 }}>No lint runs yet.</div> : recent.map((op) => (
            <Row
              key={op.id}
              primary={<><Mono>op-{op.id.slice(0, 6)}</Mono> {op.hiddenIssueTitle ?? "Wiki lint"}</>}
              secondary={formatTime(op.createdAt)}
              right={<Badge tone={statusTone(op.status)}>{op.status}</Badge>}
            />
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

function StatCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "danger" | "warn" }) {
  const palette = tone === "danger" ? { color: "oklch(0.7 0.2 25)" } : tone === "warn" ? { color: "oklch(0.85 0.1 70)" } : { color: tokens.fg };
  return (
    <Card style={{ ...unfilledSurfaceStyle, padding: 14 }}>
      <Tiny>{label.toUpperCase()}</Tiny>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, ...palette }}>{value}</div>
      {hint ? <Tiny style={{ marginTop: 2 }}>{hint}</Tiny> : null}
    </Card>
  );
}

function aggregateLintFindings(findings: Record<string, unknown>[]): { total: number; critical: number; orphan: number; stale: number; index: number } {
  const counts = { total: findings.length, critical: 0, orphan: 0, stale: 0, index: 0 };
  for (const f of findings) {
    const sev = String(f.severity ?? "");
    if (sev === "critical") counts.critical += 1;
    else if (sev === "orphan") counts.orphan += 1;
    else if (sev === "stale") counts.stale += 1;
    else if (sev === "index") counts.index += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// History tab: native Paperclip issue table for recent LLM Wiki operation
// issues. Each plugin run is represented by an issue, so the standard issue
// history view is the right surface here.
// ---------------------------------------------------------------------------

function formatCostCents(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function runStatusTone(status: string): Tone {
  if (status === "running") return "running";
  if (status === "succeeded" || status === "completed" || status === "done") return "done";
  if (status === "failed" || status === "refused_cost_cap") return "failed";
  if (status === "review_required") return "in_review";
  if (status === "paused") return "paused";
  if (status === "source_ready" || status === "queued") return "queued";
  return "default";
}

function runStatusLabel(status: string): string {
  switch (status) {
    case "review_required":
      return "review required";
    case "refused_cost_cap":
      return "cost capped";
    case "source_ready":
      return "source ready";
    default:
      return status.replace(/_/g, " ");
  }
}

function HistoryTab({ context, overview }: { context: { companyId: string | null; companyPrefix?: string | null }; overview: OverviewData }) {
  const isMobile = useIsMobileLayout();
  const projectId = overview.managedProject.projectId;
  const originKindPrefix = `plugin:${PLUGIN_ID}:operation`;

  if (!context.companyId) {
    return <div style={{ padding: isMobile ? 16 : 24, flex: 1 }}><Callout>Choose a company to view LLM Wiki history.</Callout></div>;
  }

  if (!projectId) {
    return (
      <div style={{ padding: isMobile ? 16 : 24, flex: 1 }}>
        <Callout tone="warn">The LLM Wiki operations project is not resolved yet. Reconcile the managed project in Settings, then history will show its issues here.</Callout>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: isMobile ? "auto" : 0, overflow: isMobile ? "visible" : "auto", padding: isMobile ? 12 : 0, minWidth: 0 }}>
      <PluginIssuesList
        companyId={context.companyId}
        projectId={projectId}
        filters={{ originKindPrefix }}
        viewStateKey="paperclip:llm-wiki-history-issues-view"
        searchWithinLoadedIssues
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings (tab) and the standalone host SettingsPage share this body.
// ---------------------------------------------------------------------------

function SettingsTab({ context, initialSection = "root" }: { context: { companyId: string | null; companyPrefix?: string | null }; initialSection?: SettingsSectionKey }) {
  const isMobile = useIsMobileLayout();
  return (
    <div style={{ flex: 1, minHeight: isMobile ? "auto" : 0, overflow: isMobile ? "visible" : "auto", padding: isMobile ? "16px" : "24px 28px", minWidth: 0 }}>
      <SettingsBody context={context} initialSection={initialSection} />
    </div>
  );
}

const ROUTINE_FALLBACKS: Record<string, { title: string; cron: string }> = {
  "cursor-window-processing": { title: "Process LLM Wiki updates", cron: "0 */6 * * *" },
  "nightly-wiki-lint": { title: "Run LLM Wiki lint", cron: "0 3 * * *" },
  "index-refresh": { title: "Refresh LLM Wiki index", cron: "0 * * * *" },
};

const MANAGED_SKILL_LABELS: Record<string, string> = {
  "wiki-maintainer": "LLM Wiki Maintainer",
  "wiki-ingest": "Wiki Ingest",
  "wiki-query": "Wiki Query",
  "wiki-lint": "Wiki Lint",
  "paperclip-distill": "Paperclip Distill",
  "index-refresh": "Index Refresh",
};

function routineFallbackFor(routine: ManagedRoutine) {
  const key = routine.resourceKey?.split(":").pop() ?? "";
  return ROUTINE_FALLBACKS[key] ?? { title: routine.resourceKey ?? "Managed routine", cron: "—" };
}

function managedRoutineStatus(routine: ManagedRoutine) {
  return routine.routine?.status ?? routine.details?.status ?? (routine.routineId ? "paused" : "missing");
}

type RoutineHealthItem = {
  label: string;
  ok: boolean;
  detail: string;
};

function routineResourceKey(routine: ManagedRoutine) {
  return routine.resourceKey?.split(":").pop() ?? "";
}

function managedAgentIsReady(resource: ManagedAgent) {
  return resource.source === "managed" && Boolean(resource.agentId);
}

function managedProjectIsReady(resource: ManagedProject) {
  return resource.source === "managed" && Boolean(resource.projectId);
}

function managedSkillIsReady(resource: ManagedSkill) {
  return resource.status !== "missing" && Boolean(resource.skillId);
}

function managedResourceKey(resourceKey?: string | null) {
  return resourceKey?.split(":").pop() ?? "";
}

function skillLabel(resource: ManagedSkill) {
  const declaredLabel = MANAGED_SKILL_LABELS[managedResourceKey(resource.resourceKey)];
  return declaredLabel ?? resource.details?.name ?? resource.skill?.name ?? "Managed skill";
}

function buildAgentHealthItems(managedAgent: ManagedAgent): RoutineHealthItem[] {
  const agentName = managedAgent.details?.name ?? "Wiki Maintainer";
  return [{
    label: agentName,
    ok: managedAgentIsReady(managedAgent) && !managedAgent.defaultDrift?.changedFiles.length,
    detail: managedAgent.source === "managed"
      ? managedAgent.defaultDrift?.changedFiles.length
        ? `The Wiki Maintainer instructions differ from the plugin default: ${managedAgent.defaultDrift.changedFiles.join(", ")}.`
        : "The plugin-managed Wiki Maintainer exists with current default instructions."
      : "The settings page is using a selected maintainer instead of the plugin-managed Wiki Maintainer.",
  }];
}

function buildProjectHealthItems(managedProject: ManagedProject): RoutineHealthItem[] {
  const projectName = managedProject.details?.name ?? "LLM Wiki";
  return [{
    label: projectName,
    ok: managedProjectIsReady(managedProject),
    detail: managedProject.source === "managed"
      ? "The plugin-managed LLM Wiki project exists."
      : "The settings page is using a selected project instead of the plugin-managed LLM Wiki project.",
  }];
}

function buildSkillHealthItems(skills: ManagedSkill[]): RoutineHealthItem[] {
  if (skills.length === 0) {
    return [{
      label: "Managed skill",
      ok: false,
      detail: "No plugin-managed skills are installed in the company skill library.",
    }];
  }
  return skills.map((skill) => ({
    label: skillLabel(skill),
    ok: managedSkillIsReady(skill) && !skill.defaultDrift?.changedFiles.length,
    detail: managedSkillIsReady(skill)
      ? skill.defaultDrift?.changedFiles.length
        ? `${skillLabel(skill)} differs from the plugin default: ${skill.defaultDrift.changedFiles.join(", ")}.`
        : `${skillLabel(skill)} is installed in the company skill library.`
      : `${skillLabel(skill)} is not installed in the company skill library.`,
  }));
}

function buildRoutineHealthItems(
  routines: ManagedRoutine[],
  managedAgent: ManagedAgent,
  managedProject: ManagedProject,
): RoutineHealthItem[] {
  const routineByKey = new Map(routines.map((routine) => [routineResourceKey(routine), routine]));
  const expectedAgentId = managedAgent.source === "managed" ? managedAgent.agentId ?? null : null;
  const expectedProjectId = managedProject.source === "managed" ? managedProject.projectId ?? null : null;
  const items: RoutineHealthItem[] = [];

  for (const [key, fallback] of Object.entries(ROUTINE_FALLBACKS)) {
    const routine = routineByKey.get(key);
    const routineAgentId = routine?.routine?.assigneeAgentId ?? null;
    const routineProjectId = routine?.routine?.projectId ?? null;
    const missingRefs = routine?.missingRefs ?? [];
    const missing = !routine?.routineId || !routine.routine;
    const wrongAgent = Boolean(expectedAgentId && routineAgentId && routineAgentId !== expectedAgentId);
    const wrongProject = Boolean(expectedProjectId && routineProjectId && routineProjectId !== expectedProjectId);
    const missingAgent = Boolean(expectedAgentId && !routineAgentId);
    const missingProject = Boolean(expectedProjectId && !routineProjectId);
    const blockedByManagedResources = !expectedAgentId || !expectedProjectId;
    const ok = Boolean(routine && !missing && missingRefs.length === 0 && !wrongAgent && !wrongProject && !missingAgent && !missingProject && !blockedByManagedResources);
    let detail = `${fallback.title} is installed with the Wiki Maintainer and LLM Wiki project.`;
    if (missing) {
      detail = `${fallback.title} is not installed.`;
    } else if (missingRefs.length > 0) {
      detail = `${fallback.title} cannot resolve ${missingRefs.map((ref) => `${ref.resourceKind}:${ref.resourceKey}`).join(", ")}.`;
    } else if (blockedByManagedResources) {
      detail = `${fallback.title} cannot be validated until the managed agent and project are restored.`;
    } else if (wrongAgent || missingAgent) {
      detail = `${fallback.title} is not assigned to the Wiki Maintainer.`;
    } else if (wrongProject || missingProject) {
      detail = `${fallback.title} is not attached to the LLM Wiki project.`;
    }
    items.push({ label: fallback.title, ok, detail });
  }

  return items;
}

function RoutineHealthChecklist({ items }: { items: RoutineHealthItem[] }) {
  return (
    <ManagedResourceHealthChecklist
      items={items}
      ariaLabel="Wiki routines health checklist"
      heading="Routine health"
    />
  );
}

function ManagedResourceHealthChecklist({
  items,
  ariaLabel,
  heading,
}: {
  items: RoutineHealthItem[];
  ariaLabel: string;
  heading: string;
}) {
  return (
    <div style={{ display: "grid", gap: 8 }} aria-label={ariaLabel}>
      <div style={{ fontSize: 12, fontWeight: 650, color: tokens.muted }}>{heading}</div>
      <div role="list" style={{ position: "relative", display: "grid", gap: 0, padding: "2px 0" }}>
        {items.length > 1 ? (
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 8,
              top: 12,
              bottom: 12,
              width: 1,
              background: "oklch(0.38 0.09 145)",
            }}
          />
        ) : null}
        {items.map((item) => (
          <div
            key={item.label}
            role="listitem"
            title={item.detail}
            style={{
              display: "grid",
              gridTemplateColumns: "18px minmax(0, 1fr)",
              alignItems: "center",
              gap: 10,
              padding: "7px 0",
              minWidth: 0,
            }}
          >
            <span style={{ display: "inline-flex", justifyContent: "center", position: "relative", zIndex: 1, background: tokens.bg }}>
              <StatusIcon status={item.ok ? "done" : "blocked"} />
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: item.ok ? tokens.fg : "oklch(0.85 0.1 70)" }}>
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SkillHealthChecklist({ items }: { items: RoutineHealthItem[] }) {
  return (
    <ManagedResourceHealthChecklist
      items={items}
      ariaLabel="Wiki skills health checklist"
      heading="Skill health"
    />
  );
}

type SettingsSectionKey = "root" | "spaces" | "distillation" | "routines" | "lint" | "events";

const SETTINGS_SECTIONS: ReadonlyArray<{
  key: SettingsSectionKey;
  label: string;
  description: string;
}> = [
  { key: "root", label: "Setup", description: "" },
  { key: "spaces", label: "Spaces", description: "Destination spaces - folders, slugs, and folder health. Per-space Paperclip indexing is not configurable yet." },
  { key: "distillation", label: "Distillation", description: "Paperclip -> default space. Cursors, caps, and routines for the company-wide distillation pipeline." },
  { key: "routines", label: "Managed Routines", description: "Scheduled wiki maintenance." },
  { key: "lint", label: "Lint", description: "Run checks and review wiki health findings." },
  { key: "events", label: "Ingestion Settings", description: "Paperclip event capture into the default space (issues, comments, documents)." },
];

function SettingsSectionButton({
  section,
  active,
  onSelect,
}: {
  section: (typeof SETTINGS_SECTIONS)[number];
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      style={{
        width: "100%",
        border: `1px solid ${active ? tokens.border : "transparent"}`,
        borderRadius: 6,
        background: "transparent",
        color: active ? tokens.fg : tokens.muted,
        cursor: "pointer",
        display: "grid",
        gap: 2,
        padding: "8px 10px",
        textAlign: "left",
        fontFamily: fontStack,
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{section.label}</span>
      {section.description ? (
        <span style={{ fontSize: 11, lineHeight: 1.35, overflowWrap: "anywhere" }}>{section.description}</span>
      ) : null}
    </button>
  );
}

function SettingsPanel({
  title,
  badge,
  description,
  children,
}: {
  title: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <header style={{ display: "grid", gap: 6, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650, overflowWrap: "anywhere" }}>{title}</h2>
          {badge}
        </div>
        {description ? <Tiny>{description}</Tiny> : null}
      </header>
      <div style={{ minWidth: 0 }}>{children}</div>
    </section>
  );
}

function SetupSection({ title, children, separated = false }: { title: ReactNode; children: ReactNode; separated?: boolean }) {
  return (
    <section style={{ display: "grid", gap: 12, minWidth: 0, paddingTop: separated ? 22 : 0, borderTop: separated ? `1px solid ${tokens.border}` : "none" }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>{title}</h2>
      <div style={{ minWidth: 0 }}>{children}</div>
    </section>
  );
}

type PathPlatform = "mac" | "windows" | "linux";

const PATH_PLATFORM_LABELS: Record<PathPlatform, string> = {
  mac: "macOS",
  windows: "Windows",
  linux: "Linux",
};

const PATH_PLATFORM_STEPS: Record<PathPlatform, string[]> = {
  mac: [
    "Open Finder and navigate to the folder.",
    "Control-click the folder.",
    "Hold Option, choose Copy as Pathname, then paste it here.",
  ],
  windows: [
    "Open File Explorer and navigate to the folder.",
    "Click the address bar to reveal the full path.",
    "Copy the path and paste it here.",
  ],
  linux: [
    "Open a terminal in the directory.",
    "Run pwd to print the full path.",
    "Copy the output and paste it here.",
  ],
};

function detectPathPlatform(): PathPlatform {
  if (typeof navigator === "undefined") return "mac";
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes("win")) return "windows";
  if (agent.includes("linux")) return "linux";
  return "mac";
}

function PathInstructionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [platform, setPlatform] = useState<PathPlatform>(detectPathPlatform);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(0, 0, 0, 0.48)",
        display: "grid",
        placeItems: "center",
        padding: 18,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wiki-path-help-title"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(460px, 100%)",
          border: `1px solid ${tokens.border}`,
          borderRadius: 8,
          background: tokens.card,
          color: tokens.fg,
          boxShadow: "0 24px 70px rgba(0, 0, 0, 0.45)",
          padding: 18,
          display: "grid",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
          <div style={{ display: "grid", gap: 4 }}>
            <h3 id="wiki-path-help-title" style={{ margin: 0, fontSize: 15, fontWeight: 650 }}>Get a full folder path</h3>
            <Tiny>Paste an absolute path such as <Mono>/Users/you/company-wiki</Mono>.</Tiny>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} title="Close path help">Close</Button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, border: `1px solid ${tokens.border}`, borderRadius: 7, padding: 3 }}>
          {(Object.keys(PATH_PLATFORM_LABELS) as PathPlatform[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setPlatform(key)}
              style={{
                border: 0,
                borderRadius: 5,
                background: key === platform ? tokens.accent : "transparent",
                color: key === platform ? tokens.fg : tokens.muted,
                padding: "6px 8px",
                cursor: "pointer",
                fontSize: 12,
                fontFamily: fontStack,
              }}
            >
              {PATH_PLATFORM_LABELS[key]}
            </button>
          ))}
        </div>
        <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8, fontSize: 13, lineHeight: 1.45 }}>
          {PATH_PLATFORM_STEPS[platform].map((step) => <li key={step}>{step}</li>)}
        </ol>
      </div>
    </div>
  );
}

function FolderPathPicker({
  value,
  onChange,
  onApply,
  applyLabel,
  busy,
  disabled,
  onRefresh,
}: {
  value: string;
  onChange: (value: string) => void;
  onApply: () => void;
  applyLabel: string;
  busy?: boolean;
  disabled?: boolean;
  onRefresh?: () => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div style={{
      border: `1px solid ${tokens.border}`,
      borderRadius: 8,
      background: "oklch(0.18 0 0)",
      overflow: "hidden",
      minWidth: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: `1px solid ${tokens.border}` }}>
        <span aria-hidden style={{
          width: 28,
          height: 28,
          borderRadius: 7,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: tokens.accent,
          color: tokens.pluginFg,
          flexShrink: 0,
        }}>
          <FolderOpenIcon />
        </span>
        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 650 }}>Local wiki folder</span>
          <Tiny>Absolute path on this machine</Tiny>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, padding: 12, alignItems: "center", flexWrap: "wrap" }}>
        <TextInput
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="/absolute/path/to/wiki-root"
          style={{ flex: "1 1 320px", fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
        />
        <Button size="sm" onClick={() => setHelpOpen(true)}><FolderOpenIcon size={13} /> Choose</Button>
        <Button variant="primary" size="sm" onClick={onApply} loading={busy} disabled={disabled || !value.trim()}>{applyLabel}</Button>
        {onRefresh ? <Button size="sm" variant="ghost" onClick={onRefresh}>Run health check</Button> : null}
      </div>
      <PathInstructionsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

type FolderHealthItem = {
  label: string;
  ok: boolean;
};

function folderHealthItems(folder: FolderStatus): FolderHealthItem[] {
  return [
    { label: "Path configured", ok: folder.configured },
    { label: "Readable", ok: folder.readable },
    { label: folder.access === "readWrite" ? "Writable" : "Read-only access", ok: folder.access === "read" || folder.writable },
    { label: "Baseline files", ok: folder.missingFiles.length === 0 },
    { label: "Wiki folders", ok: folder.missingDirectories.length === 0 },
  ];
}

function FolderHealthChecklist({ folder }: { folder: FolderStatus }) {
  const items = folderHealthItems(folder);
  return (
    <div style={{ display: "grid", gap: 8 }} aria-label="Wiki root health checklist">
      <div style={{ fontSize: 12, fontWeight: 650, color: tokens.muted }}>Health check</div>
      <div role="list" style={{ position: "relative", display: "grid", gap: 0, padding: "2px 0" }}>
        {items.length > 1 ? (
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 8,
              top: 12,
              bottom: 12,
              width: 1,
              background: "oklch(0.38 0.09 145)",
            }}
          />
        ) : null}
        {items.map((item) => (
          <div
            key={item.label}
            role="listitem"
            style={{
              display: "grid",
              gridTemplateColumns: "18px minmax(0, 1fr)",
              alignItems: "center",
              gap: 10,
              padding: "7px 0",
              minWidth: 0,
            }}
          >
            <span style={{ display: "inline-flex", justifyContent: "center", position: "relative", zIndex: 1, background: tokens.bg }}>
              <StatusIcon status={item.ok ? "done" : "blocked"} />
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: item.ok ? tokens.fg : "oklch(0.85 0.1 70)" }}>
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

type MaintainerAgentOption = SettingsData["agentOptions"][number];
type ProjectOption = SettingsData["projectOptions"][number];

function agentStatusLabel(status?: string | null) {
  if (!status) return "unknown";
  return status.replace(/_/g, " ");
}

function projectStatusLabel(status?: string | null) {
  if (!status) return "unknown";
  return status.replace(/_/g, " ");
}

function adapterTypeLabel(adapterType?: string | null) {
  if (!adapterType) return "unknown adapter";
  return adapterType.replace(/_/g, " ");
}

function agentAvatarGlyph(icon?: string | null, name?: string | null) {
  if (icon === "book-open") return "📖";
  return (name?.trim().charAt(0) || "A").toUpperCase();
}

function AgentAvatar({ agent, size = 30 }: { agent: Pick<MaintainerAgentOption, "name" | "icon">; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        border: `1px solid ${tokens.border}`,
        background: tokens.accent,
        color: tokens.fg,
        fontSize: size > 28 ? 14 : 12,
        fontWeight: 700,
      }}
    >
      {agentAvatarGlyph(agent.icon, agent.name)}
    </span>
  );
}

function AgentOptionLabel({ agent, muted = false }: { agent: MaintainerAgentOption; muted?: boolean }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <AgentAvatar agent={agent} />
      <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: muted ? tokens.muted : tokens.fg, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {agent.name}
        </span>
        <span style={{ fontSize: 11, color: tokens.muted, textTransform: "capitalize" }}>
          {agentStatusLabel(agent.status)} · {adapterTypeLabel(agent.adapterType)}
        </span>
      </span>
    </span>
  );
}

function MaintainerAgentLink({
  agent,
  hrefProps,
}: {
  agent: MaintainerAgentOption;
  hrefProps?: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "style">;
}) {
  return (
    <a
      {...hrefProps}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        maxWidth: "100%",
        color: tokens.fg,
        textDecoration: "none",
      }}
    >
      <AgentAvatar agent={agent} />
      <span style={{ display: "grid", gap: 1, minWidth: 0, textAlign: "left" }}>
        <span style={{ fontSize: 13, fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          Resolve agent wiki maintainer
        </span>
        <span style={{ fontSize: 11, color: tokens.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {agent.name} · {agentStatusLabel(agent.status)} · {adapterTypeLabel(agent.adapterType)}
        </span>
      </span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Distillation settings panel (configured + unconfigured states).
// Source filters / cursor windows / model lanes / auto-apply / backfill.
// Most controls render the current state; persistence is wired through
// existing managed-routine and plugin-action endpoints.
// ---------------------------------------------------------------------------

function DistillationSettingsPanel({ context, settings }: { context: { companyId: string | null }; settings: SettingsData }) {
  const overview = useDistillationOverview(context.companyId);
  const distillNow = usePluginAction("distill-paperclip-now");
  const enableActiveProjects = usePluginAction("enable-paperclip-distillation-active-projects");
  const queueBackfill = usePluginAction("backfill-paperclip-distillation");
  const toast = usePluginToast();
  const isMobile = useIsMobileLayout();
  const [busy, setBusy] = useState<string | null>(null);
  const data = overview.data;
  const cursors = data?.cursors ?? [];
  const counts = data?.counts ?? { cursors: 0, runningRuns: 0, failedRuns24h: 0, reviewRequired: 0 };
  const isConfigured = cursors.length > 0;
  const autoApplyRestriction = settings.distillationPolicy?.autoApplyRestriction ?? null;
  const [useCheapPath, setUseCheapPath] = useState(true);

  const projectsCovered = useMemo(() => {
    const set = new Set<string>();
    for (const cursor of cursors) {
      if (cursor.projectId) set.add(cursor.projectId);
    }
    return set.size;
  }, [cursors]);

  async function runDistillNow() {
    if (!context.companyId) return;
    if (cursors.length === 0) {
      toast({ tone: "warn", title: "Distill now needs at least one cursor" });
      return;
    }
    setBusy("distill-now");
    try {
      await distillNow({
        companyId: context.companyId,
        useCheapModelProfile: useCheapPath,
        idempotencyKey: `manual:company:${Date.now()}`,
      });
      toast({
        tone: "success",
        title: "Distill now queued",
        body: "Wiki Maintainer will scan changed projects in the company and write into the default wiki space.",
      });
      overview.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Distill now failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  async function enableForActiveProjects() {
    if (!context.companyId) return;
    setBusy("enable-active-projects");
    try {
      const result = await enableActiveProjects({ companyId: context.companyId, limit: 3 }) as {
        selectedProjects?: Array<{ name?: string | null }>;
      };
      const count = result.selectedProjects?.length ?? 0;
      toast({
        tone: count > 0 ? "success" : "warn",
        title: count > 0 ? "Distillation enabled" : "No active projects found",
        body: count > 0
          ? `${count} active project${count === 1 ? "" : "s"} added to the distillation cursor set.`
          : "Create or resume a project, then enable distillation again.",
      });
      overview.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Enable distillation failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  async function runBackfill() {
    if (!context.companyId || cursors.length === 0) return;
    const target = cursors.find((cursor) => cursor.projectId) ?? cursors[0];
    if (!target.projectId && !target.rootIssueId) {
      toast({ tone: "warn", title: "Backfill needs a project or root issue scope" });
      return;
    }
    setBusy("backfill");
    try {
      await queueBackfill({
        companyId: context.companyId,
        projectId: target.projectId ?? undefined,
        rootIssueId: target.rootIssueId ?? undefined,
        useCheapModelProfile: useCheapPath,
      });
      toast({ tone: "success", title: "Backfill queued", body: target.projectName ?? target.rootIssueIdentifier ?? "Selected scope" });
      overview.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Backfill failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  if (overview.loading && !data) {
    return <Tiny>Loading distillation overview…</Tiny>;
  }

  if (!isConfigured) {
    return (
      <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
        <Card>
          <CardBody padding={isMobile ? 18 : 26}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
              <SparklesIcon size={36} />
              <div>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 650 }}>Distillation is off</h3>
                <Tiny style={{ marginTop: 6, fontSize: 13, color: tokens.fg, lineHeight: 1.55, maxWidth: 540 }}>
                  When enabled, the Wiki Maintainer reads Paperclip issues, comments, and documents for this
                  company and keeps <Mono>wiki/projects/&lt;slug&gt;/standup.md</Mono> plus <Mono>wiki/projects/&lt;slug&gt;/index.md</Mono> pages in the
                  <strong> default wiki space</strong>. Pages stay marked stale until a cursor window succeeds -
                  they never imply live state.
                </Tiny>
                <Tiny style={{ marginTop: 6, fontSize: 13, color: tokens.fg, lineHeight: 1.55, maxWidth: 540 }}>
                  Other spaces do not receive Paperclip-derived pages yet. They stay on manual and raw-file
                  ingest until per-space Paperclip ingestion profiles ship.
                </Tiny>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button variant="primary" size="md" onClick={enableForActiveProjects} loading={busy === "enable-active-projects"}>
                  <SparklesIcon size={14} /> Enable for active projects
                </Button>
                <Button variant="default" size="md" onClick={() => overview.refresh()}>Configure manually</Button>
              </div>
              <Tiny>Suggested defaults: 3 active projects in the default space · all-section auto-apply where allowed · routines paused for 24h.</Tiny>
            </div>
          </CardBody>
        </Card>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr" }}>
          <Card>
            <CardHeader title="What gets created" />
            <CardBody padding={14}>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: tokens.muted, lineHeight: 1.5 }}>
                <li>Project overviews at <Mono>wiki/projects/&lt;slug&gt;/index.md</Mono></li>
                <li>Executive standups at <Mono>wiki/projects/&lt;slug&gt;/standup.md</Mono></li>
                <li>Decisions and history under <Mono>wiki/projects/&lt;slug&gt;/</Mono></li>
                <li>Source bundles cached under <Mono>raw/distill/</Mono></li>
              </ul>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="What it never does" />
            <CardBody padding={14}>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: tokens.muted, lineHeight: 1.5 }}>
                <li>Read across companies — strict per-company isolation.</li>
                <li>Re-distill its own plugin operation issues.</li>
                <li>Auto-apply patches when source hashes drift.</li>
              </ul>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      {autoApplyRestriction ? (
        <Callout tone="warn">
          {autoApplyRestriction} The plugin ignores auto-apply requests from config and manual distill actions on this instance.
        </Callout>
      ) : null}
      <Callout>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <InfoIcon size={16} />
            <strong style={{ fontSize: 13 }}>Active for {projectsCovered} project{projectsCovered === 1 ? "" : "s"} · {counts.cursors} cursor{counts.cursors === 1 ? "" : "s"} catching up · default space</strong>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="ghost" size="sm" onClick={() => overview.refresh()}><RefreshIcon size={12} /> Refresh</Button>
            <Button variant="primary" size="sm" onClick={runDistillNow} loading={busy === "distill-now"}><SparklesIcon size={12} /> Distill now</Button>
          </div>
        </div>
        <Tiny style={{ marginTop: 6 }}>
          Distillation runs on the assigned Wiki Maintainer agent and writes only into the default
          space. Use the cheap path option when the agent exposes a cheap model profile.
        </Tiny>
      </Callout>

      <Card>
        <CardHeader title="Source filters" />
        <CardBody padding={14}>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16 }}>
            <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
              <legend style={{ fontSize: 12, color: tokens.muted, marginBottom: 4 }}>Issue scope</legend>
              <CheckboxRow label="Active projects" defaultChecked help="Cursors are created for projects with recent activity." />
              <CheckboxRow label="Root issues marked distillable" defaultChecked />
              <CheckboxRow label="All company issues" help="May create large source windows." />
              <Tiny>
                These filters narrow the Paperclip source scope. The destination is always the default
                wiki space in Phase 1.
              </Tiny>
              <Tiny>Plugin-operation issues are always excluded to prevent feedback loops.</Tiny>
            </fieldset>
            <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
              <legend style={{ fontSize: 12, color: tokens.muted, marginBottom: 4 }}>Source kinds</legend>
              <CheckboxRow label="Issue title + description" defaultChecked locked />
              <CheckboxRow label="Comments (ranked, clipped)" defaultChecked />
              <CheckboxRow label="Documents (plan, spec, report)" defaultChecked />
              <CheckboxRow label="Work products / attachments" suffix="coming soon" />
              <Tiny>Heartbeats and hidden documents are never included.</Tiny>
            </fieldset>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Cursor windows" />
        <CardBody padding={14}>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16 }}>
            <SettingField label="Max source characters per project" hint="Source bundles above this size are clipped and the page warns 'source clipped'.">
              <TextInput defaultValue="48000" />
            </SettingField>
            <SettingField label="Min source age before processing" hint="Debounces a hot project so a flurry of comments collapses into one cursor window.">
              <SelectInput defaultValue="15" options={[["5", "5 min"], ["15", "15 min"], ["30", "30 min"], ["60", "1 hour"]]} />
            </SettingField>
            <SettingField label="Max cursor windows per routine run" hint="Routine runs that hit this cap split the remainder into the next routine fire.">
              <TextInput defaultValue="6" />
            </SettingField>
            <SettingField label="Stale window threshold" hint="After this, project pages render a 'Stale' badge until a successful run advances the cursor.">
              <SelectInput defaultValue="72" options={[["24", "24 h"], ["48", "48 h"], ["72", "72 h"], ["168", "7 days"]]} />
            </SettingField>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Agent execution" />
        <CardBody padding={14}>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16 }}>
            <SettingField label="Assigned maintainer" hint="Model selection comes from the agent adapter and its runtime config. The plugin does not choose Claude/Codex/Gemini models here.">
              <div style={{ minHeight: 34, display: "flex", alignItems: "center", border: `1px solid ${tokens.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 13 }}>
                {settings.managedAgent.details
                  ? `${settings.managedAgent.details.name} · ${adapterTypeLabel(settings.managedAgent.details.adapterType)}`
                  : "No maintainer agent resolved"}
              </div>
            </SettingField>
            <SettingField label="Cheap path" hint="When enabled, manual distill and backfill operation issues request assigneeAdapterOverrides.modelProfile = cheap.">
              <CheckboxRow
                label="Request the assigned agent's cheap model profile for distillation tasks"
                checked={useCheapPath}
                onChange={setUseCheapPath}
              />
            </SettingField>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Auto-apply policy" />
        <CardBody padding={14}>
          <div style={{ display: "grid", gap: 8 }}>
            <RadioRow name="autoapply" value="never" label="Never — every patch goes to review-required." />
            <RadioRow name="autoapply" value="status" label="Executive-status sections only — standup, current direction, and risks." />
            <RadioRow name="autoapply" value="all" label="All sections — apply when source hash matches and confidence ≥ 0.8 (default)." defaultChecked />
            <Tiny>Stale-hash collisions always fall through to review, regardless of policy.</Tiny>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Backfill"
          right={<Button variant="default" size="sm" onClick={runBackfill} loading={busy === "backfill"}>Queue backfill</Button>}
        />
        <CardBody padding={14}>
          <Tiny style={{ marginBottom: 6 }}>Backfills replay a bounded source window for a single scope so newly-enabled projects can catch up to fresh state.</Tiny>
          <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
            <PropRow label="Default scope" value={cursors.find((c) => c.projectName)?.projectName ?? cursors[0]?.scopeKey ?? "—"} />
            <PropRow label="Cursors active" value={String(counts.cursors)} />
            <PropRow label="Runs in flight" value={String(counts.runningRuns)} />
            <PropRow label="Failed (24h)" value={String(counts.failedRuns24h)} />
            <PropRow label="Review queue" value={String(counts.reviewRequired)} />
          </div>
        </CardBody>
      </Card>

      <Tiny>
        Active cursors:&nbsp;
        {cursors.slice(0, 6).map((cursor, idx) => (
          <span key={cursor.id}>
            {idx > 0 ? " · " : ""}
            {cursor.projectName ?? cursor.rootIssueIdentifier ?? cursor.scopeKey}
          </span>
        ))}
        {cursors.length > 6 ? <span>{` +${cursors.length - 6} more`}</span> : null}
      </Tiny>
    </div>
  );
}

function SettingField({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <label style={{ fontSize: 12, color: tokens.muted }}>{label}</label>
      {children}
      {hint ? <Tiny>{hint}</Tiny> : null}
    </div>
  );
}

function CheckboxRow({
  label,
  help,
  defaultChecked,
  checked,
  onChange,
  locked,
  suffix,
}: {
  label: string;
  help?: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  locked?: boolean;
  suffix?: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13 }}>
      <input
        type="checkbox"
        defaultChecked={checked === undefined ? defaultChecked : undefined}
        checked={checked}
        disabled={locked}
        onChange={(event) => onChange?.(event.currentTarget.checked)}
      />
      <span>
        {label}
        {suffix ? <span style={{ marginLeft: 6, fontSize: 11, color: tokens.muted }}>({suffix})</span> : null}
        {help ? <Tiny style={{ display: "block", marginTop: 2 }}>{help}</Tiny> : null}
      </span>
    </label>
  );
}

function RadioRow({ name, value, label, defaultChecked }: { name: string; value: string; label: string; defaultChecked?: boolean }) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13 }}>
      <input type="radio" name={name} value={value} defaultChecked={defaultChecked} />
      <span>{label}</span>
    </label>
  );
}

function SelectInput({ defaultValue, options }: { defaultValue: string; options: ReadonlyArray<readonly [string, string]> }) {
  return (
    <select
      defaultValue={defaultValue}
      style={{
        background: "oklch(0.2 0 0)",
        color: tokens.fg,
        border: `1px solid ${tokens.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 13,
      }}
    >
      {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  );
}

function SettingsBody({ context, initialSection = "root" }: { context: { companyId: string | null; companyPrefix?: string | null }; initialSection?: SettingsSectionKey }) {
  const settings = useSettings(context.companyId);
  const hostNavigation = useHostNavigation();
  const { pathname } = useHostLocation();
  const isMobile = useIsMobileLayout();
  const bootstrap = usePluginAction("bootstrap-root");
  const updateEventIngestion = usePluginAction("update-event-ingestion-settings");
  const resetAgent = usePluginAction("reset-managed-agent");
  const resetProject = usePluginAction("reset-managed-project");
  const resetRoutine = usePluginAction("reset-managed-routine");
  const reconcileAgent = usePluginAction("reconcile-managed-agent");
  const reconcileProject = usePluginAction("reconcile-managed-project");
  const selectAgent = usePluginAction("select-managed-agent");
  const selectProject = usePluginAction("select-managed-project");
  const resetSkills = usePluginAction("reset-managed-skills");
  const reconcileRoutines = usePluginAction("reconcile-managed-routines");
  const updateRoutineStatus = usePluginAction("update-managed-routine-status");
  const runManagedRoutine = usePluginAction("run-managed-routine");
  const toast = usePluginToast();

  const [folderPath, setFolderPath] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [routineBusyKey, setRoutineBusyKey] = useState<string | null>(null);
  const [routineRepairBusy, setRoutineRepairBusy] = useState(false);
  const [skillBusy, setSkillBusy] = useState(false);
  const [allRepairBusy, setAllRepairBusy] = useState(false);
  const [eventPolicy, setEventPolicy] = useState<EventIngestionSettings | null>(null);
  const [eventPolicyBusy, setEventPolicyBusy] = useState(false);
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionKey>(initialSection);

  useEffect(() => {
    if (settings.data?.folder.path && !folderPath) setFolderPath(settings.data.folder.path);
  }, [settings.data?.folder.path, folderPath]);
  useEffect(() => { if (settings.data?.managedAgent.agentId) setSelectedAgentId(settings.data.managedAgent.agentId); }, [settings.data?.managedAgent.agentId]);
  useEffect(() => { if (settings.data?.managedProject.projectId) setSelectedProjectId(settings.data.managedProject.projectId); }, [settings.data?.managedProject.projectId]);
  useEffect(() => {
    if (settings.data?.eventIngestion && eventPolicy === null) setEventPolicy(settings.data.eventIngestion);
  }, [settings.data?.eventIngestion, eventPolicy]);
  useEffect(() => {
    setActiveSettingsSection(initialSection);
  }, [initialSection]);

  if (!context.companyId) return <Callout>Choose a company to view LLM Wiki settings.</Callout>;
  if (settings.loading) return <Tiny>Loading settings…</Tiny>;
  if (settings.error) return <Callout tone="danger">{settings.error.message}</Callout>;
  if (!settings.data) return <Tiny>No settings available.</Tiny>;

  const data = settings.data;
  const maintainerFallbackAgent: MaintainerAgentOption | null = data.managedAgent.agentId
    ? {
        id: data.managedAgent.agentId,
        name: data.managedAgent.details?.name ?? "Wiki Maintainer",
        status: data.managedAgent.details?.status ?? data.managedAgent.status,
        adapterType: data.managedAgent.details?.adapterType ?? null,
        icon: data.managedAgent.details?.icon ?? "book-open",
        urlKey: data.managedAgent.details?.urlKey ?? null,
      }
    : null;
  const maintainerAgentOptions = maintainerFallbackAgent && !data.agentOptions.some((agent) => agent.id === maintainerFallbackAgent.id)
    ? [maintainerFallbackAgent, ...data.agentOptions]
    : data.agentOptions;
  const effectiveSelectedAgentId = selectedAgentId || data.managedAgent.agentId || "";
  const currentMaintainerAgent = maintainerAgentOptions.find((agent) => agent.id === effectiveSelectedAgentId) ?? maintainerFallbackAgent;
  const savedCustomMaintainer = data.managedAgent.source === "selected";
  const selectingDifferentMaintainer = Boolean(
    data.managedAgent.source === "managed" &&
    data.managedAgent.agentId &&
    effectiveSelectedAgentId &&
    effectiveSelectedAgentId !== data.managedAgent.agentId,
  );
  const showMaintainerWarning = savedCustomMaintainer || selectingDifferentMaintainer;
  const maintainerPendingApproval = currentMaintainerAgent?.status === "pending_approval" || data.managedAgent.details?.status === "pending_approval";
  const agentLink = currentMaintainerAgent?.id
    ? `/agents/${currentMaintainerAgent.id}`
    : null;
  const projectLink = data.managedProject.projectId
    ? `/projects/${data.managedProject.projectId}`
    : null;
  const managedRoutines = data.managedRoutines ?? (data.managedRoutine ? [data.managedRoutine] : []);
  const agentHealthItems = buildAgentHealthItems(data.managedAgent);
  const agentHealthWarnings = agentHealthItems.filter((item) => !item.ok);
  const routineHealthItems = buildRoutineHealthItems(managedRoutines, data.managedAgent, data.managedProject);
  const routineHealthWarnings = routineHealthItems.filter((item) => !item.ok);
  const projectHealthItems = buildProjectHealthItems(data.managedProject);
  const projectHealthWarnings = projectHealthItems.filter((item) => !item.ok);
  const managedSkills = data.managedSkills ?? [];
  const skillHealthItems = buildSkillHealthItems(managedSkills);
  const skillHealthWarnings = skillHealthItems.filter((item) => !item.ok);
  const configurationErrors = [
    ...(!data.folder.healthy ? ["Wiki root folder"] : []),
    ...(agentHealthWarnings.length > 0 ? ["Managed agents"] : []),
    ...(skillHealthWarnings.length > 0 ? ["Managed skills"] : []),
    ...(projectHealthWarnings.length > 0 ? ["Managed projects"] : []),
    ...(routineHealthWarnings.length > 0 ? ["Managed routines"] : []),
  ];
  const hasConfigurationErrors = configurationErrors.length > 0;
  const projectFallbackOption: ProjectOption | null = data.managedProject.projectId
    ? {
        id: data.managedProject.projectId,
        name: data.managedProject.details?.name ?? "Current project",
        status: data.managedProject.details?.status ?? data.managedProject.status,
        color: data.managedProject.details?.color ?? null,
      }
    : null;
  const projectOptions = projectFallbackOption && !data.projectOptions.some((project) => project.id === projectFallbackOption.id)
    ? [projectFallbackOption, ...data.projectOptions]
    : data.projectOptions;
  const effectiveSelectedProjectId = selectedProjectId || data.managedProject.projectId || "";
  const currentProjectOption = projectOptions.find((project) => project.id === effectiveSelectedProjectId) ?? projectFallbackOption;
  const currentEventPolicy = eventPolicy ?? data.eventIngestion;
  const managedRoutineItems: ManagedRoutinesListItem[] = managedRoutines.map((routine) => {
    const fallback = routineFallbackFor(routine);
    const key = routine.resourceKey ?? routine.routineId ?? fallback.title;
    const status = managedRoutineStatus(routine);
    const assigneeAgentId = routine.routine?.assigneeAgentId ?? routine.details?.assigneeAgentId ?? null;

    return {
      key,
      title: routine.routine?.title ?? routine.details?.title ?? fallback.title,
      status: status === "missing" || status === "missing_refs" ? "paused" : status,
      routineId: routine.routineId ?? routine.routine?.id ?? null,
      href: routine.routineId ? `/routines/${routine.routineId}` : null,
      resourceKey: routine.resourceKey ?? null,
      projectId: routine.routine?.projectId ?? null,
      assigneeAgentId,
      cronExpression: routine.details?.cronExpression ?? fallback.cron,
      lastRunAt: routine.routine?.lastTriggeredAt ?? routine.details?.lastRunAt ?? null,
      managedByPluginDisplayName: routine.routine?.managedByPlugin?.pluginDisplayName ?? "LLM Wiki",
      missingRefs: routine.missingRefs?.map((ref) => ({
        resourceKind: ref.resourceKind,
        resourceKey: ref.resourceKey,
      })),
      defaultDrift: routine.defaultDrift
        ? {
            changedFields: routine.defaultDrift.changedFields,
            defaultTitle: routine.defaultDrift.defaultTitle ?? null,
            defaultDescription: routine.defaultDrift.defaultDescription ?? null,
          }
        : null,
    };
  });
  const routineDefaultDriftItems = managedRoutineItems.filter((routine) => routine.defaultDrift?.changedFields.length);
  const agentDefaultDrift = data.managedAgent.defaultDrift;
  const activeSpaceSlug = readActiveSpaceSlugFromLocation(pathname);

  function routineBusyKeyFor(prefix: string) {
    const marker = `${prefix}:`;
    return routineBusyKey?.startsWith(marker) ? routineBusyKey.slice(marker.length) : null;
  }

  async function changeFolder() {
    if (!context.companyId || !folderPath.trim()) return;
    setFolderBusy(true);
    try {
      await bootstrap({ companyId: context.companyId, path: folderPath.trim() });
      toast({ tone: "success", title: "Folder updated" });
      settings.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Folder update failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setFolderBusy(false);
    }
  }

  async function chooseAgent() {
    const agentId = selectedAgentId || data.managedAgent.agentId;
    if (!context.companyId || !agentId) return;
    setAgentBusy(true);
    try {
      await selectAgent({ companyId: context.companyId, agentId });
      toast({ tone: "success", title: "Maintainer agent selected" });
      settings.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Agent selection failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setAgentBusy(false);
    }
  }

  async function chooseProject() {
    const projectId = effectiveSelectedProjectId;
    if (!context.companyId || !projectId) return;
    setProjectBusy(true);
    try {
      await selectProject({ companyId: context.companyId, projectId });
      toast({ tone: "success", title: "Project selected" });
      settings.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Project selection failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setProjectBusy(false);
    }
  }

  async function saveEventPolicy() {
    if (!context.companyId || !eventPolicy) return;
    setEventPolicyBusy(true);
    try {
      const next = await updateEventIngestion({ companyId: context.companyId, ...eventPolicy }) as EventIngestionSettings;
      setEventPolicy(next);
      toast({ tone: "success", title: "Event ingestion controls saved" });
      settings.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Could not save event controls", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setEventPolicyBusy(false);
    }
  }

  async function repairManagedRoutines() {
    if (!context.companyId) return;
    setRoutineRepairBusy(true);
    try {
      await reconcileRoutines({ companyId: context.companyId });
      toast({ tone: "success", title: "Routines fixed" });
      settings.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Routine repair failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setRoutineRepairBusy(false);
    }
  }

  async function resyncManagedSkills() {
    if (!context.companyId) return;
    setSkillBusy(true);
    try {
      await resetSkills({ companyId: context.companyId });
      toast({ tone: "success", title: "Skills synced" });
      settings.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Skill sync failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setSkillBusy(false);
    }
  }

  async function fixAllConfigurationErrors() {
    if (!context.companyId || !hasConfigurationErrors) return;
    const confirmed = typeof window === "undefined" || window.confirm(
      "Fix all detected LLM Wiki configuration errors? This may recreate missing wiki baseline files and restore plugin-managed agents, projects, routines, and skills to their current defaults.",
    );
    if (!confirmed) return;

    setAllRepairBusy(true);
    try {
      if (!data.folder.healthy) {
        const path = folderPath.trim() || data.folder.path?.trim() || "";
        if (!path && !data.folder.configured) {
          throw new Error("Choose a wiki root folder path before fixing all configuration errors.");
        }
        await bootstrap(path ? { companyId: context.companyId, path } : { companyId: context.companyId });
      }

      if (skillHealthWarnings.length > 0) {
        await resetSkills({ companyId: context.companyId });
      }

      const shouldResetAgent =
        data.managedAgent.source !== "managed" ||
        !managedAgentIsReady(data.managedAgent) ||
        Boolean(data.managedAgent.defaultDrift?.changedFiles.length);
      const shouldResetProject =
        data.managedProject.source !== "managed" ||
        !managedProjectIsReady(data.managedProject);

      if (shouldResetAgent) {
        await resetAgent({ companyId: context.companyId });
      } else if (routineHealthWarnings.length > 0) {
        await reconcileAgent({ companyId: context.companyId });
      }

      if (shouldResetProject) {
        await resetProject({ companyId: context.companyId });
      } else if (routineHealthWarnings.length > 0) {
        await reconcileProject({ companyId: context.companyId });
      }

      if (routineHealthWarnings.length > 0) {
        await reconcileRoutines({ companyId: context.companyId });
      }

      toast({ tone: "success", title: "Configuration errors fixed" });
      settings.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Fix all failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setAllRepairBusy(false);
    }
  }

  async function toggleManagedRoutine(routine: ManagedRoutinesListItem, enabled: boolean) {
    if (!context.companyId || !routine.resourceKey) return;
    if (!enabled && !routine.assigneeAgentId) {
      toast({ tone: "warn", title: "Default agent required", body: "Set a default maintainer before enabling this routine." });
      return;
    }
    setRoutineBusyKey(`status:${routine.key}`);
    try {
      await updateRoutineStatus({ companyId: context.companyId, routineKey: routine.resourceKey, status: enabled ? "paused" : "active" });
      toast({ tone: "success", title: enabled ? "Routine paused" : "Routine enabled" });
      settings.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Routine update failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setRoutineBusyKey(null);
    }
  }

  async function runManagedRoutineNow(routine: ManagedRoutinesListItem) {
    if (!context.companyId || !routine.resourceKey) return;
    const assigneeAgentId = routine.assigneeAgentId ?? data.managedAgent.agentId ?? null;
    const projectId = routine.projectId ?? data.managedProject.projectId ?? null;
    if (!assigneeAgentId) {
      toast({ tone: "warn", title: "Default agent required", body: "Set a default maintainer before running this routine." });
      return;
    }

    setRoutineBusyKey(`run:${routine.key}`);
    try {
      await runManagedRoutine({
        companyId: context.companyId,
        routineKey: routine.resourceKey,
        assigneeAgentId,
        projectId,
      });
      toast({ tone: "success", title: "Routine run started" });
      settings.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Routine run failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setRoutineBusyKey(null);
    }
  }

  async function resetManagedRoutineToDefaults(routine: ManagedRoutinesListItem) {
    if (!context.companyId || !routine.resourceKey) return;
    const changedFields = routine.defaultDrift?.changedFields ?? [];
    const fieldList = changedFields.length > 0 ? changedFields.join(", ") : "managed defaults";
    const confirmed = typeof window === "undefined" || window.confirm(
      `Update "${routine.title}" to the current LLM Wiki plugin defaults? This replaces ${fieldList}. Cancel to keep the current custom routine text.`,
    );
    if (!confirmed) return;

    const assigneeAgentId = routine.assigneeAgentId ?? data.managedAgent.agentId ?? null;
    const projectId = routine.projectId ?? data.managedProject.projectId ?? null;
    setRoutineBusyKey(`reset:${routine.key}`);
    try {
      await resetRoutine({
        companyId: context.companyId,
        routineKey: routine.resourceKey,
        assigneeAgentId,
        projectId,
      });
      toast({ tone: "success", title: "Routine defaults updated" });
      settings.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Routine reset failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setRoutineBusyKey(null);
    }
  }

  async function resetManagedAgentToDefaults() {
    if (!context.companyId) return;
    const changedFiles = agentDefaultDrift?.changedFiles ?? [];
    const fileList = changedFiles.length > 0 ? changedFiles.join(", ") : "managed instructions and defaults";
    const confirmed = typeof window === "undefined" || window.confirm(
      `Update the Wiki Maintainer to the current LLM Wiki plugin defaults? This replaces ${fileList}. Cancel to keep the current custom instructions.`,
    );
    if (!confirmed) return;

    setAgentBusy(true);
    try {
      await resetAgent({ companyId: context.companyId });
      toast({ tone: "success", title: "Agent reset to plugin defaults" });
      settings.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Reset failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setAgentBusy(false);
    }
  }

  const activeSettingsConfig =
    SETTINGS_SECTIONS.find((section) => section.key === activeSettingsSection) ?? SETTINGS_SECTIONS[0];

  return (
    <div style={{
      display: "flex",
      flexDirection: isMobile ? "column" : "row",
      gap: isMobile ? 16 : 24,
      maxWidth: isMobile ? "none" : 1040,
      minWidth: 0,
    }}>
      <aside style={{
        width: isMobile ? "auto" : 230,
        flexShrink: 0,
        borderRight: isMobile ? "none" : `1px solid ${tokens.border}`,
        borderBottom: isMobile ? `1px solid ${tokens.border}` : "none",
        paddingRight: isMobile ? 0 : 16,
        paddingBottom: isMobile ? 12 : 0,
      }}>
        <nav aria-label="LLM Wiki settings sections" style={{
          display: "flex",
          flexDirection: isMobile ? "row" : "column",
          gap: 4,
          overflowX: isMobile ? "auto" : "visible",
          paddingBottom: isMobile ? 2 : 0,
        }}>
          {SETTINGS_SECTIONS.map((section) => (
            <div key={section.key} style={{ minWidth: isMobile ? 190 : 0 }}>
              <SettingsSectionButton
                section={section}
                active={activeSettingsSection === section.key}
                onSelect={() => {
                  setActiveSettingsSection(section.key);
                  hostNavigation.navigate(buildSettingsSectionHref(section.key, activeSpaceSlug));
                }}
              />
            </div>
          ))}
        </nav>
      </aside>

      <div style={{ flex: 1, minWidth: 0 }}>
        {hasConfigurationErrors ? (
          <div style={{ marginBottom: 18 }}>
            <Callout tone="warn">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                  <strong>configuration errors detected, fix them all?</strong>
                  <Tiny>
                    {configurationErrors.join(", ")} {configurationErrors.length === 1 ? "needs" : "need"} attention.
                  </Tiny>
                </div>
                <Button size="sm" variant="primary" onClick={fixAllConfigurationErrors} loading={allRepairBusy}>
                  Fix them all
                </Button>
              </div>
            </Callout>
          </div>
        ) : null}
        {activeSettingsSection === "root" ? (
          <section style={{ display: "grid", gap: 22, minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: isMobile ? 20 : 22, fontWeight: 700 }}>Setup</h1>
            <SetupSection title="Base Folder">
              <div style={{ display: "grid", gap: 12 }}>
                <FolderPathPicker
                  value={folderPath}
                  onChange={setFolderPath}
                  onApply={changeFolder}
                  applyLabel="Apply path"
                  busy={folderBusy}
                  disabled={!folderPath.trim()}
                  onRefresh={() => settings.refresh()}
                />
                <FolderHealthChecklist folder={data.folder} />
                {data.folder.problems.length > 0 ? (
                  <Callout tone="warn">{data.folder.problems.length} folder issue(s): {data.folder.problems.map((p) => p.message).join("; ")}</Callout>
                ) : null}
              </div>
            </SetupSection>
            <SetupSection title="Managed Agents" separated>
              <div style={{ display: "grid", gap: 14, maxWidth: isMobile ? "none" : 620, minWidth: 0 }}>
                <ManagedResourceHealthChecklist
                  items={agentHealthItems}
                  ariaLabel="Wiki agents health checklist"
                  heading="Agent health"
                />
                {agentHealthWarnings.length > 0 ? (
                  <Callout tone="warn">
                    <div style={{ display: "grid", gap: 8 }}>
                      <div>{agentHealthWarnings.length} agent issue(s) need attention.</div>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {agentHealthWarnings.map((item) => <li key={item.label}>{item.detail}</li>)}
                      </ul>
                    </div>
                  </Callout>
                ) : null}
                <div style={{ display: "grid", gap: 8 }}>
                  <label style={{ fontSize: 12, color: tokens.muted }}>Maintainer</label>
                  <fieldset
                    disabled={agentBusy}
                    style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
                  >
                    <AssigneePicker
                      companyId={context.companyId}
                      value={effectiveSelectedAgentId ? `agent:${effectiveSelectedAgentId}` : ""}
                      includeUsers={false}
                      placeholder="Select maintainer"
                      noneLabel="No maintainer"
                      searchPlaceholder="Search agents..."
                      emptyMessage="No agents found."
                      onChange={(_value, selection) => {
                        setSelectedAgentId(selection.assigneeAgentId ?? "");
                      }}
                    />
                  </fieldset>
                  <Tiny>
                    Adapter: {adapterTypeLabel(currentMaintainerAgent?.adapterType ?? data.managedAgent.details?.adapterType ?? null)}
                  </Tiny>
                  {maintainerPendingApproval ? (
                    <Callout tone="warn">
                      The Wiki Maintainer is pending approval. Approve the agent before relying on wiki ingest, query, lint, or scheduled maintenance tasks.
                    </Callout>
                  ) : null}
                  {showMaintainerWarning ? (
                    <Callout tone="warn">
                      This is not the Paperclip-provided Wiki Maintainer. Plugin operations and routines may miss the recommended wiki role, tools, and default instructions.
                    </Callout>
                  ) : null}
                  {agentDefaultDrift?.changedFiles.length ? (
                    <Callout tone="warn">
                      Wiki Maintainer instruction defaults changed: {agentDefaultDrift.changedFiles.join(", ")}. Reset only if you want to replace current custom instructions with the plugin template.
                    </Callout>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={chooseAgent}
                      loading={agentBusy}
                      disabled={!effectiveSelectedAgentId || effectiveSelectedAgentId === data.managedAgent.agentId}
                    >
                      Save maintainer
                    </Button>
                    {agentLink ? <Button size="sm" onClick={() => hostNavigation.navigate(agentLink)}>Open agent ↗</Button> : null}
                    <Button size="sm" variant="ghost" onClick={async () => {
                      if (!context.companyId) return;
                      setAgentBusy(true);
                      try {
                        await reconcileAgent({ companyId: context.companyId });
                        toast({ tone: "success", title: "Agent reconciled" });
                        settings.refresh();
                      } catch (err) {
                        toast({ tone: "error", title: "Reconcile failed", body: err instanceof Error ? err.message : String(err) });
                      } finally {
                        setAgentBusy(false);
                      }
                    }} loading={agentBusy}>Repair</Button>
                    <Button size="sm" variant="ghost" onClick={resetManagedAgentToDefaults} loading={agentBusy}>Reset to defaults</Button>
                  </div>
                </div>
              </div>
            </SetupSection>
            <SetupSection title="Managed Skills" separated>
              <div style={{ display: "grid", gap: 12, maxWidth: isMobile ? "none" : 620, minWidth: 0 }}>
                <SkillHealthChecklist items={skillHealthItems} />
                {skillHealthWarnings.length > 0 ? (
                  <Callout tone="warn">
                    <div style={{ display: "grid", gap: 8 }}>
                      <div>{skillHealthWarnings.length} skill issue(s) need attention.</div>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {skillHealthWarnings.map((item) => <li key={item.label}>{item.detail}</li>)}
                      </ul>
                      <div>
                        <Button size="sm" variant="primary" onClick={resyncManagedSkills} loading={skillBusy}>Re-sync skills</Button>
                      </div>
                    </div>
                  </Callout>
                ) : (
                  <Callout>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <span>LLM Wiki skills are installed in the company skill library.</span>
                      <Button size="sm" variant="ghost" onClick={resyncManagedSkills} loading={skillBusy}>Re-sync skills</Button>
                    </div>
                  </Callout>
                )}
              </div>
            </SetupSection>
            <SetupSection title="Managed Projects" separated>
              <div style={{ display: "grid", gap: 10, maxWidth: isMobile ? "none" : 620, minWidth: 0 }}>
                <ManagedResourceHealthChecklist
                  items={projectHealthItems}
                  ariaLabel="Wiki projects health checklist"
                  heading="Project health"
                />
                {projectHealthWarnings.length > 0 ? (
                  <Callout tone="warn">
                    <div style={{ display: "grid", gap: 8 }}>
                      <div>{projectHealthWarnings.length} project issue(s) need attention.</div>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {projectHealthWarnings.map((item) => <li key={item.label}>{item.detail}</li>)}
                      </ul>
                    </div>
                  </Callout>
                ) : null}
                <div style={{ display: "grid", gap: 8 }}>
                  <label style={{ fontSize: 12, color: tokens.muted }}>Use existing project</label>
                  <fieldset
                    disabled={projectBusy}
                    style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
                  >
                    <ProjectPicker
                      companyId={context.companyId}
                      value={effectiveSelectedProjectId}
                      includeArchived
                      placeholder="Project"
                      noneLabel="No project"
                      searchPlaceholder="Search projects..."
                      emptyMessage="No projects found."
                      onChange={setSelectedProjectId}
                    />
                  </fieldset>
                  <Tiny>
                    Status: {projectStatusLabel(currentProjectOption?.status ?? data.managedProject.details?.status ?? data.managedProject.status)}
                  </Tiny>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button size="sm" variant="primary" onClick={chooseProject} loading={projectBusy} disabled={!effectiveSelectedProjectId}>Save project</Button>
                    {projectLink ? <Button size="sm" onClick={() => hostNavigation.navigate(projectLink)}>Open project ↗</Button> : null}
                    <Button size="sm" variant="ghost" onClick={async () => {
                      if (!context.companyId) return;
                      setProjectBusy(true);
                      try {
                        await reconcileProject({ companyId: context.companyId });
                        toast({ tone: "success", title: "Project reconciled" });
                        settings.refresh();
                      } catch (err) {
                        toast({ tone: "error", title: "Reconcile failed", body: err instanceof Error ? err.message : String(err) });
                      } finally {
                        setProjectBusy(false);
                      }
                    }} loading={projectBusy}>Repair / reconcile</Button>
                    <Button size="sm" variant="ghost" onClick={async () => {
                      if (!context.companyId) return;
                      setProjectBusy(true);
                      try {
                        await resetProject({ companyId: context.companyId });
                        toast({ tone: "success", title: "Project reset to plugin defaults" });
                        settings.refresh();
                      } catch (err) {
                        toast({ tone: "error", title: "Reset failed", body: err instanceof Error ? err.message : String(err) });
                      } finally {
                        setProjectBusy(false);
                      }
                    }} loading={projectBusy}>↺ Reset to plugin defaults</Button>
                  </div>
                </div>
              </div>
            </SetupSection>
            <SetupSection title="Managed Routines" separated>
              <div style={{ display: "grid", gap: 12, maxWidth: isMobile ? "none" : 620, minWidth: 0 }}>
                <RoutineHealthChecklist items={routineHealthItems} />
                {routineHealthWarnings.length > 0 ? (
                  <Callout tone="warn">
                    <div style={{ display: "grid", gap: 8 }}>
                      <div>{routineHealthWarnings.length} routine issue(s) need attention.</div>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {routineHealthWarnings.map((item) => <li key={item.label}>{item.detail}</li>)}
                      </ul>
                      <div>
                        <Button size="sm" variant="primary" onClick={repairManagedRoutines} loading={routineRepairBusy}>Fix routines</Button>
                      </div>
                    </div>
                  </Callout>
                ) : routineDefaultDriftItems.length > 0 ? (
                  <Callout tone="warn">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <span>{routineDefaultDriftItems.length} routine default update{routineDefaultDriftItems.length === 1 ? "" : "s"} available.</span>
                      <Button size="sm" variant="primary" onClick={() => {
                        setActiveSettingsSection("routines");
                        hostNavigation.navigate(buildSettingsSectionHref("routines", activeSpaceSlug));
                      }}>Review defaults</Button>
                    </div>
                  </Callout>
                ) : (
                  <Tiny>Managed routines are installed with the Wiki Maintainer and LLM Wiki project.</Tiny>
                )}
              </div>
            </SetupSection>
          </section>
        ) : activeSettingsSection === "distillation" ? (
          <SettingsPanel
            title="Distillation"
            badge={<Badge tone="default">Default space only</Badge>}
            description="Read Paperclip issues, comments, and documents for this company and write project pages into the default wiki space. Assets/attachments and work products stay metadata-only in Phase 5 and are excluded from source-text extraction. Other spaces cannot be selected as a destination yet - that lands with per-space Paperclip ingestion profiles."
          >
            <DistillationSettingsPanel context={context} settings={data} />
          </SettingsPanel>
        ) : activeSettingsSection === "routines" ? (
          <SettingsPanel title="Managed Routines" description={activeSettingsConfig.description}>
          <div style={{ display: "grid", gap: 12 }}>
            {routineDefaultDriftItems.length > 0 ? (
              <Callout tone="warn">
                <div style={{ display: "grid", gap: 6 }}>
                  <strong>Routine defaults changed.</strong>
                  <span>
                    Review rows marked with changed defaults. Reset a row to update it to the current LLM Wiki instructions, or leave it unchanged to keep custom routine text.
                  </span>
                </div>
              </Callout>
            ) : null}
            {routineHealthWarnings.length > 0 ? (
              <Callout tone="warn">
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
                    <strong>Routine setup needs repair.</strong>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {routineHealthWarnings.map((item) => <li key={item.label}>{item.detail}</li>)}
                    </ul>
                  </div>
                  <Button size="sm" variant="primary" onClick={repairManagedRoutines} loading={routineRepairBusy}>Fix routines</Button>
                </div>
              </Callout>
            ) : (
              <Callout>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <span>Managed routines are installed with the Wiki Maintainer and LLM Wiki project.</span>
                  <Button size="sm" disabled>Routines valid</Button>
                </div>
              </Callout>
            )}
            <PluginManagedRoutinesList
              routines={managedRoutineItems}
              agents={maintainerAgentOptions}
              projects={projectOptions}
              pluginDisplayName="LLM Wiki"
              runningRoutineKey={routineBusyKeyFor("run")}
              statusMutationRoutineKey={routineBusyKeyFor("status")}
              resettingRoutineKey={routineBusyKeyFor("reset")}
              onRunNow={runManagedRoutineNow}
              onToggleEnabled={toggleManagedRoutine}
              onReset={resetManagedRoutineToDefaults}
            />
          </div>
          </SettingsPanel>
        ) : activeSettingsSection === "lint" ? (
          <SettingsLintPanel context={context} />
        ) : activeSettingsSection === "spaces" ? (
          <SpacesSettingsPanel context={context} description={activeSettingsConfig.description} />
        ) : activeSettingsSection === "events" ? (
          <SettingsPanel
            title="Paperclip event ingestion"
            badge={<Badge tone={currentEventPolicy.enabled ? "running" : "default"}>{currentEventPolicy.enabled ? "enabled" : "off by default"}</Badge>}
            description={activeSettingsConfig.description}
          >
          <Tiny style={{ marginBottom: 10 }}>
            Company-scoped Paperclip events can advance default-space cursors. Enable only the first-party text sources this wiki should observe for default-space distillation.
          </Tiny>
          <div style={{ display: "grid", gap: 10 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={currentEventPolicy.enabled}
                onChange={(event) => setEventPolicy({ ...currentEventPolicy, enabled: event.currentTarget.checked })}
              />
              Enable event ingestion for this company
            </label>
            <div style={{ display: "grid", gap: 8, paddingLeft: isMobile ? 0 : 22 }}>
              {([
                ["issues", "Issues", "Capture issue title and description when issue events fire."],
                ["comments", "Comments", "Capture comment body when comment-created events fire."],
                ["documents", "Documents", "Capture document body when document-created or document-updated events fire."],
              ] as const).map(([key, label, help]) => (
                <label key={key} style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 8, rowGap: 2, alignItems: "start", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={currentEventPolicy.sources[key]}
                    onChange={(event) => setEventPolicy({
                      ...currentEventPolicy,
                      sources: { ...currentEventPolicy.sources, [key]: event.currentTarget.checked },
                    })}
                  />
                  <span>
                    {label}
                    <Tiny style={{ display: "block" }}>{help}</Tiny>
                  </span>
                </label>
              ))}
            </div>
            <div style={{ display: "grid", gap: 6, maxWidth: isMobile ? "none" : 220 }}>
              <label style={{ fontSize: 12, color: tokens.muted }}>Max characters per captured event</label>
              <TextInput
                value={String(currentEventPolicy.maxCharacters)}
                onChange={(event) => {
                  const parsed = Number(event.currentTarget.value);
                  setEventPolicy({ ...currentEventPolicy, maxCharacters: Number.isFinite(parsed) ? parsed : currentEventPolicy.maxCharacters });
                }}
              />
            </div>
            <Callout tone="warn">
              Event ingestion records selected Paperclip issue, comment, and document activity for the default wiki space. Assets/attachments and work products are excluded here: Phase 5 allows metadata-only references later, not blob reads or linked-content fetches. It never reads across companies or creates non-default space cursors.
            </Callout>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button size="sm" variant="primary" onClick={saveEventPolicy} loading={eventPolicyBusy}>Save controls</Button>
              <Button size="sm" variant="ghost" onClick={() => setEventPolicy(data.eventIngestion)}>Revert</Button>
            </div>
          </div>
          </SettingsPanel>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spaces settings — list of spaces with sub-nav and a per-space edit panel.
// Reachable via /wiki/settings/spaces or /wiki/settings/spaces/<slug>.
// ---------------------------------------------------------------------------

function SpacesSettingsPanel({ context, description }: { context: { companyId: string | null; companyPrefix?: string | null }; description: string }) {
  const { pathname } = useHostLocation();
  const hostNavigation = useHostNavigation();
  const activeSpaceSlug = useMemo(() => readActiveSpaceSlugFromLocation(pathname), [pathname]);
  const editingSlug = useMemo(() => readSettingsSpaceSlugFromLocation(pathname), [pathname]);
  const isMobile = useIsMobileLayout();
  const spacesQuery = useSpaces(context.companyId);
  const spaces = useMemo(() => {
    const list = spacesQuery.data?.spaces ?? [];
    return activeWikiSpaces(list).sort(compareSpaces);
  }, [spacesQuery.data]);
  const [createOpen, setCreateOpen] = useState(false);

  const focusedSpace = useMemo(() => {
    if (editingSlug) return spaces.find((s) => s.slug === editingSlug) ?? null;
    return spaces.find((s) => s.slug === activeSpaceSlug) ?? spaces.find((s) => s.slug === DEFAULT_SPACE_SLUG) ?? spaces[0] ?? null;
  }, [editingSlug, spaces, activeSpaceSlug]);

  return (
    <SettingsPanel title="Shared spaces" description={description}>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "220px 1fr", gap: 18, alignItems: "flex-start" }}>
        <aside style={{ display: "grid", gap: 4, minWidth: 0 }}>
          {spaces.map((space) => {
            const active = focusedSpace?.slug === space.slug;
            return (
              <button
                key={space.slug}
                type="button"
                onClick={() => hostNavigation.navigate(buildSettingsSectionHref("spaces", activeSpaceSlug, space.slug))}
                style={{
                  textAlign: "left",
                  background: active ? tokens.accent : "transparent",
                  border: `1px solid ${active ? tokens.border : "transparent"}`,
                  borderRadius: 6,
                  padding: "8px 10px",
                  color: tokens.fg,
                  cursor: "pointer",
                  fontFamily: fontStack,
                  display: "grid",
                  gap: 2,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600 }}>{space.displayName}</span>
                <span style={{ fontSize: 11, color: tokens.muted, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{space.slug}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            style={{
              textAlign: "left",
              background: "transparent",
              border: `1px dashed ${tokens.border}`,
              borderRadius: 6,
              padding: "8px 10px",
              color: "oklch(0.78 0.13 250)",
              cursor: "pointer",
              fontFamily: fontStack,
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              fontWeight: 600,
              marginTop: 6,
            }}
          >
            <PlusIcon size={14} />
            Add space…
          </button>
        </aside>
        <div style={{ minWidth: 0, display: "grid", gap: 14 }}>
          {spacesQuery.loading && spaces.length === 0 ? <Tiny>Loading spaces…</Tiny> : null}
          {spacesQuery.error ? <Callout tone="danger">Failed to load spaces: {spacesQuery.error.message}</Callout> : null}
          {focusedSpace ? (
            <SpaceEditCard
              space={focusedSpace}
              companyId={context.companyId}
              isOnlySpace={spaces.length === 1}
              refresh={spacesQuery.refresh}
              onArchived={() => {
                hostNavigation.navigate(buildSettingsSectionHref("spaces", activeSpaceSlug));
              }}
            />
          ) : (
            <Callout>Pick a space from the list, or create one with the “Add space…” button.</Callout>
          )}
        </div>
      </div>
      {createOpen && context.companyId ? (
        <CreateSpaceModal
          companyId={context.companyId}
          existingSlugs={new Set(spaces.map((s) => s.slug))}
          onClose={() => setCreateOpen(false)}
          onCreated={(space) => {
            setCreateOpen(false);
            spacesQuery.refresh();
            hostNavigation.navigate(buildSettingsSectionHref("spaces", activeSpaceSlug, space.slug));
          }}
        />
      ) : null}
    </SettingsPanel>
  );
}

function SpaceEditCard({
  space,
  companyId,
  isOnlySpace,
  refresh,
  onArchived,
}: {
  space: WikiSpace;
  companyId: string | null;
  isOnlySpace: boolean;
  refresh: () => void;
  onArchived: () => void;
}) {
  const updateSpace = usePluginAction("update-space");
  const archiveSpace = usePluginAction("archive-space");
  const bootstrapSpace = usePluginAction("bootstrap-space");
  const folderStatusQuery = useSpaceFolderStatus(companyId, space.slug);
  const toast = usePluginToast();
  const isDefault = space.slug === DEFAULT_SPACE_SLUG;
  const [displayName, setDisplayName] = useState(space.displayName);
  const [busy, setBusy] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);

  useEffect(() => {
    setDisplayName(space.displayName);
  }, [space.slug, space.displayName]);

  const folder = folderStatusQuery.data?.folder ?? null;
  const relativeRoot = folderStatusQuery.data?.relativeRoot ?? "";
  const settingsRecord = (space.settings ?? {}) as Record<string, unknown>;
  const folderModeLabel = space.folderMode === "managed_subfolder"
    ? "New managed folder (under wiki root)"
    : space.folderMode === "existing_local_folder"
      ? "Existing folder under wiki root"
      : space.folderMode;

  async function saveName() {
    if (!companyId || displayName.trim().length === 0 || displayName.trim() === space.displayName) return;
    setBusy(true);
    try {
      await updateSpace({ companyId, spaceSlug: space.slug, displayName: displayName.trim() });
      toast({ tone: "success", title: "Display name updated" });
      refresh();
    } catch (err) {
      toast({ tone: "error", title: "Update failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function recreateBaseline() {
    if (!companyId || folderBusy) return;
    setFolderBusy(true);
    try {
      await bootstrapSpace({ companyId, spaceSlug: space.slug });
      toast({ tone: "success", title: "Baseline restored", body: `Re-created the standard skeleton for ${space.displayName}.` });
      folderStatusQuery.refresh();
    } catch (err) {
      toast({ tone: "error", title: "Bootstrap failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setFolderBusy(false);
    }
  }

  async function archive() {
    if (!companyId || isDefault || isOnlySpace || archiveBusy) return;
    if (typeof window !== "undefined" && !window.confirm(`Archive ${space.displayName}? Pages stay on disk; you can restore later through the plugin API or by un-archiving from the database.`)) {
      return;
    }
    setArchiveBusy(true);
    try {
      await archiveSpace({ companyId, spaceSlug: space.slug });
      toast({ tone: "success", title: "Space archived", body: `${space.displayName} hidden from the sidebar.` });
      refresh();
      onArchived();
    } catch (err) {
      toast({ tone: "error", title: "Archive failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setArchiveBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card>
        <CardHeader
          title={
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <FolderIcon size={16} />
              <span>{space.displayName}</span>
              <Badge tone="default" style={{ fontSize: 10 }}>{space.slug}</Badge>
              <Badge tone={space.status === "active" ? "running" : "default"} style={{ fontSize: 10 }}>{space.status}</Badge>
            </span>
          }
          right={
            <span style={{ fontSize: 11, color: tokens.muted }}>
              {space.spaceType} · {space.accessScope}
            </span>
          }
        />
        <CardBody>
          <Tiny>
            Stored under <Mono>{relativeRoot || (isDefault ? "(wiki root)" : `spaces/${space.slug}/`)}</Mono> within the configured wiki root.
          </Tiny>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Identity" />
        <CardBody>
          <div style={{ display: "grid", gap: 12 }}>
            <FormField label="Display name">
              <TextInput value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} />
            </FormField>
            <FormField label="Slug" help="Slug is locked once a space has indexed pages. Contact platform team to migrate.">
              <TextInput value={space.slug} disabled style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", opacity: 0.7 }} />
            </FormField>
            <FormField label="Type" help="(Cloud connectors coming soon)">
              <TextInput value={space.spaceType === "managed" ? "Folder" : space.spaceType} disabled style={{ opacity: 0.7 }} />
            </FormField>
            <div>
              <Button variant="primary" size="sm" onClick={saveName} disabled={busy || displayName.trim() === space.displayName} loading={busy}>Save name</Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Folder source & health" />
        <CardBody>
          <div style={{ display: "grid", gap: 12 }}>
            <FormField label="Mode">
              <TextInput value={folderModeLabel} disabled style={{ opacity: 0.7 }} />
            </FormField>
            <FormField label="Path">
              <TextInput value={folder?.path ?? folder?.realPath ?? relativeRoot ?? "(unconfigured)"} disabled style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", opacity: 0.7 }} />
            </FormField>
            {folderStatusQuery.loading ? <Tiny>Loading folder status…</Tiny> : null}
            {folderStatusQuery.error ? <Callout tone="danger">{folderStatusQuery.error.message}</Callout> : null}
            {folder ? <SpaceFolderHealthChecklist folder={folder} /> : null}
            <div>
              <Button size="sm" onClick={recreateBaseline} loading={folderBusy}>Recreate baseline</Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <PaperclipIngestionSpaceCard companyId={companyId} space={space} refresh={refresh} />

      <Card style={{ opacity: 0.56 }}>
        <CardHeader title="Access" />
        <CardBody>
          <div aria-disabled="true" style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Badge tone="default" style={{ fontSize: 10 }}>{space.accessScope}</Badge>
              <Badge tone="default" style={{ fontSize: 10 }}>Coming soon</Badge>
            </div>
            <Tiny>
              Access scope is stored as metadata only. <Mono>shared</Mono>, <Mono>team</Mono>, and{" "}
              <Mono>personal</Mono> are saved on the space record but do not currently enforce
              read/write permissions, and they do not change which Paperclip sources reach this space.
            </Tiny>
            <FormField label="Owner user id">
              <TextInput value={(settingsRecord.ownerUserHint as string | undefined) ?? space.ownerUserId ?? ""} disabled style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }} />
            </FormField>
            <FormField label="Owner team key">
              <TextInput value={space.teamKey ?? ""} disabled style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }} />
            </FormField>
          </div>
        </CardBody>
      </Card>

      <Card style={{ borderColor: "oklch(0.5 0.18 25)" }}>
        <CardHeader
          title={<span style={{ color: "oklch(0.78 0.18 25)" }}>Danger zone</span>}
        />
        <CardBody>
          <div style={{ display: "grid", gap: 8 }}>
            <Tiny>
              {isDefault
                ? "The default space cannot be archived because new operations and tools fall back to it."
                : isOnlySpace
                  ? "This is the only space in the company. Create another before archiving this one."
                  : "Archiving hides the space from the sidebar and pauses scheduled lint/index. Pages remain on disk."}
            </Tiny>
            <div>
              <Button
                variant="destructive"
                size="sm"
                onClick={archive}
                disabled={isDefault || isOnlySpace || archiveBusy}
                loading={archiveBusy}
                title={isDefault ? "Default space cannot be archived" : isOnlySpace ? "At least one space must remain" : undefined}
              >
                Archive this space
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function paperclipIngestionStateBadge(data: PaperclipIngestionProfileData | null): { tone: Tone; label: string } {
  if (!data) return { tone: "default", label: "Loading" };
  if (data.effectiveState === "policy_blocked") return { tone: "blocked", label: "Locked" };
  if (data.effectiveState === "pending_approval") return { tone: "queued", label: "Pending approval" };
  if (data.effectiveState === "enabled_no_scopes") return { tone: "failed", label: "Misconfigured" };
  if (data.effectiveState === "enabled") return { tone: "running", label: `On · ${data.profile.sourceScopes.length} source${data.profile.sourceScopes.length === 1 ? "" : "s"}` };
  return { tone: "default", label: data.historicalPageCount > 0 ? `Off · ${data.historicalPageCount} historical pages` : "Off" };
}

function PaperclipIngestionSpaceCard({ companyId, space, refresh }: { companyId: string | null; space: WikiSpace; refresh: () => void }) {
  const profileQuery = usePaperclipIngestionProfile(companyId, space.slug);
  const updateProfile = usePluginAction("update-paperclip-ingestion-profile");
  const toast = usePluginToast();
  const data = profileQuery.data ?? null;
  const [draft, setDraft] = useState<PaperclipIngestionProfile | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(data?.profile ?? null);
  }, [data?.space.slug, data?.profile]);

  const badge = paperclipIngestionStateBadge(data);
  const locked = data?.effectiveState === "policy_blocked";
  const sourceScope = draft?.sourceScopes[0];
  const activeProjectLimit = sourceScope?.kind === "active_projects" ? sourceScope.limit : 3;
  const canSave = Boolean(companyId && draft && !busy && !locked);
  const emptyScopes = Boolean(draft?.enabled && draft.sourceScopes.length === 0);

  function patchDraft(patch: Partial<PaperclipIngestionProfile>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
  }

  function setSourceKind(key: WikiEventIngestionSource, value: boolean) {
    setDraft((current) => current
      ? { ...current, sourceKinds: { ...current.sourceKinds, [key]: value } }
      : current);
  }

  function setActiveProjectsLimit(value: number) {
    setDraft((current) => current
      ? {
          ...current,
          sourceScopes: [{ kind: "active_projects", limit: Math.max(1, Math.floor(value || 1)) }],
        }
      : current);
  }

  async function save() {
    if (!companyId || !draft || locked) return;
    setBusy(true);
    try {
      await updateProfile({ companyId, spaceSlug: space.slug, profile: draft });
      toast({ tone: "success", title: "Paperclip ingestion profile saved", body: `${space.displayName} will use the selected Paperclip sources.` });
      profileQuery.refresh();
      refresh();
    } catch (err) {
      toast({ tone: "error", title: "Profile save failed", body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={<span>Paperclip → {space.displayName}</span>}
        right={<Badge tone={badge.tone} style={{ fontSize: 10 }}>{badge.label}</Badge>}
      />
      <CardBody>
        <div style={{ display: "grid", gap: 12 }}>
          {profileQuery.loading && !data ? <Tiny>Loading Paperclip ingestion profile…</Tiny> : null}
          {profileQuery.error ? <Callout tone="danger">{profileQuery.error.message}</Callout> : null}
          {locked ? (
            <Callout tone="warn">
              Locked — host permissions pending. Paperclip ingestion stays disabled on team and personal spaces until LLM Wiki enforces read/write permissions for non-shared spaces.
            </Callout>
          ) : null}
          {data && data.historicalPageCount > 0 && data.effectiveState === "disabled" ? (
            <Callout>
              Off · {data.historicalPageCount} historical Paperclip page{data.historicalPageCount === 1 ? "" : "s"} still in this space. Disabling stops new observations but does not delete prior wiki pages.
            </Callout>
          ) : null}
          {data && data.overlapCount > 0 ? (
            <Callout>
              {data.overlapCount} source overlap{data.overlapCount === 1 ? "" : "s"} with another enabled space. Duplicate destinations are allowed, but they are explicit.
            </Callout>
          ) : null}
          {emptyScopes ? <Callout tone="warn">Pick at least one source scope before saving.</Callout> : null}
          {draft ? (
            <>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  disabled={locked || busy}
                  onChange={(event) => patchDraft({
                    enabled: event.currentTarget.checked,
                    sourceScopes: event.currentTarget.checked && draft.sourceScopes.length === 0
                      ? [{ kind: "active_projects", limit: activeProjectLimit }]
                      : draft.sourceScopes,
                  })}
                />
                <span>
                  Enable Paperclip ingestion for this destination space
                  <Tiny style={{ display: "block" }}>Future Paperclip issue, comment, and document events can advance cursors in {space.displayName}. Existing pages are preserved when this is turned off.</Tiny>
                </span>
              </label>
              <div style={{ display: "grid", gap: 8 }}>
                <strong style={{ fontSize: 13 }}>Source scope</strong>
                <label style={{ display: "grid", gap: 6, maxWidth: 260 }}>
                  <Tiny>Recently active projects (auto)</Tiny>
                  <TextInput
                    value={String(activeProjectLimit)}
                    disabled={locked || busy}
                    onChange={(event) => setActiveProjectsLimit(Number(event.currentTarget.value))}
                  />
                </label>
                <Tiny>Specific projects, issue trees, and company-wide ingestion use the same profile API; this first editor keeps the default auto-scope path visible and capped.</Tiny>
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                <strong style={{ fontSize: 13 }}>Source kinds</strong>
                {([
                  ["issues", "Issues"],
                  ["comments", "Comments"],
                  ["documents", "Documents"],
                ] as const).map(([key, label]) => (
                  <label key={key} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={draft.sourceKinds[key]}
                      disabled={locked || busy}
                      onChange={(event) => setSourceKind(key, event.currentTarget.checked)}
                    />
                    {label}
                  </label>
                ))}
                <Tiny>Attachments — locked, metadata only; no file contents. Future extraction needs separate review.</Tiny>
                <Tiny>Work products — locked, metadata only; no artifact contents.</Tiny>
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                <strong style={{ fontSize: 13 }}>Caps</strong>
                <Tiny>
                  Defaults: {draft.cursor.maxWindowCharacters.toLocaleString()} chars/window · {draft.cursor.maxCharactersPerSource.toLocaleString()} chars/source.
                </Tiny>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button size="sm" variant="primary" onClick={save} loading={busy} disabled={!canSave || emptyScopes}>Save Paperclip profile</Button>
                <Button size="sm" variant="ghost" onClick={() => setDraft(data?.profile ?? null)} disabled={busy}>Revert</Button>
              </div>
            </>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

function SpaceFolderHealthChecklist({ folder }: { folder: FolderStatus }) {
  const items = [
    { key: "readable", label: "Folder readable", ok: folder.readable },
    { key: "writable", label: "Folder writable", ok: folder.writable },
    ...folder.requiredDirectories.map((dir) => ({
      key: `dir-${dir}`,
      label: `${dir}/ present`,
      ok: !folder.missingDirectories.includes(dir),
    })),
    ...folder.requiredFiles.map((file) => ({
      key: `file-${file}`,
      label: `${file} present`,
      ok: !folder.missingFiles.includes(file),
    })),
  ];

  return (
    <div role="list" aria-label="Space folder health checklist" style={{ position: "relative", display: "grid", gap: 0, padding: "2px 0" }}>
      {items.length > 1 ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 8,
            top: 12,
            bottom: 12,
            width: 1,
            background: "oklch(0.38 0.09 145)",
          }}
        />
      ) : null}
      {items.map((item) => (
        <div
          key={item.key}
          role="listitem"
          style={{
            display: "grid",
            gridTemplateColumns: "18px minmax(0, 1fr)",
            alignItems: "center",
            gap: 10,
            padding: "7px 0",
            minWidth: 0,
          }}
        >
          <span style={{ display: "inline-flex", justifyContent: "center", position: "relative", zIndex: 1, background: tokens.bg }}>
            <StatusIcon status={item.ok ? "done" : "blocked"} />
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: item.ok ? tokens.fg : "oklch(0.85 0.1 70)" }}>
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}
