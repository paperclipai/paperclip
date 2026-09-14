import { AgentChatPicker } from "@/components/AgentChatPicker";
import { TaskChatProjectCreatedCard } from "@/components/task-chat/TaskChatProjectCreatedCard";
import { AnnouncementCard } from "@/components/AnnouncementCard";
import { announcementPreview, announcementAnimationPreview, announcementAnimationPreviewSrc } from "@/lib/announcement-preview";
import { TaskDetailTasksPanel } from "@/components/task-detail/TaskDetailTasksPanel";
import { AiConnectionDesignExamples } from "@/components/ai-connections/AiConnectionDesignExamples";
import { SavedProviderKeySelect } from "../components/onboarding/SavedProviderKeySelect";
import { RepositoryEditor } from "@/components/RepositoryEditor";
import { TaskChatRunnerActivityGroup } from "@/components/task-chat/TaskChatRunnerActivityGroup";
import { TaskChatMarker } from "@/components/task-chat/TaskChatMarker";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskTreeControlDialog, TaskTreeControlMenuItems } from "@/components/TaskTreeControls";
import { useState } from "react";
import { ServicesList } from "./apps/app-detail/ServicesPanel";
import { ComposioProvenanceChip } from "./apps/ComposioProvenanceChip";
import type { ComposioServiceRow } from "./apps/composio-services";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  Command as CommandIcon,
  DollarSign,
  Hexagon,
  History,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Mail,
  Plus,
  Search,
  Settings,
  Target,
  Trash2,
  Upload,
  User,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge } from "@/components/ui/badge";
import { InlineBanner } from "@/components/InlineBanner";
import { BuiltInLifecycleChip } from "@/components/BuiltInAgentBadges";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import { AgentCapsule, AGENT_GRADIENT_COUNT } from "@/components/AgentCapsule";
import { AgentRunCard } from "@/components/ActiveAgentsPanel";
import { StatusBadge, IssueStatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { EnforcementBanner } from "@/components/EnforcementBanner";
import { ActionCard, ActionCardMobile, BindingsTable } from "@/components/actions/ActionCard";
import { PriorityIcon } from "@/components/PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "@/lib/ui-flags";
import { agentStatusDot, agentStatusDotDefault } from "@/lib/status-colors";
import { EntityRow } from "@/components/EntityRow";
import { EmptyState } from "@/components/EmptyState";
import { MetricCard } from "@/components/MetricCard";
import { FilterBar, type FilterValue } from "@/components/FilterBar";
import { InlineEditor } from "@/components/InlineEditor";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Identity } from "@/components/Identity";
import { AppLogo } from "@/pages/apps/AppLogo";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { MembershipAction } from "@/components/MembershipAction";
import { IssueOutputSection } from "@/components/issue-output/IssueOutputSection";
import { EnvironmentVariablesEditor } from "@/components/environment-variables-editor";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import {
  connectedConnectionIntentInteraction,
  issueThreadInteractionFixtureMeta,
  pendingConnectionIntentInteraction,
  retryConnectionIntentInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import type { CompanySecret, EnvBinding, Issue } from "@paperclipai/shared";
import { CollectionToolbar } from "@/components/CollectionToolbar";
import { IssueRow } from "@/components/IssueRow";
import {
  EnvInputsList,
  ExternalSourcesList,
  RequiredSkillsList,
  StepSkillPlan,
  StepSourcePolicy,
  TeamCard,
  TeamHierarchyPreview,
  TeamRow,
} from "@/pages/TeamCatalog";
import {
  currentInstalledState,
  onboardingTeams,
  optionalTeam,
  outOfDateInstalledState,
  sampleSkillPreparations,
  sampleTeam,
  warnTeam,
} from "@/pages/TeamCatalog.fixtures";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { t } from "@/i18n";

/* ------------------------------------------------------------------ */
/*  Sample data for the Issue Output surface showcase                  */
/* ------------------------------------------------------------------ */

function sampleOutput(
  id: string,
  attachmentId: string,
  contentType: string,
  filename: string,
  opts: { byteSize: number; isPrimary?: boolean; createdAt: string },
): IssueWorkProduct {
  const contentPath = `/api/attachments/${attachmentId}/content`;
  return {
    id,
    companyId: "demo-company",
    projectId: null,
    issueId: "demo-issue",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: filename,
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: Boolean(opts.isPrimary),
    healthStatus: "unknown",
    summary: null,
    createdByRunId: null,
    createdAt: new Date(opts.createdAt),
    updatedAt: new Date(opts.createdAt),
    metadata: {
      attachmentId,
      contentType,
      byteSize: opts.byteSize,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
      originalFilename: filename,
    },
  } as IssueWorkProduct;
}

const DESIGN_GUIDE_OUTPUTS: IssueWorkProduct[] = [
  sampleOutput("wp-vid", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "video/mp4", "q3-summary.mp4", {
    byteSize: 19_293_798,
    isPrimary: true,
    createdAt: "2026-05-30T12:00:00Z",
  }),
  sampleOutput("wp-pdf", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "application/pdf", "talking-points.pdf", {
    byteSize: 421_888,
    createdAt: "2026-05-30T11:52:00Z",
  }),
];

const DESIGN_GUIDE_DEGRADED_OUTPUTS: IssueWorkProduct[] = [
  {
    ...sampleOutput("wp-broken", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "video/mp4", "corrupt-output.mp4", {
      byteSize: 0,
      isPrimary: true,
      createdAt: "2026-05-30T12:01:00Z",
    }),
    // Strip the path metadata so it fails the shared artifact schema.
    metadata: { attachmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", contentType: "video/mp4" },
  } as IssueWorkProduct,
];

const DESIGN_GUIDE_TASK = {
  id: "design-guide-task",
  identifier: "PAP-427",
  title: "Reconcile the navigation model across operator surfaces",
  status: "in_progress",
  priority: "medium",
  blockerAttention: false,
} as unknown as Issue;

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

/**
 * Composio service rows for the design guide (PAP-17865). One row per state, so
 * a reader can compare all four side by side rather than connecting a real
 * Composio project to see them.
 */
const DESIGN_GUIDE_COMPOSIO_ROWS: ComposioServiceRow[] = [
  {
    toolkitSlug: "github",
    name: "GitHub",
    description: "Issues, pull requests, and repository actions",
    logoUrl: null,
    state: "connected",
    connectedAccountStatus: "ACTIVE",
    childConnectionId: "design-guide-child",
    toolCount: 42,
    noAuth: false,
  },
  {
    toolkitSlug: "hubspot",
    name: "HubSpot",
    description: "CRM contacts and deals",
    logoUrl: null,
    state: "attention",
    connectedAccountStatus: "EXPIRED",
    childConnectionId: "design-guide-child-2",
    toolCount: 18,
    noAuth: false,
  },
  {
    toolkitSlug: "slack",
    name: "Slack",
    description: "Channels and messages",
    logoUrl: null,
    state: "pending",
    connectedAccountStatus: "INITIALIZING",
    childConnectionId: null,
    toolCount: 12,
    noAuth: false,
  },
  {
    toolkitSlug: "gmail",
    name: "Gmail",
    description: "Read and send mail",
    logoUrl: null,
    state: "not_connected",
    connectedAccountStatus: null,
    childConnectionId: null,
    toolCount: 9,
    noAuth: false,
  },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </h3>
      <Separator />
      {children}
    </section>
  );
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {children}
    </div>
  );
}

// Onboarding seam (design §6 + §12.5): the TeamCard tile in its "Pick a starter
// team" 3-col grid, with the first defaultInstall tile selected.
function TeamCardShowcase() {
  const [selectedId, setSelectedId] = useState(onboardingTeams[0]?.id ?? null);
  return (
    <div className="grid max-w-2xl gap-4 md:grid-cols-2 lg:grid-cols-3">
      {onboardingTeams.map((team) => (
        <TeamCard
          key={team.id}
          team={team}
          selected={team.id === selectedId}
          onSelect={() => setSelectedId(team.id)}
        />
      ))}
    </div>
  );
}

// Reusable environment-variables editor: one shared grid, in-field source
// switch, fuzzy secret picker, sensitive-value detection, inline health.
const DESIGN_GUIDE_SECRETS: CompanySecret[] = [
  {
    id: "dg-github",
    companyId: "dg",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: "github_token",
    name: "GITHUB_TOKEN",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-03-01T10:00:00.000Z"),
    updatedAt: new Date("2026-03-01T10:00:00.000Z"),
  },
  {
    id: "dg-db",
    companyId: "dg",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: "db_connection",
    name: "DB_CONNECTION",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-03-01T10:00:00.000Z"),
    updatedAt: new Date("2026-03-01T10:00:00.000Z"),
  },
];

function EnvironmentVariablesEditorShowcase() {
  const [env, setEnv] = useState<Record<string, EnvBinding>>({
    NODE_ENV: { type: "plain", value: "production" },
    GH_TOKEN: { type: "secret_ref", secretId: "dg-github", version: "latest" },
    DB_URL: { type: "secret_ref", secretId: "dg-db", version: 3 },
    STRIPE_API_KEY: { type: "plain", value: "sk-live-51H8xL0aBcDeFgHiJkLmNoPq" },
  });
  return (
    <div className="max-w-(--sz-640px) rounded-md border border-border p-4">
      <EnvironmentVariablesEditor
        value={env}
        secrets={DESIGN_GUIDE_SECRETS}
        onChange={(next) => setEnv(next ?? {})}
        onCreateSecret={async (name) => ({
          ...DESIGN_GUIDE_SECRETS[0]!,
          id: `dg-${name}`,
          key: name,
          name: name.toUpperCase(),
          latestVersion: 1,
        })}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Color swatch                                                       */
/* ------------------------------------------------------------------ */

function Swatch({ name, cssVar }: { name: string; cssVar: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-8 w-8 rounded-md border border-border shrink-0"
        style={{ backgroundColor: `var(${cssVar})` }}
      />
      <div>
        <p className="text-xs font-mono">{cssVar}</p>
        <p className="text-xs text-muted-foreground">{name}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

function TaskExecutionControlsExample() {
  const [running, setRunning] = useState(true);
  const [dialogMode, setDialogMode] = useState<"resume" | "cancel" | "restore" | null>(null);
  const [wake, setWake] = useState(true);
  return <div className="max-w-xl space-y-4">
    <div className="w-52 rounded-md border border-border p-1">
      <TaskTreeControlMenuItems scope="subtree" canPause={running} canResume={!running} canCancel canRestore={!running}
        onPause={() => setRunning(false)} onResume={() => setDialogMode("resume")}
        onCancel={() => setDialogMode("cancel")} onRestore={() => setDialogMode("restore")} />
    </div>
    <p className="text-sm text-muted-foreground">{running ? "Running: type to switch Stop to Send." : "Paused: resume from the menu."}</p>
    <TaskChatProjectCreatedCard item={{ id: "design-project", kind: "project_created", projectId: "example-project", name: "Onboarding improvements", description: "Help new teams reach their first useful result.", timestamp: "2026-09-11T00:00:00Z", repositories: [{ id: "1", name: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip" }] }} />
    {!running ? <TaskChatMarker item={{ id: "design-cancelled", kind: "marker", variant: "interrupted", tone: "neutral", label: "Run cancelled", detail: "The run was cancelled before returning an answer.", collapsible: true }} /> : null}
    <TaskChatComposer pause={!running ? { scope: "subtree", onResume: () => setDialogMode("resume") } : null} onAdd={async () => {}} workMode="standard" stopScope="subtree" onStop={running ? async () => setRunning(false) : undefined} />
    <TaskTreeControlDialog open={dialogMode !== null} onOpenChange={(open) => { if (!open) setDialogMode(null); }}
      mode={dialogMode ?? "cancel"} scope="subtree" affectedCount={3} affectedAgentCount={2} loading={false} pending={false} valid
      wakeAgents={wake} onWakeAgentsChange={setWake} onRetry={() => {}}
      onApply={() => { setRunning(dialogMode !== "cancel" && wake); setDialogMode(null); }} />
  </div>;
}

function AgentChatPickerExample() {
  const [state, setState] = useState<"closed" | "empty" | "loading" | "error">("closed");
  return <div className="flex flex-wrap gap-2">
    <Button variant="outline" onClick={() => setState("empty")}>{t("design-guide.empty-picker-5ar")}</Button>
    <Button variant="outline" onClick={() => setState("loading")}>{t("design-guide.loading-picker-x1v")}</Button>
    <Button variant="outline" onClick={() => setState("error")}>{t("design-guide.failed-picker-nv9")}</Button>
    <AgentChatPicker agents={[]} open={state !== "closed"} onOpenChange={(open) => { if (!open) setState("closed"); }} onSelect={() => {}}
      loading={state === "loading"} error={state === "error" ? new Error("Unavailable") : null} onRetry={() => setState("empty")} />
  </div>;
}

export function DesignGuide() {
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("medium");
  const [selectValue, setSelectValue] = useState("in_progress");
  const [menuChecked, setMenuChecked] = useState(true);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  const [inlineText, setInlineText] = useState("Click to edit this text");
  const [inlineTitle, setInlineTitle] = useState("Editable Title");
  const [inlineDesc, setInlineDesc] = useState(
    "This is an editable description. Click to edit it — the textarea auto-sizes to fit the content without layout shift."
  );
  const [filters, setFilters] = useState<FilterValue[]>([
    { key: "status", label: "Status", value: "Active" },
    // PAP-411: priority filter demo row suppressed while SHOW_TASK_PRIORITY_UI is off.
    ...(SHOW_TASK_PRIORITY_UI
      ? [{ key: "priority", label: "Priority", value: "High" } as FilterValue]
      : []),
  ]);
  const [allowExternal, setAllowExternal] = useState(false);
  const [allowUnpinned, setAllowUnpinned] = useState(false);
  const [allowLocalPath, setAllowLocalPath] = useState(false);

  return (
    <div className="space-y-10 max-w-4xl">
      {/* Page header */}
      <div>
        <h2 className="text-xl font-bold">{t("design-guide.design-guide-1x9")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("design-guide.every-component-style-and-pattern-us-h0a")}
        </p>
      </div>

      {/* ============================================================ */}
      {/*  COVERAGE                                                     */}
      {/* ============================================================ */}
      <Section title={t("design-guide.component-coverage-13z")}>
        <p className="text-sm text-muted-foreground">
          {t("design-guide.this-page-should-be-updated-when-new-8xr")}
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={t("design-guide.ui-primitives-1lv")}>
            <div className="flex flex-wrap gap-2">
              {[
                "avatar", "badge", "breadcrumb", "button", "card", "checkbox", "collapsible",
                "command", "dialog", "dropdown-menu", "input", "label", "popover", "resizable-panels",
                "scroll-area", "select", "separator", "sheet", "skeleton", "tabs", "textarea", "tooltip",
              ].map((name) => (
                <Badge key={name} variant="outline" className="font-mono text-(length:--text-nano)">
                  {name}
                </Badge>
              ))}
            </div>
          </SubSection>
          <SubSection title={t("design-guide.app-components-qzk")}>
            <div className="flex flex-wrap gap-2">
              {[
                "StatusBadge", "StatusIcon", "PriorityIcon", "EntityRow", "EmptyState", "MetricCard",
                "FilterBar", "InlineEditor", "PageSkeleton", "Identity", "CommentThread", "MarkdownEditor",
                "PropertiesPanel", "Sidebar", "CommandPalette", "EnvironmentVariablesEditor",
                "InlineBanner", "BuiltInAgentGate", "BuiltInLifecycleChip", "CollectionToolbar",
                "IssueRow", "ContextualSidebarFrame",
              ].map((name) => (
                <Badge key={name} variant="ghost" className="font-mono text-(length:--text-nano)">
                  {name}
                </Badge>
              ))}
            </div>
          </SubSection>
        </div>
      </Section>

      <Section title={t("design-guide.announcements-him")}>
        <div className="grid gap-4 md:grid-cols-2">
          <AnnouncementCard announcement={announcementAnimationPreview} imageSrc="/announcement-preview.svg" animationSrc={announcementAnimationPreviewSrc} onDismiss={() => {}} />
          <AnnouncementCard announcement={announcementPreview} imageSrc="/announcement-preview.svg" onDismiss={() => {}} />
          <AnnouncementCard announcement={{ ...announcementPreview, image: undefined, secondaryLink: undefined }} onDismiss={() => {}} />
        </div>
      </Section>

      <Section title={t("design-guide.task-execution-controls-1c0")}>
        <TaskExecutionControlsExample />
      </Section>

      <Section title={t("design-guide.task-collection-1kf")}>
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("design-guide.collection-toolbar-owns-shared-geome-1rm")}
        </p>
        <CollectionToolbar
          context={<span className="text-sm font-medium">{t("design-guide.recent-tasks-c2c")}</span>}
          search={<Input aria-label={t("design-guide.search-task-collection-example-rvi")} placeholder={t("design-guide.search-tasks-eir")} />}
          controls={<Button variant="outline" size="sm">{t("design-guide.filter-1vv")}</Button>}
          actions={<Button size="sm">{t("design-guide.new-task-sc4")}</Button>}
          feedback={<span className="text-xs text-muted-foreground">{t("design-guide.1-task-updated-newest-first-1ow")}</span>}
        />
        <div className="overflow-hidden rounded-lg border border-border">
          <IssueRow
            issue={DESIGN_GUIDE_TASK}
            presentation="task"
            unreadState="visible"
            metadata={<span className="text-xs text-muted-foreground">{t("design-guide.updated-12m-ago-171")}</span>}
            actions={<Button variant="ghost" size="xs">{t("design-guide.more-lz6")}</Button>}
          />
        </div>
      </Section>

      <Section title={t("design-guide.theme-toggle-8jw")}>
        <SubSection title={t("design-guide.variants-vqe")}>
          <div className="flex max-w-sm flex-col items-start gap-3">
            <ThemeToggle />
            <ThemeToggle variant="menu-action" />
            <ThemeToggle variant="compact-menu-action" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  COLORS                                                       */}
      {/* ============================================================ */}
      <Section title={t("design-guide.colors-agw")}>
        <SubSection title={t("design-guide.core-pyd")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Background" cssVar="--background" />
            <Swatch name="Foreground" cssVar="--foreground" />
            <Swatch name="Card" cssVar="--card" />
            <Swatch name="Primary" cssVar="--primary" />
            <Swatch name="Primary foreground" cssVar="--primary-foreground" />
            <Swatch name="Secondary" cssVar="--secondary" />
            <Swatch name="Muted" cssVar="--muted" />
            <Swatch name="Muted foreground" cssVar="--muted-foreground" />
            <Swatch name="Accent" cssVar="--accent" />
            <Swatch name="Destructive" cssVar="--destructive" />
            <Swatch name="Border" cssVar="--border" />
            <Swatch name="Ring" cssVar="--ring" />
          </div>
        </SubSection>

        <SubSection title={t("design-guide.sidebar-197")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Sidebar" cssVar="--sidebar" />
            <Swatch name="Sidebar border" cssVar="--sidebar-border" />
          </div>
        </SubSection>

        <SubSection title={t("design-guide.chart-8pj")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Chart 1" cssVar="--chart-1" />
            <Swatch name="Chart 2" cssVar="--chart-2" />
            <Swatch name="Chart 3" cssVar="--chart-3" />
            <Swatch name="Chart 4" cssVar="--chart-4" />
            <Swatch name="Chart 5" cssVar="--chart-5" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TYPOGRAPHY                                                   */}
      {/* ============================================================ */}
      <Section title={t("design-guide.runner-activity-ocv")}>
        <TaskChatRunnerActivityGroup item={{ id: "design-runner-activity", kind: "activity_phase", active: true, summary: "", interstitial: { id: "design-runner-commentary", kind: "message", author: "agent", text: "I’ll inspect the activity feed and check the layout.", interstitial: true }, items: [
          { id: "design-runner-read", kind: "tool", name: "read", target: "TaskChatRunnerTurn.tsx", status: "completed", detail: "Found the activity groups." },
          { id: "design-runner-check", kind: "tool", name: "exec_command", target: "pnpm check:token-gates", status: "in_progress" },
        ] }} />
        <TaskChatRunnerActivityGroup item={{ id: "design-runner-completed", kind: "activity_phase", active: false, summary: "", items: [
          { id: "design-completed-read", kind: "tool", name: "read", target: "TaskChatRunnerTurn.tsx", status: "completed", detail: "Read the activity groups." },
          { id: "design-completed-check", kind: "tool", name: "exec_command", target: "pnpm check:token-gates", status: "failed", detail: "A token check needs another pass." },
        ] }} />
      </Section>

      <Section title={t("design-guide.typography-hpg")}>
        <div className="space-y-3">
          <h2 className="text-xl font-bold">{t("design-guide.page-title-text-xl-font-bold-1fk")}</h2>
          <h2 className="text-lg font-semibold">{t("design-guide.section-title-text-lg-font-semibold-12d")}</h2>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            {t("design-guide.section-heading-text-sm-font-semibol-1di")}
          </h3>
          <p className="text-sm font-medium">{t("design-guide.card-title-text-sm-font-medium-1n6")}</p>
          <p className="text-sm font-semibold">{t("design-guide.card-title-alt-text-sm-font-semibold-1uk")}</p>
          <p className="text-sm">{t("design-guide.body-text-text-sm-36t")}</p>
          <p className="text-sm text-muted-foreground">
            Muted description — text-sm text-muted-foreground
          </p>
          <p className="text-xs text-muted-foreground">
            Tiny label — text-xs text-muted-foreground
          </p>
          <p className="text-sm font-mono text-muted-foreground">
            Mono identifier — text-sm font-mono text-muted-foreground
          </p>
          <p className="text-2xl font-bold">{t("design-guide.large-stat-text-2xl-font-bold-1k9")}</p>
          <p className="font-mono text-xs">{t("design-guide.log-code-text-font-mono-text-xs-19u")}</p>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SPACING & RADIUS                                             */}
      {/* ============================================================ */}
      <Section title={t("design-guide.radius-g8d")}>
        <div className="flex items-end gap-4 flex-wrap">
          {[
            ["sm", "var(--radius-sm)"],
            ["md", "var(--radius-md)"],
            ["lg", "var(--radius-lg)"],
            ["xl", "var(--radius-xl)"],
            ["full", "9999px"],
          ].map(([label, radius]) => (
            <div key={label} className="flex flex-col items-center gap-1">
              <div
                className="h-12 w-12 bg-primary"
                style={{ borderRadius: radius }}
              />
              <span className="text-xs text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BUTTONS                                                      */}
      {/* ============================================================ */}
      <Section title={t("design-guide.buttons-ckr")}>
        <SubSection title={t("design-guide.variants-vqe")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="default">{t("design-guide.default-76b")}</Button>
            <Button variant="secondary">{t("design-guide.secondary-75q")}</Button>
            <Button variant="outline">{t("design-guide.outline-4l1")}</Button>
            <Button variant="ghost">{t("design-guide.ghost-8bh")}</Button>
            <Button variant="destructive">{t("design-guide.destructive-c80")}</Button>
            <Button variant="link">{t("design-guide.link-13e")}</Button>
          </div>
        </SubSection>

        <SubSection title={t("design-guide.sizes-1m6")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="xs">{t("design-guide.extra-small-1g5")}</Button>
            <Button size="sm">{t("design-guide.small-k47")}</Button>
            <Button size="default">{t("design-guide.default-76b")}</Button>
            <Button size="lg">{t("design-guide.large-1v0")}</Button>
          </div>
        </SubSection>

        <SubSection title={t("design-guide.icon-buttons-1b3")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" size="icon-xs"><Search /></Button>
            <Button variant="ghost" size="icon-sm"><Search /></Button>
            <Button variant="outline" size="icon"><Search /></Button>
            <Button variant="outline" size="icon-lg"><Search /></Button>
          </div>
        </SubSection>

        <SubSection title={t("design-guide.with-icons-1ux")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button><Plus /> {t("design-guide.new-issue-67v")}</Button>
            <Button variant="outline"><Upload /> {t("design-guide.upload-106")}</Button>
            <Button variant="destructive"><Trash2 /> {t("design-guide.delete-oay")}</Button>
            <Button size="sm"><Plus /> {t("design-guide.add-17r")}</Button>
          </div>
        </SubSection>

        <SubSection title={t("design-guide.states-5af")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button disabled>{t("design-guide.disabled-1h7")}</Button>
            <Button variant="outline" disabled>{t("design-guide.disabled-outline-wq3")}</Button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  BADGES                                                       */}
      {/* ============================================================ */}
      <Section title={t("design-guide.badges-1tk")}>
        <SubSection title={t("design-guide.variants-vqe")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="default">{t("design-guide.default-76b")}</Badge>
            <Badge variant="secondary">{t("design-guide.secondary-75q")}</Badge>
            <Badge variant="outline">{t("design-guide.outline-4l1")}</Badge>
            <Badge variant="destructive">{t("design-guide.destructive-c80")}</Badge>
            <Badge variant="ghost">{t("design-guide.ghost-8bh")}</Badge>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  STATUS BADGES & ICONS                                        */}
      {/* ============================================================ */}
      <Section title={t("design-guide.status-system-sl9")}>
        <SubSection title={t("design-guide.status-badge-all-statuses-x12")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              "active", "running", "paused", "idle", "archived", "planned",
              "achieved", "completed", "failed", "timed_out", "succeeded", "error",
              "pending_approval", "backlog", "todo", "in_progress", "in_review", "blocked",
              "done", "terminated", "cancelled", "pending", "revision_requested",
              "approved", "rejected",
            ].map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
        </SubSection>

        <SubSection title={t("design-guide.issue-status-badge-brand-chip-glyph-e84")}>
          <div className="flex items-center gap-2 flex-wrap">
            {["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"].map(
              (s) => (
                <IssueStatusBadge key={s} status={s} />
              )
            )}
          </div>
        </SubSection>

        <SubSection title={t("design-guide.status-icon-interactive-1dz")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"].map(
              (s) => (
                <div key={s} className="flex items-center gap-1.5">
                  <StatusIcon status={s} />
                  <span className="text-xs text-muted-foreground">{s}</span>
                </div>
              )
            )}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <StatusIcon status={status} onChange={setStatus} />
            <span className="text-sm">{t("design-guide.click-the-icon-to-change-status-curr-1x9")} {status})</span>
          </div>
        </SubSection>

        {/* PAP-411: PriorityIcon showcase gated behind SHOW_TASK_PRIORITY_UI per board decision. */}
        {SHOW_TASK_PRIORITY_UI && (
        <SubSection title={t("design-guide.priority-icon-interactive-1dv")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["critical", "high", "medium", "low"].map((p) => (
              <div key={p} className="flex items-center gap-1.5">
                <PriorityIcon priority={p} />
                <span className="text-xs text-muted-foreground">{p}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <PriorityIcon priority={priority} onChange={setPriority} />
            <span className="text-sm">{t("design-guide.click-the-icon-to-change-current-215")} {priority})</span>
          </div>
        </SubSection>
        )}

        <SubSection title={t("design-guide.agent-status-dots-1nw")}>
          <div className="flex items-center gap-4 flex-wrap">
            {(["running", "active", "paused", "error", "archived"] as const).map((label) => (
              <div key={label} className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className={`inline-flex h-full w-full rounded-full ${agentStatusDot[label] ?? agentStatusDotDefault}`} />
                </span>
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title={t("design-guide.run-invocation-badges-1g7")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              ["timer", "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"],
              ["assignment", "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"],
              ["on_demand", "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"],
              ["automation", "bg-muted text-muted-foreground"],
            ].map(([label, cls]) => (
              <Badge variant="ghost" key={label} className={`px-1.5 text-(length:--text-nano) ${cls}`}>
                {label}
              </Badge>
            ))}
          </div>
        </SubSection>

        <SubSection title={t("design-guide.issue-reference-pill-1wb")}>
          <p className="text-xs text-muted-foreground">
            {t("design-guide.used-wherever-a-task-is-referenced-i-vxv")} <code className="font-mono">status</code> {t("design-guide.to-show-the-target-issue-s-state-at-1h9")} <code className="font-mono">variant="property"</code> {t("design-guide.for-compact-badges-with-direct-navig-la2")} <code className="font-mono">onRemove</code> {t("design-guide.for-a-separate-blocker-removal-contr-1qm")} <code className="font-mono">strikethrough</code> {t("design-guide.for-removed-contexts-13l")}
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <IssueReferencePill issue={{ id: "demo-1", identifier: "PAP-123", title: "Identifier only — no status yet" }} />
            <IssueReferencePill issue={{ id: "demo-2", identifier: "PAP-456", title: "With in_progress status", status: "in_progress" }} />
            <IssueReferencePill issue={{ id: "demo-3", identifier: "PAP-789", title: "Done status", status: "done" }} />
            <IssueReferencePill issue={{ id: "demo-4", identifier: "PAP-101", title: "Blocked status", status: "blocked" }} />
            <IssueReferencePill onRemove={() => window.alert("Blocker removed")} issue={{ id: "demo-blocker", identifier: "PAP-303", title: "Hover or focus to remove blocker", status: "in_review" }} />
            <IssueReferencePill strikethrough issue={{ id: "demo-5", identifier: "PAP-202", title: "Removed (strikethrough)", status: "todo" }} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  AGENT CAPSULE                                                */}
      {/* ============================================================ */}
      <Section title={t("design-guide.agent-capsule-1bq")}>
        <p className="text-sm text-muted-foreground max-w-prose">
          {t("design-guide.the-brand-capsule-is-the-agent-motif-qgm")}<code className="font-mono">--agent-Na</code> →{" "}
          <code className="font-mono">--agent-Nb</code>); <code className="font-mono">prefers-reduced-motion</code>{" "}
          {t("design-guide.skips-the-liquid-rise-and-pulses-and-1t0")}
        </p>
        <SubSection title={t("design-guide.states-5af")}>
          <div className="flex items-end gap-10">
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="slot" />
              <span className="text-xs text-muted-foreground">slot</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="configured" />
              <span className="text-xs text-muted-foreground">configured</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" gradient={5} />
              <span className="text-xs text-muted-foreground">online</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" gradient={5} glow="blue" />
              <span className="text-xs text-muted-foreground">{t("design-guide.online-blue-glow-ypu")}</span>
            </div>
          </div>
        </SubSection>
        <SubSection title={t("design-guide.sizes-1m6")}>
          <div className="flex items-end gap-8">
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size="sm" gradient={1} />
              <span className="text-xs text-muted-foreground">sm</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size="md" gradient={4} />
              <span className="text-xs text-muted-foreground">md</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size="lg" gradient={8} />
              <span className="text-xs text-muted-foreground">lg</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size={{ width: 28, height: 96 }} gradient={6} />
              <span className="text-xs text-muted-foreground">{t("design-guide.custom-px-ido")}</span>
            </div>
          </div>
        </SubSection>
        <SubSection title={t("design-guide.gradients-1um")}>
          <div className="flex items-end gap-3 flex-wrap">
            {Array.from({ length: AGENT_GRADIENT_COUNT }, (_, i) => (
              <div key={i} className="flex flex-col items-center gap-1.5">
                <AgentCapsule state="online" size="sm" gradient={i + 1} />
                <span className="text-(length:--text-nano) font-mono text-muted-foreground">{i + 1}</span>
              </div>
            ))}
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  FORM ELEMENTS                                                */}
      {/* ============================================================ */}
      <Section title={t("design-guide.form-elements-117")}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={t("design-guide.input-189")}>
            <Input placeholder={t("design-guide.default-input-al3")} />
            <Input placeholder={t("design-guide.disabled-input-t9c")} disabled className="mt-2" />
          </SubSection>

          <SubSection title={t("design-guide.textarea-xx1")}>
            <Textarea placeholder={t("design-guide.write-something-14y")} />
          </SubSection>

          <SubSection title={t("design-guide.checkbox-label-bse")}>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox id="check1" defaultChecked />
                <Label htmlFor="check1">{t("design-guide.checked-item-157")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check2" />
                <Label htmlFor="check2">{t("design-guide.unchecked-item-qtp")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check3" disabled />
                <Label htmlFor="check3">{t("design-guide.disabled-item-1qi")}</Label>
              </div>
            </div>
          </SubSection>

          <SubSection title={t("design-guide.inline-editor-138")}>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("design-guide.title-single-line-sgp")}</p>
                <InlineEditor
                  value={inlineTitle}
                  onSave={setInlineTitle}
                  as="h2"
                  className="text-xl font-bold"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("design-guide.body-text-single-line-14y")}</p>
                <InlineEditor
                  value={inlineText}
                  onSave={setInlineText}
                  as="p"
                  className="text-sm"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("design-guide.description-multiline-auto-sizing-y9p")}</p>
                <InlineEditor
                  value={inlineDesc}
                  onSave={setInlineDesc}
                  as="p"
                  className="text-sm text-muted-foreground"
                  placeholder={t("design-guide.add-a-description-eaz")}
                  multiline
                />
              </div>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SELECT                                                       */}
      {/* ============================================================ */}
      <Section title={t("design-guide.select-hcn")}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={t("design-guide.default-size-1av")}>
            <Select value={selectValue} onValueChange={setSelectValue}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("design-guide.select-status-g3n")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="backlog">{t("design-guide.backlog-r6y")}</SelectItem>
                <SelectItem value="todo">{t("design-guide.todo-1dj")}</SelectItem>
                <SelectItem value="in_progress">{t("design-guide.in-progress-w3n")}</SelectItem>
                <SelectItem value="in_review">{t("design-guide.in-review-z7u")}</SelectItem>
                <SelectItem value="done">{t("design-guide.done-13c")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("design-guide.current-value-8tm")} {selectValue}</p>
          </SubSection>
          <SubSection title={t("design-guide.small-trigger-v28")}>
            <Select defaultValue="high">
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">{t("design-guide.critical-11o")}</SelectItem>
                <SelectItem value="high">{t("design-guide.high-1gq")}</SelectItem>
                <SelectItem value="medium">{t("design-guide.medium-2pb")}</SelectItem>
                <SelectItem value="low">{t("design-guide.low-1dc")}</SelectItem>
              </SelectContent>
            </Select>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DROPDOWN MENU                                                */}
      {/* ============================================================ */}
      <Section title={t("design-guide.dropdown-menu-1lm")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t("design-guide.quick-actions-134")}
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem>
              <Check className="h-4 w-4" />
              {t("design-guide.mark-as-done-1v9")}
              <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <BookOpen className="h-4 w-4" />
              {t("design-guide.open-docs-f42")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={menuChecked}
              onCheckedChange={(value) => setMenuChecked(value === true)}
            >
              {t("design-guide.watch-issue-19g")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem variant="destructive">
              <Trash2 className="h-4 w-4" />
              {t("design-guide.delete-issue-ege")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      {/* ============================================================ */}
      {/*  POPOVER                                                      */}
      {/* ============================================================ */}
      <Section title={t("design-guide.popover-1rp")}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">{t("design-guide.open-popover-sbk")}</Button>
          </PopoverTrigger>
          <PopoverContent className="space-y-2">
            <p className="text-sm font-medium">{t("design-guide.agent-heartbeat-161")}</p>
            <p className="text-xs text-muted-foreground">
              {t("design-guide.last-run-succeeded-24s-ago-next-time-qyd")}
            </p>
            <Button size="xs">{t("design-guide.wake-now-17l")}</Button>
          </PopoverContent>
        </Popover>
      </Section>

      {/* ============================================================ */}
      {/*  COLLAPSIBLE                                                  */}
      {/* ============================================================ */}
      <Section title={t("design-guide.collapsible-160")}>
        <Collapsible open={collapsibleOpen} onOpenChange={setCollapsibleOpen} className="space-y-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              {collapsibleOpen ? "Hide" : "Show"} {t("design-guide.advanced-filters-ipp")}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border border-border p-3">
            <div className="space-y-2">
              <Label htmlFor="owner-filter">{t("design-guide.owner-171")}</Label>
              <Input id="owner-filter" placeholder={t("design-guide.filter-by-agent-name-14u")} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Section>

      {/* ============================================================ */}
      {/*  SHEET                                                        */}
      {/* ============================================================ */}
      <Section title={t("design-guide.sheet-1bq")}>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm">{t("design-guide.open-side-panel-b10")}</Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>{t("design-guide.issue-properties-1np")}</SheetTitle>
              <SheetDescription>{t("design-guide.edit-metadata-without-leaving-the-cu-r3d")}</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4">
              <div className="space-y-1">
                <Label htmlFor="sheet-title">{t("design-guide.title-a7v")}</Label>
                <Input id="sheet-title" defaultValue="Improve onboarding docs" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sheet-description">{t("design-guide.description-sjj")}</Label>
                <Textarea id="sheet-description" defaultValue="Capture setup pitfalls and screenshots." />
              </div>
            </div>
            <SheetFooter>
              <Button variant="outline">{t("design-guide.cancel-ew9")}</Button>
              <Button>{t("design-guide.save-lew")}</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Section>

      {/* ============================================================ */}
      {/*  SCROLL AREA                                                  */}
      {/* ============================================================ */}
      <Section title={t("design-guide.scroll-area-9xn")}>
        <ScrollArea className="h-36 rounded-md border border-border">
          <div className="space-y-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-sm">
                {t("design-guide.heartbeat-run-1b0")}{i + 1}{t("design-guide.completed-successfully-1vw")}
              </div>
            ))}
          </div>
        </ScrollArea>
      </Section>

      {/* ============================================================ */}
      {/*  COMMAND                                                      */}
      {/* ============================================================ */}
      <Section title={t("design-guide.command-cmdk-1bv")}>
        <div className="rounded-md border border-border">
          <Command>
            <CommandInput placeholder={t("design-guide.type-a-command-or-search-1bt")} />
            <CommandList>
              <CommandEmpty>{t("design-guide.no-results-found-4mo")}</CommandEmpty>
              <CommandGroup heading="Pages">
                <CommandItem>
                  <LayoutDashboard className="h-4 w-4" />
                  {t("design-guide.dashboard-4zf")}
                </CommandItem>
                <CommandItem>
                  <CircleDot className="h-4 w-4" />
                  {t("design-guide.issues-1he")}
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Actions">
                <CommandItem>
                  <CommandIcon className="h-4 w-4" />
                  {t("design-guide.open-command-palette-12e")}
                </CommandItem>
                <CommandItem>
                  <Plus className="h-4 w-4" />
                  {t("design-guide.create-new-issue-10m")}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BREADCRUMB                                                   */}
      {/* ============================================================ */}
      <Section title={t("design-guide.breadcrumb-dfc")}>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{t("design-guide.projects-s0r")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{t("design-guide.paperclip-app-pdd")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{t("design-guide.issue-list-1sb")}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Section>

      {/* ============================================================ */}
      {/*  CARDS                                                        */}
      {/* ============================================================ */}
      <Section title={t("design-guide.cards-bp2")}>
        <SubSection title={t("design-guide.dashboard-agent-runs-j9o")}>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {["running", "queued", "succeeded", "failed", "timed_out", "cancelled", "interrupted"].map((status) => (
              <AgentRunCard
                key={status}
                companyId="design-guide"
                run={{
                  id: `design-guide-${status}`, agentId: "design-guide-agent", agentName: "CodexCoder",
                  status, adapterType: "codex_local", invocationSource: "on_demand", triggerDetail: "manual",
                  startedAt: null, finishedAt: null, createdAt: "2026-09-11T12:00:00Z", issueId: "design-guide-task",
                }}
                issue={{ identifier: "PAP-559", title: "Recreate this wireframe on pages Paperclip", status: status === "succeeded" ? "done" : "in_progress" }}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("design-guide.the-dashboard-and-live-runs-page-use-wot")}</p>
        </SubSection>
        <SubSection title={t("design-guide.standard-card-1ko")}>
          <Card>
            <CardHeader>
              <CardTitle>{t("design-guide.card-title-h0m")}</CardTitle>
              <CardDescription>{t("design-guide.card-description-with-supporting-tex-18w")}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{t("design-guide.card-content-goes-here-this-is-the-m-194")}</p>
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">{t("design-guide.action-2wk")}</Button>
              <Button variant="outline" size="sm">{t("design-guide.cancel-ew9")}</Button>
            </CardFooter>
          </Card>
        </SubSection>

        <SubSection title={t("design-guide.metric-cards-1ub")}>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard icon={Bot} value={12} label={t("design-guide.active-agents-1wr")} description={t("design-guide.3-this-week-ddq")} />
            <MetricCard icon={CircleDot} value={48} label={t("design-guide.open-issues-1sd")} />
            <MetricCard icon={DollarSign} value="$1,234" label={t("design-guide.monthly-cost-1wa")} description={t("design-guide.under-budget-1e4")} />
            <MetricCard icon={Zap} value="99.9%" label={t("design-guide.uptime-ijq")} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TABS                                                         */}
      {/* ============================================================ */}
      <Section title={t("design-guide.tabs-13m")}>
        <SubSection title={t("design-guide.default-pill-variant-1n0")}>
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">{t("design-guide.overview-thn")}</TabsTrigger>
              <TabsTrigger value="runs">{t("design-guide.runs-16t")}</TabsTrigger>
              <TabsTrigger value="config">{t("design-guide.config-tfj")}</TabsTrigger>
              <TabsTrigger value="costs">{t("design-guide.costs-1fk")}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <p className="text-sm text-muted-foreground py-4">{t("design-guide.overview-tab-content-n21")}</p>
            </TabsContent>
            <TabsContent value="runs">
              <p className="text-sm text-muted-foreground py-4">{t("design-guide.runs-tab-content-1mh")}</p>
            </TabsContent>
            <TabsContent value="config">
              <p className="text-sm text-muted-foreground py-4">{t("design-guide.config-tab-content-162")}</p>
            </TabsContent>
            <TabsContent value="costs">
              <p className="text-sm text-muted-foreground py-4">{t("design-guide.costs-tab-content-12x")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>

        <SubSection title={t("design-guide.line-variant-bpa")}>
          <Tabs defaultValue="summary">
            <TabsList variant="line">
              <TabsTrigger value="summary">{t("design-guide.summary-i4c")}</TabsTrigger>
              <TabsTrigger value="details">{t("design-guide.details-43f")}</TabsTrigger>
              <TabsTrigger value="comments">{t("design-guide.comments-mui")}</TabsTrigger>
            </TabsList>
            <TabsContent value="summary">
              <p className="text-sm text-muted-foreground py-4">{t("design-guide.summary-content-with-underline-tabs-la1")}</p>
            </TabsContent>
            <TabsContent value="details">
              <p className="text-sm text-muted-foreground py-4">{t("design-guide.details-content-18h")}</p>
            </TabsContent>
            <TabsContent value="comments">
              <p className="text-sm text-muted-foreground py-4">{t("design-guide.comments-content-59o")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  ENTITY ROWS                                                  */}
      {/* ============================================================ */}
      <Section title={t("design-guide.entity-rows-opj")}>
        <div className="border border-border rounded-md">
          <EntityRow
            leading={
              <>
                <StatusIcon status="in_progress" />
                {/* PAP-411: PriorityIcon hidden behind SHOW_TASK_PRIORITY_UI. */}
                {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority="high" />}
              </>
            }
            identifier="PAP-001"
            title={t("design-guide.implement-authentication-flow-18l")}
            subtitle="Responsible: Agent Alpha"
            trailing={<IssueStatusBadge status="in_progress" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="done" />
                {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority="medium" />}
              </>
            }
            identifier="PAP-002"
            title={t("design-guide.set-up-ci-cd-pipeline-1ta")}
            subtitle="Completed 2 days ago"
            trailing={<IssueStatusBadge status="done" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="todo" />
                {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority="low" />}
              </>
            }
            identifier="PAP-003"
            title={t("design-guide.write-api-documentation-lba")}
            trailing={<IssueStatusBadge status="todo" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="blocked" />
                {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority="critical" />}
              </>
            }
            identifier="PAP-004"
            title={t("design-guide.deploy-to-production-5u8")}
            subtitle="Blocked by PAP-001"
            trailing={<IssueStatusBadge status="blocked" />}
            selected
          />
        </div>
        <SubSection title={t("design-guide.membership-action-h9m")}>
          <div className="border border-border rounded-md">
            <EntityRow
              title={t("design-guide.joined-resource-h9d")}
              subtitle="Hover or focus the row to reveal the reserved action slot."
              className="group"
              trailing={
                <MembershipAction
                  state="joined"
                  resourceName="Joined resource"
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title={t("design-guide.left-resource-t2d")}
              subtitle="Persistent action with dimmed row content."
              className="group text-foreground/55"
              trailing={
                <MembershipAction
                  state="left"
                  resourceName="Left resource"
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title={t("design-guide.leaving-resource-d76")}
              subtitle="Disabled while the optimistic mutation is pending."
              className="group text-foreground/55"
              trailing={
                <MembershipAction
                  state="left"
                  pending
                  pendingState="left"
                  resourceName="Leaving resource"
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title={t("design-guide.joining-resource-wwc")}
              subtitle="The target state is visible immediately while the server confirms."
              className="group"
              trailing={
                <MembershipAction
                  state="joined"
                  pending
                  pendingState="joined"
                  resourceName="Joining resource"
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  FILTER BAR                                                   */}
      {/* ============================================================ */}
      <Section title={t("design-guide.filter-bar-1ey")}>
        <FilterBar
          filters={filters}
          onRemove={(key) => setFilters((f) => f.filter((x) => x.key !== key))}
          onClear={() => setFilters([])}
        />
        {filters.length === 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setFilters([
                { key: "status", label: "Status", value: "Active" },
                // PAP-411: priority filter demo row suppressed while SHOW_TASK_PRIORITY_UI is off.
                ...(SHOW_TASK_PRIORITY_UI
                  ? [{ key: "priority", label: "Priority", value: "High" } as FilterValue]
                  : []),
              ])
            }
          >
            {t("design-guide.reset-filters-1kd")}
          </Button>
        )}
      </Section>

      {/* ============================================================ */}
      {/*  AVATARS                                                      */}
      {/* ============================================================ */}
      <Section title={t("design-guide.avatars-1h9")}>
        <SubSection title={t("design-guide.sizes-1m6")}>
          <div className="flex items-center gap-3">
            <Avatar size="sm"><AvatarFallback>SM</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>DF</AvatarFallback></Avatar>
            <Avatar size="lg"><AvatarFallback>LG</AvatarFallback></Avatar>
          </div>
        </SubSection>

        <SubSection title={t("design-guide.group-1ih")}>
          <AvatarGroup>
            <Avatar><AvatarFallback>A1</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A2</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A3</AvatarFallback></Avatar>
            <AvatarGroupCount>+5</AvatarGroupCount>
          </AvatarGroup>
        </SubSection>
      </Section>

      <Section title={t("design-guide.app-logos-1pu")}>
        <SubSection title={t("design-guide.official-marks-and-runtime-fallback-13j")}>
          <div className="flex items-center gap-3">
            <AppLogo
              name="Notion"
              logoUrl="/brands/apps/notion.svg"
              darkLogoUrl="/brands/apps/notion-dark.svg"
              size={36}
            />
            <AppLogo name="Jira" logoUrl="/brands/apps/jira.svg" darkLogoUrl="/brands/apps/jira-dark.svg" size={44} />
            <AppLogo name="Fallback" logoUrl="/brands/apps/does-not-exist.svg" size={36} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  IDENTITY                                                     */}
      {/* ============================================================ */}
      <Section title={t("design-guide.identity-1q3")}>
        <SubSection title={t("design-guide.sizes-1m6")}>
          <div className="flex items-center gap-6">
            <Identity name="Agent Alpha" size="sm" />
            <Identity name="Agent Alpha" />
            <Identity name="Agent Alpha" size="lg" />
          </div>
        </SubSection>

        <SubSection title={t("design-guide.initials-derivation-1uy")}>
          <div className="flex flex-col gap-2">
            <Identity name="CEO Agent" size="sm" />
            <Identity name="Alpha" size="sm" />
            <Identity name="Quality Assurance Lead" size="sm" />
          </div>
        </SubSection>

        <SubSection title={t("design-guide.custom-initials-3bj")}>
          <Identity name="Backend Service" initials="BS" size="sm" />
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLTIPS                                                     */}
      {/* ============================================================ */}
      <Section title={t("design-guide.tooltips-1jz")}>
        <div className="flex items-center gap-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm">{t("design-guide.hover-me-jns")}</Button>
            </TooltipTrigger>
            <TooltipContent>{t("design-guide.this-is-a-tooltip-1d3")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm"><Settings /></Button>
            </TooltipTrigger>
            <TooltipContent>{t("design-guide.settings-ktd")}</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DIALOG                                                       */}
      {/* ============================================================ */}
      <Section title={t("design-guide.dialog-aqz")}>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">{t("design-guide.open-dialog-npe")}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("design-guide.dialog-title-153")}</DialogTitle>
              <DialogDescription>
                {t("design-guide.this-is-a-sample-dialog-showing-the-1ig")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>{t("design-guide.name-4el")}</Label>
                <Input placeholder={t("design-guide.enter-a-name-1g4")} className="mt-1.5" />
              </div>
              <div>
                <Label>{t("design-guide.description-sjj")}</Label>
                <Textarea placeholder={t("design-guide.describe-11g")} className="mt-1.5" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline">{t("design-guide.cancel-ew9")}</Button>
              <Button>{t("design-guide.save-lew")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      {/* ============================================================ */}
      {/*  EMPTY STATE                                                  */}
      {/* ============================================================ */}
      <Section title={t("design-guide.empty-state-jvs")}>
        <div className="border border-border rounded-md">
          <EmptyState
            icon={Inbox}
            message="No items to show. Create your first one to get started."
            action="Create Item"
            onAction={() => {}}
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROGRESS BARS                                                */}
      {/* ============================================================ */}
      <Section title={t("design-guide.progress-bars-budget-1sw")}>
        <div className="space-y-3">
          {[
            { label: "Under budget (40%)", pct: 40, color: "bg-green-400" },
            { label: "Warning (75%)", pct: 75, color: "bg-yellow-400" },
            { label: "Over budget (95%)", pct: 95, color: "bg-red-400" },
          ].map(({ label, pct, color }) => (
            <div key={label} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className="text-xs font-mono">{pct}%</span>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-(--tp-width-background-color) duration-150 ${color}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  LOG VIEWER                                                   */}
      {/* ============================================================ */}
      <Section title={t("design-guide.log-viewer-1wb")}>
        <div className="bg-neutral-950 rounded-lg p-3 font-mono text-xs max-h-80 overflow-y-auto">
          <div className="text-foreground">{t("design-guide.12-00-01-info-agent-started-successf-x6v")}</div>
          <div className="text-foreground">{t("design-guide.12-00-02-info-processing-task-pap-00-1s3")}</div>
          <div className="text-yellow-400">{t("design-guide.12-00-05-warn-rate-limit-approaching-vuu")}</div>
          <div className="text-foreground">{t("design-guide.12-00-08-info-task-pap-001-completed-nno")}</div>
          <div className="text-red-400">{t("design-guide.12-00-12-error-connection-timeout-to-yr8")}</div>
          <div className="text-blue-300">{t("design-guide.12-00-12-sys-retrying-connection-in-1d8")}</div>
          <div className="text-foreground">{t("design-guide.12-00-17-info-reconnected-successful-1tn")}</div>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 animate-pulse" />
              <span className="inline-flex h-full w-full rounded-full bg-blue-500" />
            </span>
            <span className="text-blue-600 dark:text-blue-400">{t("design-guide.live-11r")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROPERTY ROW PATTERN                                         */}
      {/* ============================================================ */}
      <Section title={t("design-guide.property-row-pattern-cyb")}>
        <div className="border border-border rounded-md p-4 space-y-1 max-w-sm">
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("design-guide.status-3pd")}</span>
            <StatusBadge status="active" />
          </div>
          {/* PAP-411: priority metadata row hidden behind SHOW_TASK_PRIORITY_UI. */}
          {SHOW_TASK_PRIORITY_UI && (
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-muted-foreground">{t("design-guide.priority-1ry")}</span>
              <PriorityIcon priority="high" />
            </div>
          )}
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("design-guide.responsible-1nd")}</span>
            <div className="flex items-center gap-1.5">
              <Avatar size="sm"><AvatarFallback>A</AvatarFallback></Avatar>
              <span className="text-xs">{t("design-guide.agent-alpha-7om")}</span>
            </div>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("design-guide.created-2qk")}</span>
            <span className="text-xs">{t("design-guide.jan-15-2025-1co")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  NAVIGATION PATTERNS                                          */}
      {/* ============================================================ */}
      <Section title={t("design-guide.navigation-patterns-16d")}>
        <SubSection title={t("design-guide.agent-chat-picker-2di")}>
          <AgentChatPickerExample />
        </SubSection>
        <SubSection title={t("design-guide.sidebar-nav-items-156")}>
          <p className="text-sm text-muted-foreground">
            Layout accepts sidebarSections to compose additional SidebarSection groups inside the shared sidebar.
            Use SidebarNavItem for each row, with sibling action buttons for starring or menus.
            The Chats section shows starred agents, the earliest-created agent when unstarred, then four recent agents without duplicates. Compose and star controls share a vertical column. Compose appears on hover or keyboard focus and remains visible on touch; starred icons remain visible. The picker searches all company agents by name or role without a subtitle, count, continuation labels, or footer. Task breadcrumbs support leading identity and trailing actions beside the label, including single-item task headers; see the Agent chat Storybook.
          </p>
          <Card className="block w-60 p-3 space-y-0.5">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-accent-foreground">
              <LayoutDashboard className="h-4 w-4" />
              {t("design-guide.dashboard-4zf")}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <CircleDot className="h-4 w-4" />
              {t("design-guide.issues-1he")}
              <Badge variant="ghost" className="ml-auto bg-primary text-primary-foreground px-1.5">
                12
              </Badge>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Bot className="h-4 w-4" />
              {t("design-guide.agents-1sa")}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Hexagon className="h-4 w-4" />
              {t("design-guide.projects-s0r")}
            </div>
          </Card>
        </SubSection>

        <SubSection title={t("design-guide.view-toggle-1s6")}>
          <div className="flex items-center border border-border rounded-md w-fit">
            <button className="px-3 py-1.5 text-xs font-medium bg-accent text-foreground rounded-l-md">
              <ListTodo className="h-3.5 w-3.5 inline mr-1" />
              {t("design-guide.list-136")}
            </button>
            <button className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 rounded-r-md">
              <Target className="h-3.5 w-3.5 inline mr-1" />
              {t("design-guide.org-1yn")}
            </button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  GROUPED LIST (Issues pattern)                                */}
      {/* ============================================================ */}
      <Section title={t("design-guide.grouped-list-issues-pattern-17m")}>
        <div>
          <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 rounded-t-md">
            <StatusIcon status="in_progress" />
            <span className="text-sm font-medium">{t("design-guide.in-progress-w3n")}</span>
            <span className="text-xs text-muted-foreground ml-1">2</span>
          </div>
          <div className="border border-border rounded-b-md">
            {/* PAP-411: leading PriorityIcon hidden behind SHOW_TASK_PRIORITY_UI. */}
            <EntityRow
              leading={SHOW_TASK_PRIORITY_UI ? <PriorityIcon priority="high" /> : undefined}
              identifier="PAP-101"
              title={t("design-guide.build-agent-heartbeat-system-163")}
              onClick={() => {}}
            />
            <EntityRow
              leading={SHOW_TASK_PRIORITY_UI ? <PriorityIcon priority="medium" /> : undefined}
              identifier="PAP-102"
              title={t("design-guide.add-cost-tracking-dashboard-wkn")}
              onClick={() => {}}
            />
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COMMENT THREAD PATTERN                                       */}
      {/* ============================================================ */}
      <Section title={t("design-guide.comment-thread-pattern-11q")}>
        <div className="space-y-3 max-w-2xl">
          <h3 className="text-sm font-semibold">{t("design-guide.comments-2-gss")}</h3>
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{t("design-guide.agent-1w5")}</span>
                <span className="text-xs text-muted-foreground">{t("design-guide.jan-15-2025-1co")}</span>
              </div>
              <p className="text-sm">{t("design-guide.started-working-on-the-authenticatio-5u0")}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{t("design-guide.human-72u")}</span>
                <span className="text-xs text-muted-foreground">{t("design-guide.jan-16-2025-1pz")}</span>
              </div>
              <p className="text-sm">{t("design-guide.api-keys-have-been-added-to-the-vaul-16q")}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Textarea placeholder={t("design-guide.leave-a-comment-1qx")} rows={3} />
            <Button size="sm">{t("design-guide.comment-169")}</Button>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COST TABLE PATTERN                                           */}
      {/* ============================================================ */}
      <Section title={t("design-guide.cost-table-pattern-we8")}>
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-accent/20">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t("design-guide.model-107")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t("design-guide.tokens-il7")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t("design-guide.cost-t05")}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="px-3 py-2">claude-sonnet-4-20250514</td>
                <td className="px-3 py-2 font-mono">1.2M</td>
                <td className="px-3 py-2 font-mono">$18.00</td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-3 py-2">claude-haiku-4-20250506</td>
                <td className="px-3 py-2 font-mono">500k</td>
                <td className="px-3 py-2 font-mono">$1.25</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-medium">{t("design-guide.total-1c0")}</td>
                <td className="px-3 py-2 font-mono">1.7M</td>
                <td className="px-3 py-2 font-mono font-medium">$19.25</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SKELETONS                                                    */}
      {/* ============================================================ */}
      <Section title={t("design-guide.skeletons-pri")}>
        <SubSection title={t("design-guide.individual-lmc")}>
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-8 w-full max-w-sm" />
            <Skeleton className="h-20 w-full" />
          </div>
        </SubSection>

        <SubSection title={t("design-guide.page-skeleton-list-1b6")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="list" />
          </div>
        </SubSection>

        <SubSection title={t("design-guide.page-skeleton-detail-2de")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="detail" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  SEPARATOR                                                    */}
      {/* ============================================================ */}
      <Section title={t("design-guide.separator-frt")}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("design-guide.horizontal-tya")}</p>
          <Separator />
          <div className="flex items-center gap-4 h-8">
            <span className="text-sm">{t("design-guide.left-14n")}</span>
            <Separator orientation="vertical" />
            <span className="text-sm">{t("design-guide.right-8hu")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  ICON REFERENCE                                               */}
      {/* ============================================================ */}
      {/*  TEAM CATALOG                                                 */}
      {/* ============================================================ */}
      <Section title={t("design-guide.team-catalog-15x")}>
        <p className="text-sm text-muted-foreground">
          {t("design-guide.components-from-the-team-catalog-bro-1jh")}<code className="font-mono text-xs">/teams-catalog</code>{t("design-guide.fixtures-are-shared-with-the-storybo-siy")}
        </p>

        <SubSection title={t("design-guide.team-row-browse-list-uvr")}>
          <div className="w-(--sz-28rem) rounded-md border border-border">
            <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
              {t("design-guide.bundled-1-j5n")}
            </div>
            <TeamRow team={sampleTeam} selected onSelect={() => {}} />
            <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
              {t("design-guide.optional-2-t92")}
            </div>
            <TeamRow team={optionalTeam} selected={false} onSelect={() => {}} />
            <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
              {t("design-guide.installed-2-m34")}
            </div>
            <TeamRow team={sampleTeam} selected={false} onSelect={() => {}} installed={outOfDateInstalledState} />
            <TeamRow team={warnTeam} selected={false} onSelect={() => {}} installed={currentInstalledState} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("design-guide.installed-teams-collapse-under-rq2")} <code className="font-mono">INSTALLED · N</code>; an out-of-date
            install (server <code className="font-mono">originHash</code> {t("design-guide.catalog-80w")} <code className="font-mono">contentHash</code>{t("design-guide.shows-the-amber-1el")} <code className="font-mono">↑</code> {t("design-guide.badge-pap-10256-b5g")}
          </p>
        </SubSection>

        <SubSection title={t("design-guide.team-card-onboarding-grid-xud")}>
          <p className="text-xs text-muted-foreground">
            {t("design-guide.square-tile-for-the-onboarding-pick-1pe")}{" "}
            <code className="font-mono">ring-2 ring-ring</code>{t("design-guide.drives-the-439")}{" "}
            <code className="font-mono">useInstallTeamCatalogEntry</code> {t("design-guide.simplified-flow-13a")}
          </p>
          <TeamCardShowcase />
        </SubSection>

        <SubSection title={t("design-guide.team-hierarchy-preview-1b7")}>
          <div className="max-w-md">
            <TeamHierarchyPreview team={sampleTeam} />
          </div>
        </SubSection>

        <SubSection title={t("design-guide.required-skills-list-645")}>
          <div className="max-w-xl">
            <RequiredSkillsList skills={sampleTeam.requiredSkills} />
          </div>
        </SubSection>

        <SubSection title={t("design-guide.env-inputs-list-1nl")}>
          <div className="max-w-xl">
            <EnvInputsList inputs={sampleTeam.envInputs} />
          </div>
        </SubSection>

        <SubSection title={t("design-guide.external-sources-list-196")}>
          <div className="max-w-xl">
            <ExternalSourcesList sources={sampleTeam.sourceRefs} />
          </div>
        </SubSection>

        <SubSection title={t("design-guide.source-policy-step-step-source-polic-mxg")}>
          <div className="max-w-xl rounded-md border border-border p-4">
            <StepSourcePolicy
              team={warnTeam}
              allowExternalSources={allowExternal}
              allowUnpinnedOptionalSources={allowUnpinned}
              allowLocalPathSources={allowLocalPath}
              onChange={(key, value) => {
                if (key === "external") setAllowExternal(value);
                if (key === "unpinned") setAllowUnpinned(value);
                if (key === "localPath") setAllowLocalPath(value);
              }}
            />
          </div>
        </SubSection>

        <SubSection title={t("design-guide.skill-plan-step-step-skill-plan-188")}>
          <div className="max-w-xl rounded-md border border-border p-4">
            <StepSkillPlan team={sampleTeam} preparations={sampleSkillPreparations} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      <Section title={t("design-guide.common-icons-lucide-1sx")}>
        <div className="grid grid-cols-4 md:grid-cols-6 gap-4">
          {[
            ["Inbox", Inbox],
            ["ListTodo", ListTodo],
            ["CircleDot", CircleDot],
            ["Hexagon", Hexagon],
            ["Target", Target],
            ["LayoutDashboard", LayoutDashboard],
            ["Bot", Bot],
            ["DollarSign", DollarSign],
            ["History", History],
            ["Search", Search],
            ["Plus", Plus],
            ["Trash2", Trash2],
            ["Settings", Settings],
            ["User", User],
            ["Mail", Mail],
            ["Upload", Upload],
            ["Zap", Zap],
          ].map(([name, Icon]) => {
            const LucideIcon = Icon as React.FC<{ className?: string }>;
            return (
              <div key={name as string} className="flex flex-col items-center gap-1.5 p-2">
                <LucideIcon className="h-4 w-4 text-muted-foreground" />
                <span className="text-(length:--text-nano) text-muted-foreground font-mono">{name as string}</span>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  KEYBOARD SHORTCUTS                                           */}
      {/* ============================================================ */}
      <Section title={t("design-guide.keyboard-shortcuts-1fp")}>
        <div className="border border-border rounded-md divide-y divide-border text-sm">
          {[
            ["Cmd+K / Ctrl+K", "Open Command Palette"],
            ["C", "New Issue (outside inputs)"],
            ["[", "Toggle Sidebar"],
            ["]", "Toggle Properties Panel"],

            ["Cmd+Enter / Ctrl+Enter", "Submit markdown comment"],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between px-4 py-2">
              <span className="text-muted-foreground">{desc}</span>
              <kbd className="px-2 py-0.5 text-xs font-mono bg-muted rounded border border-border">
                {key}
              </kbd>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t("design-guide.issue-output-surface-1jo")}>
        <SubSection title={t("design-guide.multiple-outputs-primary-video-also-1et")}>
          <IssueOutputSection workProducts={DESIGN_GUIDE_OUTPUTS} />
        </SubSection>
        <SubSection title={t("design-guide.degraded-output-invalid-failed-attac-1y9")}>
          <IssueOutputSection workProducts={DESIGN_GUIDE_DEGRADED_OUTPUTS} />
        </SubSection>
        <SubSection title={t("design-guide.empty-state-1uj")}>
          <p className="text-xs text-muted-foreground">
            {t("design-guide.when-an-issue-has-produced-no-artifa-1w5")}
          </p>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLS & ACCESS (PAP-10389)                                   */}
      {/* ============================================================ */}
      <Section title={t("design-guide.tools-access-18m")}>
        <SubSection title={t("design-guide.enforcement-banner-default-denied-de-19d")}>
          <div className="space-y-3">
            <EnforcementBanner companyId="" forceVariant="default" recentDenialCount={0} />
            <EnforcementBanner companyId="" forceVariant="denied-detected" recentDenialCount={3} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("design-guide.persistent-at-the-top-of-the-tools-a-1qq")} <code>denied-detected</code> {t("design-guide.when-governed-tool-calls-were-denied-1r9")}
          </p>
        </SubSection>

        <SubSection title={t("design-guide.enforcement-banner-presentational-to-1oz")}>
          <div className="space-y-3">
            <EnforcementBanner
              tone="info"
              title={t("design-guide.effective-access-server-resolved-s6x")}
              body="This is exactly what the tool gateway will accept. Profile and policy edits reflect within ~5s; the prompt cannot expand it."
            />
            <EnforcementBanner
              tone="warning"
              title={t("design-guide.local-stdio-is-local-code-execution-155")}
              body="A local-stdio slot runs with the orchestrator's privileges. Only bind trusted commands; quarantine anything you would not run yourself."
            />
            <EnforcementBanner
              tone="error"
              title={t("design-guide.runtime-failed-closed-6z3")}
              body="The supervisor is restarting (attempt 2/3). The gateway returns runtime-error and the agent does not see partial output."
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("design-guide.static-governance-copy-with-a-tone-u-15l")} <code>title</code>/<code>body</code> {t("design-guide.and-an-optional-15l")}{" "}
            <code>icon</code>.
          </p>
        </SubSection>

        <SubSection title={t("design-guide.action-approval-card-pending-stale-s-5rk")}>
          <div className="grid gap-4 lg:grid-cols-2">
            <ActionCard
              toolName="slack.post_message"
              risk="medium"
              isWrite
              binding={{
                application: "Slack",
                manifestVersion: "2.4.1",
                connection: "https://slack.com/api · acme-workspace",
                catalogSha256: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                payloadSha256: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
              }}
              input={{ channel: "#launch", text: "Deploy v2 is live 🎉", unfurl_links: false }}
              reason="This tool can write to your workspace, so a human signs off before the agent posts."
              policyNumber={7}
              expiresInLabel="expires in 23h 51m"
            />
            <ActionCard
              variant="stale"
              toolName="slack.post_message"
              risk="medium"
              isWrite
              binding={{
                application: "Slack",
                manifestVersion: "2.4.1",
                connection: "https://slack.com/api · acme-workspace",
                catalogSha256: "sha256:7d793037a0760186574b0282f2f435e7a4b1b2b0b822cd15d6c15b0f00a0e3f1",
                previousCatalogSha256: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                payloadSha256: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
              }}
              input={{ channel: "#launch", text: "Deploy v2 is live 🎉", unfurl_links: false }}
              reason="This tool can write to your workspace, so a human signs off before the agent posts."
              policyNumber={7}
              expiresInLabel="expires in 18h 02m"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("design-guide.signed-payload-sha256-expiry-surface-awl")}{" "}
            <code>stale</code> {t("design-guide.variant-tints-the-border-amber-banne-us4")} <code>Approve</code> {t("design-guide.disabled-until-the-request-is-re-iss-v5b")}
          </p>
        </SubSection>

        <SubSection title={t("design-guide.action-approval-card-mobile-390-844-zbm")}>
          <div className="w-(--sz-390px) max-w-full rounded-xl border border-border bg-background p-3">
            <ActionCardMobile
              toolName="slack.post_message"
              risk="medium"
              isWrite
              binding={{
                application: "Slack",
                manifestVersion: "2.4.1",
                connection: "https://slack.com/api · acme-workspace",
                catalogSha256: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                payloadSha256: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
              }}
              input={{ channel: "#launch", text: "Deploy v2 is live 🎉" }}
              reason="This tool can write to your workspace, so a human signs off before the agent posts."
              policyNumber={7}
              expiresInLabel="expires in 23h 51m"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("design-guide.identical-content-the-three-buttons-17x")}
          </p>
        </SubSection>

        <SubSection title={t("design-guide.bindings-table-reused-in-the-audit-r-1i2")}>
          <BindingsTable
            rows={[
              { label: "Application", value: "Slack · manifest v2.4.1" },
              { label: "Connection", value: "https://slack.com/api · acme-workspace", mono: true },
              { label: "Catalog", value: "sha256:9f86d081…f00a08", mono: true },
              { label: "Payload", value: "sha256:2c26b46b…66e7ae", mono: true },
            ]}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {t("design-guide.two-column-key-value-block-with-mono-wud")} <code>ActionCard</code> {t("design-guide.and-is-reused-standalone-in-the-audi-1db")}
          </p>
        </SubSection>

        <SubSection title={t("design-guide.tool-access-status-keys-status-badge-1sx")}>
          <div className="flex flex-wrap items-center gap-2">
            {[
              "allowed", "denied", "block", "require-approval", "redacted", "rate-limit",
              "deferred", "hidden", "quarantined", "healthy", "degraded", "runtime-error", "unchecked",
            ].map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("design-guide.policy-decisions-connection-runtime-1cl")}{" "}
            <code>StatusBadge</code> {t("design-guide.keys-defined-in-9h1")} <code>lib/status-colors</code>.
          </p>
        </SubSection>

        <SubSection title={t("design-guide.empty-state-canonical-with-descripti-ih8")}>
          <EmptyState
            icon={Inbox}
            message="No connections yet"
            description={t("design-guide.add-a-connection-to-an-application-t-1k8")}
            action="New connection"
            onAction={() => {}}
          />
        </SubSection>
      </Section>

      <Section title={t("design-guide.composio-services-wpt")}>
        <p className="text-sm text-muted-foreground">
          {t("design-guide.a-broker-connection-composio-fronts-h9x")} <code>attention</code> {t("design-guide.state-alongside-the-three-the-design-zor")}
        </p>
        <SubSection title={t("design-guide.row-states-pc3")}>
          <ServicesList
            rows={DESIGN_GUIDE_COMPOSIO_ROWS}
            busySlug={null}
            onConnect={() => {}}
            onRecheck={() => {}}
            onDisconnect={() => {}}
          />
        </SubSection>
        <SubSection title={t("design-guide.busy-row-7db")}>
          <ServicesList
            rows={[DESIGN_GUIDE_COMPOSIO_ROWS[2]!]}
            busySlug={DESIGN_GUIDE_COMPOSIO_ROWS[2]!.toolkitSlug}
            onConnect={() => {}}
            onRecheck={() => {}}
            onDisconnect={() => {}}
          />
        </SubSection>
        <SubSection title={t("design-guide.provenance-chip-sgp")}>
          <p className="mb-2 text-xs text-muted-foreground">
            {t("design-guide.shown-wherever-a-brokered-child-conn-v6p")}
          </p>
          <div className="flex items-center gap-3">
            <ComposioProvenanceChip
              connection={{
                config: { provider: "composio", parentConnectionId: "parent-1", toolkitSlug: "github" },
              }}
            />
            <ComposioProvenanceChip
              connection={{ config: { provider: "composio", toolkitSlug: "gmail" } }}
            />
          </div>
        </SubSection>
      </Section>

      <Section title={t("design-guide.source-repositories-c6h")}>
        <SubSection title={t("design-guide.empty-and-disconnected-1sm")}>
          <RepositoryEditor selected={[]} onChange={() => {}} state="disconnected" onConnect={() => {}} onRetry={() => {}} />
        </SubSection>
        <SubSection title={t("design-guide.selected-and-searchable-1s9")}>
          <RepositoryEditor selected={[{ id: "1", fullName: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip", connections: ["Your GitHub"] }]}
            available={[{ id: "2", fullName: "paperclipai/docs", url: "https://github.com/paperclipai/docs", connections: ["Company GitHub"] }]}
            onChange={() => {}} onConnect={() => {}} onRetry={() => {}} />
        </SubSection>
        <p className="text-sm text-muted-foreground">{t("design-guide.loading-errors-empty-search-mobile-a-tfg")}</p>
      </Section>

      <Section title={t("design-guide.environment-variables-editor-d41")}>
        <p className="text-sm text-muted-foreground">
          {t("design-guide.reusable-env-var-editor-agents-proje-1yu")} <span className="font-mono">{t("design-guide.product-environment-variables-editor-2gw")}</span> {t("design-guide.stories-for-all-10-states-1ee")}
        </p>
        <EnvironmentVariablesEditorShowcase />
      </Section>

      <Section title={t("design-guide.tasks-created-from-a-task-3at")}>
        <SubSection title={t("design-guide.subtasks-and-created-work-are-indepe-zky")}>
          <div className="max-w-xl">
            <TaskDetailTasksPanel
              subtasks={[DESIGN_GUIDE_TASK]}
              createdTasks={[
                { ...DESIGN_GUIDE_TASK, projectId: "design-board", project: { id: "design-board", name: "Board UI" } as Issue["project"] },
                { ...DESIGN_GUIDE_TASK, id: "design-followup", identifier: "PAP-428", title: "Write release notes", status: "todo", projectId: null },
              ]}
              projects={[]}
            />
          </div>
        </SubSection>
        <SubSection title={t("design-guide.empty-loading-and-failed-1ga")}>
          <TaskDetailTasksPanel subtasks={[]} createdTasks={[]} projects={[]} />
          <TaskDetailTasksPanel subtasks={[]} createdTasks={[]} projects={[]} isLoading />
          <TaskDetailTasksPanel subtasks={[]} createdTasks={[]} projects={[]} hasError onRetry={() => {}} />
        </SubSection>
      </Section>

      <Section title={t("design-guide.execution-recovery-1et")}>
        <p className="text-sm text-muted-foreground">
          {t("design-guide.recovery-runs-in-the-background-task-1fa")}
        </p>
      </Section>

      <Section title={t("design-guide.saved-provider-api-keys-2zd")}>
        <SavedProviderKeySelect options={[{ id: "example", label: "Claude API key (Your key)", binding: { type: "user_secret_ref", key: "ANTHROPIC_API_KEY", version: "latest" } }]} value="example" onChange={() => {}} loading={false} error={false} />
        <SavedProviderKeySelect options={[]} value="" onChange={() => {}} loading error={false} />
        <SavedProviderKeySelect options={[]} value="" onChange={() => {}} loading={false} error />
      </Section>

      <Section title={t("design-guide.connection-intent-16y")}>
        <p className="text-sm text-muted-foreground">
          {t("design-guide.the-task-card-is-the-dialog-host-for-50n")}
        </p>
        <div className="grid gap-4 xl:grid-cols-3">
          <IssueThreadInteractionCard
            interaction={pendingConnectionIntentInteraction}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          />
          <IssueThreadInteractionCard
            interaction={retryConnectionIntentInteraction}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          />
          <IssueThreadInteractionCard
            interaction={connectedConnectionIntentInteraction}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          />
        </div>
      </Section>

      <Section title={t("design-guide.resizable-panels-b3e")}>
        <p className="text-sm text-muted-foreground">
          {t("design-guide.design-system-wrapper-over-195")} <span className="font-mono">react-resizable-panels</span>{" "}
          {t("design-guide.skill-studio-d2-drag-a-handle-to-res-1h5")}<span className="font-mono">minSize="240px"</span>{t("design-guide.constraints-and-the-middle-panel-is-jyp")}
        </p>
        <div className="h-48 max-w-2xl overflow-hidden rounded-md border border-border">
          <ResizablePanelGroup>
            <ResizablePanel id="a" minSize="120px" className="bg-muted/30">
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t("design-guide.panel-a-3pl")}
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="b" minSize="120px" collapsible collapsedSize="40px" className="bg-muted/10">
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t("design-guide.panel-b-collapsible-rza")}
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="c" minSize="120px" className="bg-muted/30">
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t("design-guide.panel-c-35m")}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  INLINE BANNER + BUILT-IN AGENTS                              */}
      {/* ============================================================ */}
      <Section title={t("design-guide.inline-banner-bar")}>
        <p className="text-sm text-muted-foreground">
          {t("design-guide.token-backed-full-width-notice-wz7")}<span className="font-mono">brandBanner</span> {t("design-guide.tones-use-361")}{" "}
          <span className="font-mono">info</span> {t("design-guide.for-provenance-context-and-rq6")}{" "}
          <span className="font-mono">warning</span> {t("design-guide.for-paused-attention-supports-an-opt-1x5")}{" "}
          <span className="font-mono">{t("design-guide.bg-yellow-50s")}</span>/<span className="font-mono">{t("design-guide.bg-blue-tgy")}</span>{" "}
          {t("design-guide.banners-g3f")}
        </p>
        <div className="space-y-3">
          <InlineBanner
            tone="info"
            title={t("design-guide.built-in-agent-5t8")}
            actions={<Button variant="outline" size="sm">{t("design-guide.reset-to-defaults-kqo")}</Button>}
          >
            {t("design-guide.ships-with-paperclip-and-powers-4ld")} <strong>{t("design-guide.briefs-km9")}</strong>{t("design-guide.it-can-be-paused-but-not-deleted-euk")}
          </InlineBanner>
          <InlineBanner
            tone="warning"
            title={t("design-guide.briefs-is-paused-1ia")}
            actions={
              <>
                <Button variant="ghost" size="sm">{t("design-guide.view-agent-3zm")}</Button>
                <Button size="sm">{t("design-guide.resume-agent-1iq")}</Button>
              </>
            }
          >
            {t("design-guide.its-built-in-agent-was-paused-2-days-1s6")}
          </InlineBanner>
          <InlineBanner
            tone="danger"
            title={t("design-guide.summary-generation-failed-157")}
            actions={<Button size="sm">{t("design-guide.retry-zko")}</Button>}
          >
            {t("design-guide.the-linked-issue-reached-a-terminal-9ij")}
          </InlineBanner>
          <InlineBanner tone="info" compact>
            {t("design-guide.compact-variant-for-embedding-inside-1av")}
          </InlineBanner>
        </div>
      </Section>

      <Section title={t("design-guide.ai-connections-jxr")}>
        <AiConnectionDesignExamples />
      </Section>

      <Section title={t("design-guide.built-in-agent-lifecycle-chips-1nk")}>
        <p className="text-sm text-muted-foreground">
          {t("design-guide.a-derived-lifecycle-chip-amber-for-a-qfi")}{" "}
          <span className="font-mono">needs_setup</span> / <span className="font-mono">pending_approval</span>.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <BuiltInLifecycleChip status="needs_setup" />
          <BuiltInLifecycleChip status="pending_approval" />
          <BuiltInLifecycleChip status="needs_setup" compact />
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          <span className="font-mono">&lt;BuiltInAgentGate agentKey&gt;</span> composes{" "}
          <span className="font-mono">{t("design-guide.page-skeleton-gbu")}</span> + <span className="font-mono">{t("design-guide.empty-state-11s")}</span>{" "}
          + <span className="font-mono">{t("design-guide.inline-banner-iyi")}</span> {t("design-guide.to-render-the-loading-setup-pending-1yt")}
        </p>
      </Section>
    </div>
  );
}
