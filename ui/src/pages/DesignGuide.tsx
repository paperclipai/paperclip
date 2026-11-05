import { t as finalPagesT } from "@/i18n";
import { getPageValueLabel } from "@/pages/tools/shared";
import { t as translateShell, useTranslation, Trans } from "@/i18n";
import { SpekoPhoneLineForm } from "@/components/voice/SpekoPhoneLine";
import { SpekoIncomingCallCard } from "@/components/voice/SpekoIncomingCalls";
import { SpekoCallHistoryView, SpekoCallActivityItem, SpekoUnapprovedCallActivityItem } from "@/components/voice/SpekoCallHistory";
import { SpekoPhoneCallbackForm } from "@/components/voice/SpekoPhoneCallback";
import { SpekoProviderSetup } from "@/components/voice/SpekoProviderSetup";
import { VoiceControls } from "@/components/voice/VoiceControls";
import { VoiceTranscript } from "@/components/voice/VoiceTranscript";
import { AnimatedDialogContent } from "@/components/AnimatedDialogContent";
import { MuseConnectionDetails } from "@/components/MuseRunnerConnection";
import { ExternalAgentPresetPicker, DotConnectionChecks, MuseConnectionChecks } from "@/components/new-agent/ExternalAgentInviteContent";
import { AgentMailApiKeyField } from "@/features/connections/AgentMailApiKeyField";
import { TaskBrowserFooter } from "@/components/task-side-panel/TaskBrowserFooter";
import { TaskBrowserActivity } from "@/components/task-side-panel/TaskBrowserActivity";
import type { TaskBrowser } from "@paperclipai/shared";
import { DispositionRecoveryNotice } from "../components/DispositionRecoveryNotice";
import { CloudSignIn } from "../components/CloudSignIn";
import { CloudAccessError } from "../components/CloudAccessGate";
import { SetupPrompt } from "./apps/chat/SetupPrompt";
import { MediaArtifactCard } from "@/components/artifacts/MediaArtifactCard";

import { SkillSourceTree } from "./skills/SkillSourceTree";
import { SkillBinaryFile } from "../components/SkillBinaryFile";
import { WebhookUrlWarning } from "@/components/routine-triggers/WebhookUrlWarning";
import { SetupWizardNavigation, SetupWizardFooter } from "../components/SetupWizard";
import { RemoteMcpDesignExample } from "@/features/connections/remote-mcp/RemoteMcpDesignExample";
import { AgentConversationSidebar } from "@/components/AgentConversationSidebar";
import { AgentChatPicker } from "@/components/AgentChatPicker";
import { TaskChatProjectCreatedCard } from "@/components/task-chat/TaskChatProjectCreatedCard";
import { TextAttachmentPreview } from "@/components/task-side-panel/TaskAttachmentPanel";
import { AnnouncementCard } from "@/components/AnnouncementCard";
import { announcementPreview, announcementAnimationPreview, announcementAnimationPreviewSrc } from "@/lib/announcement-preview";
import { TaskDetailTasksPanel } from "@/components/task-detail/TaskDetailTasksPanel";
import { AiConnectionDesignExamples } from "@/components/ai-connections/AiConnectionDesignExamples";
import { SavedProviderKeySelect } from "../components/onboarding/SavedProviderKeySelect";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentCharacter } from "@/components/AgentCharacter";
import { AGENT_PALETTE_IDS, appearanceForPalette } from "@paperclipai/shared";
import { RepositoryEditor } from "@/components/RepositoryEditor";
import { TaskChatRunnerActivityGroup } from "@/components/task-chat/TaskChatRunnerActivityGroup";
import { TaskChatMarker } from "@/components/task-chat/TaskChatMarker";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { ComposerAddMenu, ComposerModeChip } from "@/components/task-chat/ComposerAddMenu";
import type { IssueWorkMode } from "@paperclipai/shared";
import { TaskTreeControlDialog, TaskTreeControlMenuItems } from "@/components/TaskTreeControls";
import { useState } from "react";
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
import { TaskChatLoadingShell } from "@/components/task-chat/TaskChatLoadingShell";
import { Identity } from "@/components/Identity";
import { AppLogo } from "@/pages/apps/AppLogo";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { LockedIssueChip } from "@/components/LockedIssueChip";
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
    healthStatus: translateShell("shell:unknown"),
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { t: translateShell } = useTranslation("shell");
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
  const { t: translateShell } = useTranslation("shell");
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
  const { t: translateShell } = useTranslation("shell");
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
  const { t: translateShell } = useTranslation("shell");
  const [env, setEnv] = useState<Record<string, EnvBinding>>({
    NODE_ENV: { type: "plain", value: "production" },
    GH_TOKEN: { type: "secret_ref", secretId: "dg-github", version: "latest" },
    DB_URL: { type: "secret_ref", secretId: "dg-db", version: 3 },
    STRIPE_API_KEY: { type: "plain", value: "demo-value-not-a-credential" },
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
  const { t: translateShell } = useTranslation("shell");
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
  const { t: translateShell } = useTranslation("shell");
  const [running, setRunning] = useState(true);
  const [dialogMode, setDialogMode] = useState<"resume" | "cancel" | "restore" | null>(null);
  const [wake, setWake] = useState(true);
  return <div className="max-w-xl space-y-4">
    <div className="w-52 rounded-md border border-border p-1">
      <TaskTreeControlMenuItems scope="subtree" canPause={running} canResume={!running} canCancel canRestore={!running}
        onPause={() => setRunning(false)} onResume={() => setDialogMode("resume")}
        onCancel={() => setDialogMode("cancel")} onRestore={() => setDialogMode("restore")} />
    </div>
    <p className="text-sm text-muted-foreground">{running ? translateShell("shell:running_type_to_switch_stop_to_send") : translateShell("shell:paused_resume_from_the_menu")}</p>
    <TaskChatProjectCreatedCard item={{ id: "design-project", kind: "project_created", projectId: "example-project", name: "Onboarding improvements", description: "Help new teams reach their first useful result.", timestamp: "2026-09-11T00:00:00Z", repositories: [{ id: "1", name: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip" }] }} />
    {!running ? <TaskChatMarker item={{ id: "design-cancelled", kind: "marker", variant: "interrupted", tone: "neutral", label: finalPagesT("final-pages:Run_cancelled_2d34c9"), detail: "The run was cancelled before returning an answer.", collapsible: true }} /> : null}
    <TaskChatComposer pause={!running ? { scope: "subtree", onResume: () => setDialogMode("resume") } : null} onAdd={async () => {}} workMode="standard" stopScope="subtree" onStop={running ? async () => setRunning(false) : undefined} />
    <TaskTreeControlDialog open={dialogMode !== null} onOpenChange={(open) => { if (!open) setDialogMode(null); }}
      mode={dialogMode ?? "cancel"} scope="subtree" affectedCount={3} affectedAgentCount={2} loading={false} pending={false} valid
      wakeAgents={wake} onWakeAgentsChange={setWake} onRetry={() => {}}
      onApply={() => { setRunning(dialogMode !== "cancel" && wake); setDialogMode(null); }} />
  </div>;
}

function TaskPendingInputExample() {
  const { t: translateShell } = useTranslation("shell");
  const [open, setOpen] = useState(true);
  const [pending, setPending] = useState(true);
  return <div className="max-w-xl">
    <TaskChatComposer
      onAdd={async () => {}}
      workMode="standard"
      takeover={pending && open ? {
        id: "design-question",
        label: finalPagesT("final-pages:Question_289aff"),
        pendingCount: 1,
        content: <div className="space-y-3 text-sm">
          <p>{translateShell("shell:should_the_agent_use_the_existing_draft")}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setPending(false)}>{translateShell("shell:use_draft")}</Button>
            <Button size="sm" variant="outline" onClick={() => setPending(false)}>{translateShell("shell:start_fresh")}</Button>
          </div>
        </div>,
        onDismiss: () => setOpen(false),
        onSkip: () => setPending(false),
      } : null}
      pendingTakeover={pending ? { count: 1, label: finalPagesT("final-pages:Question_289aff"), onOpen: () => setOpen(true) } : null}
    />
  </div>;
}

function AgentChatPickerExample() {
  const { t: translateShell } = useTranslation("shell");
  const [state, setState] = useState<"closed" | "empty" | "loading" | "error">("closed");
  return <div className="flex flex-wrap gap-2">
    <Button variant="outline" onClick={() => setState("empty")}>{translateShell("shell:empty_picker")}</Button>
    <Button variant="outline" onClick={() => setState("loading")}>{translateShell("shell:loading_picker")}</Button>
    <Button variant="outline" onClick={() => setState("error")}>{translateShell("shell:failed_picker")}</Button>
    <AgentChatPicker agents={[]} open={state !== "closed"} onOpenChange={(open) => { if (!open) setState("closed"); }} onSelect={() => {}}
      loading={state === "loading"} error={state === "error" ? new Error(translateShell("shell:unavailable")) : null} onRetry={() => setState("empty")} />
  </div>;
}

function ComposerActionsExample() {
  const { t: translateShell } = useTranslation("shell");
  const [mode, setMode] = useState<IssueWorkMode>("standard");
  return <div className="flex max-w-xl items-center gap-2 rounded-xl border border-border bg-card p-3">
    <ComposerAddMenu mode={mode} onModeChange={setMode} onAttachFile={() => {}} onGoal={() => {}} />
    <ComposerModeChip mode={mode} onRemove={() => setMode("standard")} />
    <span className="ml-auto text-xs text-muted-foreground">{translateShell("shell:plus_menu_removable_mode_chip")}</span>
  </div>;
}

export function DesignGuide() {
  const { t: translateShell } = useTranslation("shell");
  const [agentmailDemoKey, setAgentmailDemoKey] = useState("");
  const [wizardStep, setWizardStep] = useState(0);
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("medium");
  const [selectValue, setSelectValue] = useState("in_progress");
  const [menuChecked, setMenuChecked] = useState(true);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  const [inlineText, setInlineText] = useState(translateShell("shell:click_to_edit_this_text"));
  const [inlineTitle, setInlineTitle] = useState(translateShell("shell:editable_title"));
  const [inlineDesc, setInlineDesc] = useState(
    translateShell("shell:this_is_an_editable_description_click_to")
  );
  const [filters, setFilters] = useState<FilterValue[]>([
    { key: "status", label: translateShell("shell:status"), value: "Active" },
    // PAP-411: priority filter demo row suppressed while SHOW_TASK_PRIORITY_UI is off.
    ...(SHOW_TASK_PRIORITY_UI
      ? [{ key: "priority", label: translateShell("shell:priority"), value: "High" } as FilterValue]
      : []),
  ]);
  const [allowExternal, setAllowExternal] = useState(false);
  const [allowUnpinned, setAllowUnpinned] = useState(false);
  const [allowLocalPath, setAllowLocalPath] = useState(false);

  return (
    <div className="space-y-10 max-w-4xl">
      {/* Page header */}
      <div>
        <h2 className="text-xl font-bold">{translateShell("shell:design_guide")}</h2>
        <p className="text-sm text-muted-foreground mt-1">{translateShell("shell:every_component_style_and_pattern_used_across")}</p>
      </div>

      {/* ============================================================ */}
      {/*  COVERAGE                                                     */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:component_coverage")}>
        <p className="text-sm text-muted-foreground">{translateShell("shell:this_page_should_be_updated_when_new")}</p>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={translateShell("shell:ui_primitives")}>
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
          <SubSection title={translateShell("shell:app_components")}>
            <div className="flex flex-wrap gap-2">
              {[
                "StatusBadge", "StatusIcon", "PriorityIcon", "EntityRow", "EmptyState", "MetricCard",
                "FilterBar", "InlineEditor", "PageSkeleton", translateShell("shell:identity"), "CommentThread", "MarkdownEditor",
                "PropertiesPanel", translateShell("shell:sidebar"), "CommandPalette", "EnvironmentVariablesEditor",
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

      <Section title={translateShell("shell:announcements")}>
        <div className="grid gap-4 md:grid-cols-2">
          <AnnouncementCard announcement={announcementAnimationPreview} imageSrc="/announcement-preview.svg" animationSrc={announcementAnimationPreviewSrc} onDismiss={() => {}} />
          <AnnouncementCard announcement={announcementPreview} imageSrc="/announcement-preview.svg" onDismiss={() => {}} />
          <AnnouncementCard announcement={{ ...announcementPreview, image: undefined, secondaryLink: undefined }} onDismiss={() => {}} />
        </div>
      </Section>

      <Section title={translateShell("shell:task_execution_controls")}>
        <TaskExecutionControlsExample />
      </Section>

      <Section title={translateShell("shell:composer_actions")}>
        <ComposerActionsExample />
      </Section>

      <Section title={translateShell("shell:task_collection")}>
        <p className="max-w-prose text-sm text-muted-foreground">{translateShell("shell:collectiontoolbar_owns_shared_geometry_while_each_page")}</p>
        <CollectionToolbar
          context={<span className="text-sm font-medium">{translateShell("shell:recent_tasks")}</span>}
          search={<Input aria-label={translateShell("shell:search_task_collection_example")} placeholder={translateShell("shell:search_tasks_c1af83")} />}
          controls={<Button variant="outline" size="sm">{translateShell("shell:filter")}</Button>}
          actions={<Button size="sm">{translateShell("shell:new_task_3e9922")}</Button>}
          feedback={<span className="text-xs text-muted-foreground">{translateShell("shell:1_task_updated_newest_first")}</span>}
        />
        <div className="overflow-hidden rounded-lg border border-border">
          <IssueRow
            issue={DESIGN_GUIDE_TASK}
            presentation="task"
            unreadState="visible"
            metadata={<span className="text-xs text-muted-foreground">{translateShell("shell:updated_12m_ago")}</span>}
            actions={<Button variant="ghost" size="xs">{translateShell("shell:more")}</Button>}
          />
        </div>
      </Section>

      <Section title={translateShell("shell:theme_toggle")}>
        <SubSection title={translateShell("shell:variants")}>
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
      <Section title={translateShell("shell:colors")}>
        <SubSection title={translateShell("shell:core")}>
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

        <SubSection title={translateShell("shell:sidebar")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Sidebar" cssVar="--sidebar" />
            <Swatch name="Sidebar border" cssVar="--sidebar-border" />
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:chart")}>
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
      <Section title={translateShell("shell:runner_activity")}>
        <TaskChatRunnerActivityGroup item={{ id: "design-runner-activity", kind: "activity_phase", active: true, summary: "", interstitial: { id: "design-runner-commentary", kind: "message", author: "agent", text: "I’ll inspect the activity feed and check the layout.", interstitial: true }, items: [
          { id: "design-runner-read", kind: "tool", name: "read", target: "TaskChatRunnerTurn.tsx", status: "completed", detail: "Found the activity groups." },
          { id: "design-runner-check", kind: "tool", name: "exec_command", target: "pnpm check:token-gates", status: "in_progress" },
        ] }} />
        <TaskChatRunnerActivityGroup item={{ id: "design-runner-completed", kind: "activity_phase", active: false, summary: "", items: [
          { id: "design-completed-read", kind: "tool", name: "read", target: "TaskChatRunnerTurn.tsx", status: "completed", detail: "Read the activity groups." },
          { id: "design-completed-check", kind: "tool", name: "exec_command", target: "pnpm check:token-gates", status: "failed", detail: "A token check needs another pass." },
        ] }} />
      </Section>

      <Section title={translateShell("shell:typography")}>
        <div className="space-y-3">
          <h2 className="text-xl font-bold">{translateShell("shell:page_title_text_xl_font_bold")}</h2>
          <h2 className="text-lg font-semibold">{translateShell("shell:section_title_text_lg_font_semibold")}</h2>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{translateShell("shell:section_heading_text_sm_font_semibold_uppercase")}</h3>
          <p className="text-sm font-medium">{translateShell("shell:card_title_text_sm_font_medium")}</p>
          <p className="text-sm font-semibold">{translateShell("shell:card_title_alt_text_sm_font_semibold")}</p>
          <p className="text-sm">{translateShell("shell:body_text_text_sm")}</p>
          <p className="text-sm text-muted-foreground">{translateShell("shell:muted_description_text_sm_text_muted_foreground")}</p>
          <p className="text-xs text-muted-foreground">{translateShell("shell:tiny_label_text_xs_text_muted_foreground")}</p>
          <p className="text-sm font-mono text-muted-foreground">{translateShell("shell:mono_identifier_text_sm_font_mono_text")}</p>
          <p className="text-2xl font-bold">{translateShell("shell:large_stat_text_2xl_font_bold")}</p>
          <p className="font-mono text-xs">{translateShell("shell:log_code_text_font_mono_text_xs")}</p>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SPACING & RADIUS                                             */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:radius")}>
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
      <Section title={translateShell("shell:buttons")}>
        <SubSection title={translateShell("shell:variants")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="default">{translateShell("shell:default")}</Button>
            <Button variant="secondary">{translateShell("shell:secondary")}</Button>
            <Button variant="outline">{translateShell("shell:outline")}</Button>
            <Button variant="ghost">{translateShell("shell:ghost")}</Button>
            <Button variant="destructive">{translateShell("shell:destructive")}</Button>
            <Button variant="link">{translateShell("shell:link")}</Button>
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:sizes")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="xs">{translateShell("shell:extra_small")}</Button>
            <Button size="sm">{translateShell("shell:small")}</Button>
            <Button size="default">{translateShell("shell:default")}</Button>
            <Button size="lg">{translateShell("shell:large")}</Button>
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:icon_buttons")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" size="icon-xs"><Search /></Button>
            <Button variant="ghost" size="icon-sm"><Search /></Button>
            <Button variant="outline" size="icon"><Search /></Button>
            <Button variant="outline" size="icon-lg"><Search /></Button>
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:with_icons")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button><Plus />{" "}{translateShell("shell:new_issue")}</Button>
            <Button variant="outline"><Upload />{" "}{translateShell("shell:upload")}</Button>
            <Button variant="destructive"><Trash2 />{" "}{translateShell("shell:delete")}</Button>
            <Button size="sm"><Plus />{" "}{translateShell("shell:add")}</Button>
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:states")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button disabled>{translateShell("shell:disabled")}</Button>
            <Button variant="outline" disabled>{translateShell("shell:disabled_outline")}</Button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  BADGES                                                       */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:badges")}>
        <SubSection title={translateShell("shell:variants")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="default">{translateShell("shell:default")}</Badge>
            <Badge variant="secondary">{translateShell("shell:secondary")}</Badge>
            <Badge variant="outline">{translateShell("shell:outline")}</Badge>
            <Badge variant="destructive">{translateShell("shell:destructive")}</Badge>
            <Badge variant="ghost">{translateShell("shell:ghost")}</Badge>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  STATUS BADGES & ICONS                                        */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:status_system")}>
        <SubSection title={translateShell("shell:statusbadge_all_statuses")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              "active", "running", "paused", "idle", "archived", "planned",
              "achieved", "completed", "failed", "timed_out", "succeeded", "error",
              "pending_approval", "backlog", "todo", "in_progress", "in_review", "blocked",
              "done", "terminated", "cancelled", translateShell("shell:pending_62a2fe"), "revision_requested",
              "approved", "rejected",
            ].map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:issuestatusbadge_brand_chip_glyph_pap_75")}>
          <div className="flex items-center gap-2 flex-wrap">
            {["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"].map(
              (s) => (
                <IssueStatusBadge key={s} status={s} />
              )
            )}
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:monitoring_task")}>
          <StatusIcon status="in_progress" displayStatus="monitoring" showLabel />
          <IssueStatusBadge status="in_progress" displayStatus="monitoring" />
        </SubSection>
        <SubSection title={translateShell("shell:idle_slack_conversation")}>
          <StatusIcon status="in_review" externalConversationState="waiting" showLabel />
          <IssueStatusBadge status="in_review" externalConversationState="waiting" />
        </SubSection>
        <SubSection title={translateShell("shell:statusicon_interactive")}>
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
            <span className="text-sm">{translateShell("shell:click_the_icon_to_change_status_current", { value1: status })}</span>
          </div>
        </SubSection>

        {/* PAP-411: PriorityIcon showcase gated behind SHOW_TASK_PRIORITY_UI per board decision. */}
        {SHOW_TASK_PRIORITY_UI && (
        <SubSection title={translateShell("shell:priorityicon_interactive")}>
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
            <span className="text-sm">{translateShell("shell:click_the_icon_to_change_current", { value1: priority })}</span>
          </div>
        </SubSection>
        )}

        <SubSection title={translateShell("shell:agent_status_dots")}>
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

        <SubSection title={translateShell("shell:run_invocation_badges")}>
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

        <SubSection title="IssueReferencePill">
          <p className="text-xs text-muted-foreground"><Trans ns="shell" i18nKey="used_wherever_a_task_is_referenced_in" components={{ part1: <>{<code className="font-mono">status</code>}</>, part2: <>{<code className="font-mono">variant="property"</code>}</>, part3: <>{<code className="font-mono">onRemove</code>}</>, part4: <>{<code className="font-mono">strikethrough</code>}</> }} /></p>
          <div className="flex items-center gap-2 flex-wrap">
            <IssueReferencePill issue={{ id: "demo-1", identifier: "PAP-123", title: finalPagesT("final-pages:Identifier_only_no_status_yet_ceaa35") }} />
            <IssueReferencePill issue={{ id: "demo-2", identifier: "PAP-456", title: finalPagesT("final-pages:With_in_progress_status_b0a7b6"), status: "in_progress" }} />
            <IssueReferencePill issue={{ id: "demo-3", identifier: "PAP-789", title: finalPagesT("final-pages:Done_status_a2c1d1"), status: "done" }} />
            <IssueReferencePill issue={{ id: "demo-4", identifier: "PAP-101", title: finalPagesT("final-pages:Blocked_status_31b37c"), status: "blocked" }} />
            <IssueReferencePill onRemove={() => window.alert(finalPagesT("final-pages:Blocker_removed_e79254"))} issue={{ id: "demo-blocker", identifier: "PAP-303", title: finalPagesT("final-pages:Hover_or_focus_to_remove_blocker_7407b8"), status: "in_review" }} />
            <IssueReferencePill strikethrough issue={{ id: "demo-5", identifier: "PAP-202", title: finalPagesT("final-pages:Removed_strikethrough_009f6b"), status: "todo" }} />
          </div>
        </SubSection>

        <SubSection title="LockedIssueChip">
          <p className="text-xs text-muted-foreground"><Trans ns="shell" i18nKey="existence_only_reference_to_a_private_task" components={{ part1: <>{<strong>{finalPagesT("final-pages:no_title_never_a_link_8eaf63")}</strong>}</> }} /></p>
          <div className="flex items-center gap-2 flex-wrap">
            <LockedIssueChip identifier="PAP-1234" />
            <LockedIssueChip identifier={null} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  AGENT CAPSULE                                                */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:agent_capsule")}>
        <p className="text-sm text-muted-foreground max-w-prose"><Trans ns="shell" i18nKey="the_brand_capsule_is_the_agent_motif" components={{ part1: <>{<code className="font-mono">--agent-Na</code>}</>, part2: <>{<code className="font-mono">--agent-Nb</code>}</>, part3: <>{<code className="font-mono">prefers-reduced-motion</code>}</> }} /></p>
        <SubSection title={translateShell("shell:states")}>
          <div className="flex items-end gap-10">
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="slot" />
              <span className="text-xs text-muted-foreground">{translateShell("shell:slot")}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="configured" />
              <span className="text-xs text-muted-foreground">{translateShell("shell:configured")}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" gradient={5} />
              <span className="text-xs text-muted-foreground">{translateShell("shell:online")}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" gradient={5} glow="blue" />
              <span className="text-xs text-muted-foreground">{translateShell("shell:online_blue_glow")}</span>
            </div>
          </div>
        </SubSection>
        <SubSection title={translateShell("shell:sizes")}>
          <div className="flex items-end gap-8">
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size="sm" gradient={1} />
              <span className="text-xs text-muted-foreground">{"sm"}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size="md" gradient={4} />
              <span className="text-xs text-muted-foreground">{"md"}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size="lg" gradient={8} />
              <span className="text-xs text-muted-foreground">lg</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size={{ width: 28, height: 96 }} gradient={6} />
              <span className="text-xs text-muted-foreground">{translateShell("shell:custom_px")}</span>
            </div>
          </div>
        </SubSection>
        <SubSection title={translateShell("shell:gradients")}>
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
      <Section title={translateShell("shell:form_elements")}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={translateShell("shell:input")}>
            <Input placeholder={translateShell("shell:default_input")} />
            <Input placeholder={translateShell("shell:disabled_input")} disabled className="mt-2" />
          </SubSection>

          <SubSection title={translateShell("shell:textarea")}>
            <Textarea placeholder={translateShell("shell:write_something")} />
          </SubSection>

          <SubSection title={translateShell("shell:checkbox_label")}>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox id="check1" defaultChecked />
                <Label htmlFor="check1">{translateShell("shell:checked_item")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check2" />
                <Label htmlFor="check2">{translateShell("shell:unchecked_item")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check3" disabled />
                <Label htmlFor="check3">{translateShell("shell:disabled_item")}</Label>
              </div>
            </div>
          </SubSection>

          <SubSection title={translateShell("shell:inline_editor")}>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{translateShell("shell:title_single_line")}</p>
                <InlineEditor
                  value={inlineTitle}
                  onSave={setInlineTitle}
                  as="h2"
                  className="text-xl font-bold"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{translateShell("shell:body_text_single_line")}</p>
                <InlineEditor
                  value={inlineText}
                  onSave={setInlineText}
                  as="p"
                  className="text-sm"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{translateShell("shell:description_multiline_auto_sizing")}</p>
                <InlineEditor
                  value={inlineDesc}
                  onSave={setInlineDesc}
                  as="p"
                  className="text-sm text-muted-foreground"
                  placeholder={translateShell("shell:add_a_description")}
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
      <Section title={translateShell("shell:select_2a7802")}>
        <p className="mb-4 text-sm text-muted-foreground">{translateShell("shell:native_single_value_dropdowns_share_an_inset")}</p>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={translateShell("shell:default_size")}>
            <Select value={selectValue} onValueChange={setSelectValue}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={translateShell("shell:select_status")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="backlog">{translateShell("shell:backlog")}</SelectItem>
                <SelectItem value="todo">{translateShell("shell:todo")}</SelectItem>
                <SelectItem value="in_progress">{translateShell("shell:in_progress_b4cc4b")}</SelectItem>
                <SelectItem value="in_review">{translateShell("shell:in_review")}</SelectItem>
                <SelectItem value="done">{translateShell("shell:done")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{translateShell("shell:current_value", { value1: selectValue })}</p>
          </SubSection>
          <SubSection title={translateShell("shell:small_trigger")}>
            <Select defaultValue="high">
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">{translateShell("shell:critical")}</SelectItem>
                <SelectItem value="high">{translateShell("shell:high")}</SelectItem>
                <SelectItem value="medium">{translateShell("shell:medium")}</SelectItem>
                <SelectItem value="low">{translateShell("shell:low")}</SelectItem>
              </SelectContent>
            </Select>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DROPDOWN MENU                                                */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:dropdown_menu")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">{translateShell("shell:quick_actions")}<ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem>
              <Check className="h-4 w-4" />{translateShell("shell:mark_as_done")}<DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <BookOpen className="h-4 w-4" />{translateShell("shell:open_docs")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={menuChecked}
              onCheckedChange={(value) => setMenuChecked(value === true)}
            >{translateShell("shell:watch_issue")}</DropdownMenuCheckboxItem>
            <DropdownMenuItem variant="destructive">
              <Trash2 className="h-4 w-4" />{translateShell("shell:delete_issue")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      {/* ============================================================ */}
      {/*  POPOVER                                                      */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:popover")}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">{translateShell("shell:open_popover")}</Button>
          </PopoverTrigger>
          <PopoverContent className="space-y-2">
            <p className="text-sm font-medium">{translateShell("shell:agent_heartbeat")}</p>
            <p className="text-xs text-muted-foreground">{translateShell("shell:last_run_succeeded_24s_ago_next_timer")}</p>
            <Button size="xs">{translateShell("shell:wake_now")}</Button>
          </PopoverContent>
        </Popover>
      </Section>

      {/* ============================================================ */}
      {/*  COLLAPSIBLE                                                  */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:collapsible")}>
        <Collapsible open={collapsibleOpen} onOpenChange={setCollapsibleOpen} className="space-y-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              {collapsibleOpen ? translateShell("shell:hide") : translateShell("shell:show")}{" "}{translateShell("shell:advanced_filters")}</Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border border-border p-3">
            <div className="space-y-2">
              <Label htmlFor="owner-filter">{translateShell("shell:owner")}</Label>
              <Input id="owner-filter" placeholder={translateShell("shell:filter_by_agent_name")} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Section>

      {/* ============================================================ */}
      {/*  SHEET                                                        */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:sheet")}>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm">{translateShell("shell:open_side_panel")}</Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>{translateShell("shell:issue_properties")}</SheetTitle>
              <SheetDescription>{translateShell("shell:edit_metadata_without_leaving_the_current_page")}</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4">
              <div className="space-y-1">
                <Label htmlFor="sheet-title">{translateShell("shell:title")}</Label>
                <Input id="sheet-title" defaultValue="Improve onboarding docs" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sheet-description">{translateShell("shell:description")}</Label>
                <Textarea id="sheet-description" defaultValue="Capture setup pitfalls and screenshots." />
              </div>
            </div>
            <SheetFooter>
              <Button variant="outline">{translateShell("shell:cancel")}</Button>
              <Button>{translateShell("shell:save")}</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Section>

      {/* ============================================================ */}
      {/*  SCROLL AREA                                                  */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:scroll_area")}>
        <ScrollArea className="h-36 rounded-md border border-border">
          <div className="space-y-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-sm">{translateShell("shell:heartbeat_run_completed_successfully", { value1: i + 1 })}</div>
            ))}
          </div>
        </ScrollArea>
      </Section>

      {/* ============================================================ */}
      {/*  COMMAND                                                      */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:command_cmdk")}>
        <div className="rounded-md border border-border">
          <Command>
            <CommandInput placeholder={translateShell("shell:type_a_command_or_search")} />
            <CommandList>
              <CommandEmpty>{translateShell("shell:no_results_found")}</CommandEmpty>
              <CommandGroup heading={finalPagesT("final-pages:Pages_9046da")}>
                <CommandItem>
                  <LayoutDashboard className="h-4 w-4" />{translateShell("shell:dashboard")}</CommandItem>
                <CommandItem>
                  <CircleDot className="h-4 w-4" />{translateShell("shell:issues")}</CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading={finalPagesT("final-pages:Actions_ff8059")}>
                <CommandItem>
                  <CommandIcon className="h-4 w-4" />{translateShell("shell:open_command_palette")}</CommandItem>
                <CommandItem>
                  <Plus className="h-4 w-4" />{translateShell("shell:create_new_issue")}</CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BREADCRUMB                                                   */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:breadcrumb")}>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{translateShell("shell:projects")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{translateShell("shell:paperclip_app")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{translateShell("shell:issue_list")}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Section>

      {/* ============================================================ */}
      {/*  CARDS                                                        */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:cards")}>
        <SubSection title={translateShell("shell:dashboard_agent_runs")}>
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
          <p className="text-xs text-muted-foreground">{translateShell("shell:the_dashboard_and_live_runs_page_use")}</p>
        </SubSection>
        <SubSection title={translateShell("shell:standard_card")}>
          <Card>
            <CardHeader>
              <CardTitle>{translateShell("shell:card_title")}</CardTitle>
              <CardDescription>{translateShell("shell:card_description_with_supporting_text")}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{translateShell("shell:card_content_goes_here_this_is_the")}</p>
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">{translateShell("shell:action")}</Button>
              <Button variant="outline" size="sm">{translateShell("shell:cancel")}</Button>
            </CardFooter>
          </Card>
        </SubSection>

        <SubSection title={translateShell("shell:metric_cards")}>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard icon={Bot} value={12} label={translateShell("shell:active_agents")} description={translateShell("shell:3_this_week")} />
            <MetricCard icon={CircleDot} value={48} label={translateShell("shell:open_issues")} />
            <MetricCard icon={DollarSign} value="$1,234" label={translateShell("shell:monthly_cost")} description={translateShell("shell:under_budget")} />
            <MetricCard icon={Zap} value="99.9%" label={translateShell("shell:uptime")} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TABS                                                         */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:tabs")}>
        <SubSection title={translateShell("shell:default_pill_variant")}>
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">{translateShell("shell:overview")}</TabsTrigger>
              <TabsTrigger value="runs">{translateShell("shell:runs")}</TabsTrigger>
              <TabsTrigger value="config">{translateShell("shell:config")}</TabsTrigger>
              <TabsTrigger value="costs">{translateShell("shell:costs")}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <p className="text-sm text-muted-foreground py-4">{translateShell("shell:overview_tab_content")}</p>
            </TabsContent>
            <TabsContent value="runs">
              <p className="text-sm text-muted-foreground py-4">{translateShell("shell:runs_tab_content")}</p>
            </TabsContent>
            <TabsContent value="config">
              <p className="text-sm text-muted-foreground py-4">{translateShell("shell:config_tab_content")}</p>
            </TabsContent>
            <TabsContent value="costs">
              <p className="text-sm text-muted-foreground py-4">{translateShell("shell:costs_tab_content")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>

        <SubSection title={translateShell("shell:line_variant")}>
          <Tabs defaultValue="summary">
            <TabsList variant="line">
              <TabsTrigger value="summary">{translateShell("shell:summary")}</TabsTrigger>
              <TabsTrigger value="details">{translateShell("shell:details")}</TabsTrigger>
              <TabsTrigger value="comments">{translateShell("shell:comments")}</TabsTrigger>
            </TabsList>
            <TabsContent value="summary">
              <p className="text-sm text-muted-foreground py-4">{translateShell("shell:summary_content_with_underline_tabs")}</p>
            </TabsContent>
            <TabsContent value="details">
              <p className="text-sm text-muted-foreground py-4">{translateShell("shell:details_content")}</p>
            </TabsContent>
            <TabsContent value="comments">
              <p className="text-sm text-muted-foreground py-4">{translateShell("shell:comments_content")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  ENTITY ROWS                                                  */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:entity_rows")}>
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
            title={translateShell("shell:implement_authentication_flow")}
            subtitle={translateShell("shell:extra_24_responsible_agent_alpha")}
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
            title={translateShell("shell:set_up_ci_cd_pipeline")}
            subtitle={translateShell("shell:extra_23_completed_2_days_ago")}
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
            title={translateShell("shell:write_api_documentation")}
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
            title={translateShell("shell:deploy_to_production")}
            subtitle={translateShell("shell:extra_22_blocked_by_pap_001")}
            trailing={<IssueStatusBadge status="blocked" />}
            selected
          />
        </div>
        <SubSection title={translateShell("shell:membership_action")}>
          <div className="border border-border rounded-md">
            <EntityRow
              title={translateShell("shell:joined_resource")}
              subtitle={translateShell("shell:extra_21_hover_or_focus_the_row_to_reveal_the_reserved")}
              className="group"
              trailing={
                <MembershipAction
                  state="joined"
                  resourceName={finalPagesT("final-pages:Joined_resource_33c4f6")}
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title={translateShell("shell:left_resource")}
              subtitle={translateShell("shell:extra_20_persistent_action_with_dimmed_row_content_")}
              className="group text-foreground/55"
              trailing={
                <MembershipAction
                  state="left"
                  resourceName={finalPagesT("final-pages:Left_resource_cdd43b")}
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title={translateShell("shell:leaving_resource")}
              subtitle={translateShell("shell:extra_19_disabled_while_the_optimistic_mutation_is_pen")}
              className="group text-foreground/55"
              trailing={
                <MembershipAction
                  state="left"
                  pending
                  pendingState="left"
                  resourceName={finalPagesT("final-pages:Leaving_resource_64205c")}
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title={translateShell("shell:joining_resource")}
              subtitle={translateShell("shell:extra_18_the_target_state_is_visible_immediately_while")}
              className="group"
              trailing={
                <MembershipAction
                  state="joined"
                  pending
                  pendingState="joined"
                  resourceName={finalPagesT("final-pages:Joining_resource_6dcacc")}
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
      <Section title={translateShell("shell:filter_bar")}>
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
                { key: "status", label: finalPagesT("final-pages:Status_920e41"), value: "Active" },
                // PAP-411: priority filter demo row suppressed while SHOW_TASK_PRIORITY_UI is off.
                ...(SHOW_TASK_PRIORITY_UI
                  ? [{ key: "priority", label: finalPagesT("final-pages:Priority_d60dbb"), value: "High" } as FilterValue]
                  : []),
              ])
            }
          >{translateShell("shell:reset_filters")}</Button>
        )}
      </Section>

      {/* ============================================================ */}
      {/*  AVATARS                                                      */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:avatars")}>
        <SubSection title={translateShell("shell:sizes")}>
          <div className="flex items-center gap-3">
            <Avatar size="sm"><AvatarFallback>SM</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>DF</AvatarFallback></Avatar>
            <Avatar size="lg"><AvatarFallback>LG</AvatarFallback></Avatar>
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:group")}>
          <AvatarGroup>
            <Avatar><AvatarFallback>A1</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A2</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A3</AvatarFallback></Avatar>
            <AvatarGroupCount>+5</AvatarGroupCount>
          </AvatarGroup>
        </SubSection>
      </Section>

      <Section title={translateShell("shell:app_logos")}>
        <SubSection title={translateShell("shell:official_marks_and_runtime_fallback")}>
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
      <Section title={translateShell("shell:agent_personas")}>
        <SubSection title={translateShell("shell:stable_palette_identities")}>
          <div className="flex flex-wrap gap-3">{AGENT_PALETTE_IDS.map(palette => <AgentAvatar key={palette} appearance={appearanceForPalette(palette)} size={48} label={palette} />)}</div>
        </SubSection>
        <SubSection title={translateShell("shell:onboarding_and_live_character")}>
          <p className="text-sm text-muted-foreground">{translateShell("shell:place_one_live_character_beside_the_agent")}</p>
          <div className="flex gap-4"><AgentCharacter muted state="sleepy" motion="still" size={128} /><AgentCharacter size={128} /></div>
        </SubSection>
      </Section>
      <Section title={translateShell("shell:human_identity")}>
        <SubSection title={translateShell("shell:sizes")}>
          <div className="flex items-center gap-6">
            <Identity name="Alex Morgan" size="sm" />
            <Identity name="Alex Morgan" />
            <Identity name="Alex Morgan" size="lg" />
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:initials_derivation")}>
          <div className="flex flex-col gap-2">
            <Identity name="Casey Jordan" size="sm" />
            <Identity name="Alpha" size="sm" />
            <Identity name="Quinn Lee" size="sm" />
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:custom_initials")}>
          <Identity name="Backend Service" initials="BS" size="sm" />
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLTIPS                                                     */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:tooltips")}>
        <div className="flex items-center gap-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm">{translateShell("shell:hover_me")}</Button>
            </TooltipTrigger>
            <TooltipContent>{translateShell("shell:this_is_a_tooltip")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm"><Settings /></Button>
            </TooltipTrigger>
            <TooltipContent>{translateShell("shell:settings")}</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DIALOG                                                       */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:dialog")}>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">{translateShell("shell:open_dialog")}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{translateShell("shell:dialog_title")}</DialogTitle>
              <DialogDescription>{translateShell("shell:this_is_a_sample_dialog_showing_the")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>{translateShell("shell:name")}</Label>
                <Input placeholder={translateShell("shell:enter_a_name")} className="mt-1.5" />
              </div>
              <div>
                <Label>{translateShell("shell:description")}</Label>
                <Textarea placeholder={translateShell("shell:describe")} className="mt-1.5" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline">{translateShell("shell:cancel")}</Button>
              <Button>{translateShell("shell:save")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      {/* ============================================================ */}
      {/*  EMPTY STATE                                                  */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:empty_state")}>
        <div className="border border-border rounded-md">
          <EmptyState
            icon={Inbox}
            message={translateShell("shell:extra_17_no_items_to_show_create_your_first_one_to_get")}
            action={translateShell("shell:extra_16_create_item")}
            onAction={() => {}}
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROGRESS BARS                                                */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:progress_bars_budget")}>
        <div className="space-y-3">
          {[
            { label: translateShell("shell:under_budget_40"), pct: 40, color: "bg-green-400" },
            { label: translateShell("shell:warning_75"), pct: 75, color: "bg-yellow-400" },
            { label: translateShell("shell:over_budget_95"), pct: 95, color: "bg-red-400" },
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
      <Section title={translateShell("shell:log_viewer")}>
        <div className="bg-neutral-950 rounded-lg p-3 font-mono text-xs max-h-80 overflow-y-auto">
          <div className="text-foreground">[12:00:01] INFO  Agent started successfully</div>
          <div className="text-foreground">[12:00:02] INFO  Processing task PAP-001</div>
          <div className="text-yellow-400">[12:00:05] WARN  Rate limit approaching (80%)</div>
          <div className="text-foreground">[12:00:08] INFO  Task PAP-001 completed</div>
          <div className="text-red-400">[12:00:12] ERROR Connection timeout to upstream service</div>
          <div className="text-blue-300">[12:00:12] SYS   Retrying connection in 5s...</div>
          <div className="text-foreground">[12:00:17] INFO  Reconnected successfully</div>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 animate-pulse" />
              <span className="inline-flex h-full w-full rounded-full bg-blue-500" />
            </span>
            <span className="text-blue-600 dark:text-blue-400">{translateShell("shell:live_b64ac0")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROPERTY ROW PATTERN                                         */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:property_row_pattern")}>
        <div className="border border-border rounded-md p-4 space-y-1 max-w-sm">
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{translateShell("shell:status")}</span>
            <StatusBadge status="active" />
          </div>
          {/* PAP-411: priority metadata row hidden behind SHOW_TASK_PRIORITY_UI. */}
          {SHOW_TASK_PRIORITY_UI && (
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-muted-foreground">{translateShell("shell:priority")}</span>
              <PriorityIcon priority="high" />
            </div>
          )}
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{translateShell("shell:responsible")}</span>
            <div className="flex items-center gap-1.5">
              <Avatar size="sm"><AvatarFallback>A</AvatarFallback></Avatar>
              <span className="text-xs">Agent Alpha</span>
            </div>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{translateShell("shell:created_d70b9e")}</span>
            <span className="text-xs">Jan 15, 2025</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  NAVIGATION PATTERNS                                          */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:navigation_patterns")}>
        <SubSection title={translateShell("shell:independent_mcp_connections")}>
          <p className="text-sm text-muted-foreground">{translateShell("shell:zapier_arcade_composio_and_executor_each_own")}</p>
          <RemoteMcpDesignExample />
        </SubSection>
        <SubSection title={translateShell("shell:setup_wizard")}>
          <p className="text-sm text-muted-foreground">{translateShell("shell:shared_by_connection_setup_and_trigger_previews")}</p>
          <div className="max-w-sm space-y-6">
            <SetupWizardNavigation inline labels={["Choose trigger", "Configure", "Review"]} step={wizardStep} availableStep={2} onSelect={setWizardStep} />
            <SetupWizardFooter onSaveExit={() => setWizardStep(0)}><Button onClick={() => setWizardStep((wizardStep + 1) % 3)}>{translateShell("shell:continue")}</Button></SetupWizardFooter>
          </div>
        </SubSection>
        <SubSection title={translateShell("shell:agent_chat_picker")}>
          <AgentChatPickerExample />
          <SubSection title={translateShell("shell:agent_conversation_sidebar")}>
            <div className="flex flex-wrap gap-4">
              <div className="h-96 w-60"><AgentConversationSidebar agents={[]} onSelect={() => {}} onBrowse={() => {}} /></div>
              <div className="h-96 w-60"><AgentConversationSidebar agents={[]} loading /></div>
              <div className="h-96 w-60"><AgentConversationSidebar agents={[]} error={new Error(translateShell("shell:unavailable"))} onRetry={() => {}} /></div>
            </div>
          </SubSection>
        </SubSection>
        <SubSection title={translateShell("shell:sidebar_nav_items")}>
          <p className="text-sm text-muted-foreground">{translateShell("shell:layout_accepts_sidebarsections_to_compose_additional_sidebarsection")}</p>
          <Card className="block w-60 p-3 space-y-0.5">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-accent-foreground">
              <LayoutDashboard className="h-4 w-4" />{translateShell("shell:dashboard")}</div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <CircleDot className="h-4 w-4" />{translateShell("shell:issues")}<Badge variant="ghost" className="ml-auto bg-primary text-primary-foreground px-1.5">
                12
              </Badge>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Bot className="h-4 w-4" />{translateShell("shell:agents")}</div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Hexagon className="h-4 w-4" />{translateShell("shell:projects")}</div>
          </Card>
        </SubSection>

        <SubSection title={translateShell("shell:view_toggle")}>
          <div className="flex items-center border border-border rounded-md w-fit">
            <button className="px-3 py-1.5 text-xs font-medium bg-accent text-foreground rounded-l-md">
              <ListTodo className="h-3.5 w-3.5 inline mr-1" />{translateShell("shell:list")}</button>
            <button className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 rounded-r-md">
              <Target className="h-3.5 w-3.5 inline mr-1" />{translateShell("shell:org")}</button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  GROUPED LIST (Issues pattern)                                */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:grouped_list_issues_pattern")}>
        <div>
          <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 rounded-t-md">
            <StatusIcon status="in_progress" />
            <span className="text-sm font-medium">{translateShell("shell:in_progress_b4cc4b")}</span>
            <span className="text-xs text-muted-foreground ml-1">2</span>
          </div>
          <div className="border border-border rounded-b-md">
            {/* PAP-411: leading PriorityIcon hidden behind SHOW_TASK_PRIORITY_UI. */}
            <EntityRow
              leading={SHOW_TASK_PRIORITY_UI ? <PriorityIcon priority="high" /> : undefined}
              identifier="PAP-101"
              title={translateShell("shell:build_agent_heartbeat_system")}
              onClick={() => {}}
            />
            <EntityRow
              leading={SHOW_TASK_PRIORITY_UI ? <PriorityIcon priority="medium" /> : undefined}
              identifier="PAP-102"
              title={translateShell("shell:add_cost_tracking_dashboard")}
              onClick={() => {}}
            />
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COMMENT THREAD PATTERN                                       */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:comment_thread_pattern")}>
        <div className="space-y-3 max-w-2xl">
          <h3 className="text-sm font-semibold">{translateShell("shell:comments_2")}</h3>
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{translateShell("shell:agent_11b39c")}</span>
                <span className="text-xs text-muted-foreground">Jan 15, 2025</span>
              </div>
              <p className="text-sm">{translateShell("shell:started_working_on_the_authentication_module_will")}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{translateShell("shell:human")}</span>
                <span className="text-xs text-muted-foreground">{"Jan 16, 2025"}</span>
              </div>
              <p className="text-sm">{translateShell("shell:api_keys_have_been_added_to_the")}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Textarea placeholder={translateShell("shell:leave_a_comment")} rows={3} />
            <Button size="sm">{translateShell("shell:comment")}</Button>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COST TABLE PATTERN                                           */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:cost_table_pattern")}>
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-accent/20">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{translateShell("shell:model")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{translateShell("shell:tokens")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{translateShell("shell:cost")}</th>
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
                <td className="px-3 py-2 font-medium">{translateShell("shell:total")}</td>
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
      <Section title={translateShell("shell:skeletons")}>
        <SubSection title={translateShell("shell:individual")}>
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-8 w-full max-w-sm" />
            <Skeleton className="h-20 w-full" />
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:page_skeleton_list")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="list" />
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:page_skeleton_detail")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="detail" />
          </div>
        </SubSection>
        <SubSection title={translateShell("shell:task_conversation_loading")}>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="relative h-96 overflow-hidden rounded-md border border-border">
              <TaskChatLoadingShell mobile={false} streamlined coordinator={false} />
            </div>
            <div className="coordinator-workspace relative h-96 overflow-hidden rounded-md border border-border">
              <TaskChatLoadingShell mobile streamlined coordinator />
            </div>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  SEPARATOR                                                    */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:separator")}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{translateShell("shell:horizontal")}</p>
          <Separator />
          <div className="flex items-center gap-4 h-8">
            <span className="text-sm">{translateShell("shell:left")}</span>
            <Separator orientation="vertical" />
            <span className="text-sm">{translateShell("shell:right")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  ICON REFERENCE                                               */}
      {/* ============================================================ */}
      {/*  TEAM CATALOG                                                 */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:team_catalog")}>
        <p className="text-sm text-muted-foreground"><Trans ns="shell" i18nKey="components_from_the_team_catalog_browse_install" components={{ part1: <>{<code className="font-mono text-xs">/teams-catalog</code>}</> }} /></p>

        <SubSection title={translateShell("shell:teamrow_browse_list")}>
          <div className="w-(--sz-28rem) rounded-md border border-border">
            <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">{translateShell("shell:bundled_1")}</div>
            <TeamRow team={sampleTeam} selected onSelect={() => {}} />
            <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">{translateShell("shell:optional_2")}</div>
            <TeamRow team={optionalTeam} selected={false} onSelect={() => {}} />
            <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">{translateShell("shell:installed_2")}</div>
            <TeamRow team={sampleTeam} selected={false} onSelect={() => {}} installed={outOfDateInstalledState} />
            <TeamRow team={warnTeam} selected={false} onSelect={() => {}} installed={currentInstalledState} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground"><Trans ns="shell" i18nKey="installed_teams_collapse_under_an_out_of" components={{ part1: <>{<code className="font-mono">{finalPagesT("final-pages:INSTALLED_N_4d29db")}</code>}</>, part2: <>{<code className="font-mono">originHash</code>}</>, part3: <>{<code className="font-mono">contentHash</code>}</>, part4: <>{<code className="font-mono">↑</code>}</> }} /></p>
        </SubSection>

        <SubSection title={finalPagesT("final-pages:TeamCard_onboarding_grid_74466b")}>
          <p className="text-xs text-muted-foreground"><Trans ns="shell" i18nKey="square_tile_for_the_onboarding_pick_a" components={{ part1: <>{<code className="font-mono">ring-2 ring-ring</code>}</>, part2: <>{<code className="font-mono">useInstallTeamCatalogEntry</code>}</> }} /></p>
          <TeamCardShowcase />
        </SubSection>

        <SubSection title="TeamHierarchyPreview">
          <div className="max-w-md">
            <TeamHierarchyPreview team={sampleTeam} />
          </div>
        </SubSection>

        <SubSection title="RequiredSkillsList">
          <div className="max-w-xl">
            <RequiredSkillsList skills={sampleTeam.requiredSkills} />
          </div>
        </SubSection>

        <SubSection title="EnvInputsList">
          <div className="max-w-xl">
            <EnvInputsList inputs={sampleTeam.envInputs} />
          </div>
        </SubSection>

        <SubSection title="ExternalSourcesList">
          <div className="max-w-xl">
            <ExternalSourcesList sources={sampleTeam.sourceRefs} />
          </div>
        </SubSection>

        <SubSection title={translateShell("shell:source_policy_step_stepsourcepolicy")}>
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

        <SubSection title={translateShell("shell:skill_plan_step_stepskillplan")}>
          <div className="max-w-xl rounded-md border border-border p-4">
            <StepSkillPlan team={sampleTeam} preparations={sampleSkillPreparations} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      <Section title={translateShell("shell:common_icons_lucide")}>
        <div className="grid grid-cols-4 md:grid-cols-6 gap-4">
          {[
            [translateShell("shell:inbox"), Inbox],
            ["ListTodo", ListTodo],
            ["CircleDot", CircleDot],
            [translateShell("shell:hexagon"), Hexagon],
            [translateShell("shell:target"), Target],
            ["LayoutDashboard", LayoutDashboard],
            [translateShell("shell:bot"), Bot],
            ["DollarSign", DollarSign],
            [translateShell("shell:history"), History],
            [translateShell("shell:search"), Search],
            [translateShell("shell:plus"), Plus],
            ["Trash2", Trash2],
            [translateShell("shell:settings"), Settings],
            [translateShell("shell:user"), User],
            [translateShell("shell:mail"), Mail],
            [translateShell("shell:upload"), Upload],
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
      <Section title={translateShell("shell:keyboard_shortcuts")}>
        <div className="border border-border rounded-md divide-y divide-border text-sm">
          {[
            ["Cmd+K / Ctrl+K", translateShell("shell:open_command_palette_581096")],
            ["C", translateShell("shell:new_issue_outside_inputs")],
            ["[", translateShell("shell:toggle_sidebar")],
            ["]", translateShell("shell:toggle_properties_panel")],

            ["Cmd+Enter / Ctrl+Enter", translateShell("shell:submit_markdown_comment")],
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

      <Section title={translateShell("shell:issue_output_surface")}>
        <SubSection title={translateShell("shell:multiple_outputs_primary_video_also_produced")}>
          <IssueOutputSection workProducts={DESIGN_GUIDE_OUTPUTS} />
        </SubSection>
        <SubSection title={translateShell("shell:degraded_output_invalid_failed_attachment_metadata")}>
          <IssueOutputSection workProducts={DESIGN_GUIDE_DEGRADED_OUTPUTS} />
        </SubSection>
        <SubSection title={translateShell("shell:empty_state_b72556")}>
          <p className="text-xs text-muted-foreground">{translateShell("shell:when_an_issue_has_produced_no_artifact")}</p>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLS & ACCESS (PAP-10389)                                   */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:tools_access")}>
        <SubSection title={translateShell("shell:enforcementbanner_default_denied_detected")}>
          <div className="space-y-3">
            <EnforcementBanner companyId="" forceVariant="default" recentDenialCount={0} />
            <EnforcementBanner companyId="" forceVariant="denied-detected" recentDenialCount={3} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground"><Trans ns="shell" i18nKey="persistent_at_the_top_of_the_tools" components={{ part1: <>{<code>denied-detected</code>}</> }} /></p>
        </SubSection>

        <SubSection title={translateShell("shell:enforcementbanner_presentational_tones_info_warning_error")}>
          <div className="space-y-3">
            <EnforcementBanner
              tone="info"
              title={translateShell("shell:effective_access_server_resolved")}
              body={finalPagesT("final-pages:This_is_exactly_what_the_tool_gateway_will_accept_Profile_and_pol_f7e93a")}
            />
            <EnforcementBanner
              tone="warning"
              title={translateShell("shell:local_stdio_is_local_code_execution_not")}
              body={finalPagesT("final-pages:A_local_stdio_slot_runs_with_the_orchestrator_s_privileges_Only_b_c73d33")}
            />
            <EnforcementBanner
              tone="error"
              title={translateShell("shell:runtime_failed_closed")}
              body={finalPagesT("final-pages:The_supervisor_is_restarting_attempt_2_3_The_gateway_returns_runt_3210e8")}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground"><Trans ns="shell" i18nKey="static_governance_copy_with_a_tone_used" components={{ part1: <>{<code>title</code>}</>, part2: <>{<code>body</code>}</>, part3: <>{<code>icon</code>}</> }} /></p>
        </SubSection>

        <SubSection title={translateShell("shell:action_approval_card_pending_stale_surfaces_11")}>
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
              reason={translateShell("shell:extra_15_this_tool_can_write_to_your_workspace_so_a_hu")}
              policyNumber={7}
              expiresInLabel={finalPagesT("final-pages:expires_in_23h_51m_88e51d")}
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
              reason={translateShell("shell:extra_15_this_tool_can_write_to_your_workspace_so_a_hu")}
              policyNumber={7}
              expiresInLabel={finalPagesT("final-pages:expires_in_18h_02m_e165b7")}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground"><Trans ns="shell" i18nKey="signed_payload_sha256_expiry_surface_on_every" components={{ part1: <>{<code>stale</code>}</>, part2: <>{<code>{finalPagesT("final-pages:Approve_6007ac")}</code>}</> }} /></p>
        </SubSection>

        <SubSection title={translateShell("shell:action_approval_card_mobile_390_844_surface")}>
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
              reason={translateShell("shell:extra_15_this_tool_can_write_to_your_workspace_so_a_hu")}
              policyNumber={7}
              expiresInLabel={finalPagesT("final-pages:expires_in_23h_51m_88e51d")}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{translateShell("shell:identical_content_the_three_buttons_stack_full")}</p>
        </SubSection>

        <SubSection title={translateShell("shell:bindingstable_reused_in_the_audit_row_drilldown")}>
          <BindingsTable
            rows={[
              { label: finalPagesT("final-pages:Application_e7ad52"), value: "Slack · manifest v2.4.1" },
              { label: finalPagesT("final-pages:Connection_639a40"), value: "https://slack.com/api · acme-workspace", mono: true },
              { label: finalPagesT("final-pages:Catalog_3877d1"), value: "sha256:9f86d081…f00a08", mono: true },
              { label: finalPagesT("final-pages:Payload_997333"), value: "sha256:2c26b46b…66e7ae", mono: true },
            ]}
          />
          <p className="mt-2 text-xs text-muted-foreground"><Trans ns="shell" i18nKey="two_column_key_value_block_with_mono" components={{ part1: <>{<code>ActionCard</code>}</> }} /></p>
        </SubSection>

        <SubSection title={translateShell("shell:tool_access_status_keys_statusbadge")}>
          <div className="flex flex-wrap items-center gap-2">
            {[
              "allowed", "denied", "block", "require-approval", "redacted", "rate-limit",
              "deferred", "hidden", "quarantined", "healthy", "degraded", "runtime-error", "unchecked",
            ].map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground"><Trans ns="shell" i18nKey="policy_decisions_connection_runtime_health_and_catalog" components={{ part1: <>{<code>StatusBadge</code>}</>, part2: <>{<code>lib/status-colors</code>}</> }} /></p>
        </SubSection>

        <SubSection title={translateShell("shell:emptystate_canonical_with_description_action")}>
          <EmptyState
            icon={Inbox}
            message={translateShell("shell:extra_14_no_connections_yet")}
            description={translateShell("shell:add_a_connection_to_an_application_to")}
            action={translateShell("shell:extra_13_new_connection")}
            onAction={() => {}}
          />
        </SubSection>
      </Section>

      <Section title={translateShell("shell:github_skill_sources")}>
        <p className="text-sm text-muted-foreground">{translateShell("shell:the_shared_filetree_explorer_layout_puts_disclosure")}</p>
        <SkillSourceTreeShowcase />
        <SkillBinaryFile file={{ skillId: "example", path: "assets/example.bin", kind: "asset", content: "AAECAw==", encoding: "base64", language: null, markdown: false, editable: false }} />
      </Section>

      <Section title={translateShell("shell:source_repositories")}>
        <SubSection title={translateShell("shell:empty_and_disconnected")}>
          <RepositoryEditor selected={[]} onChange={() => {}} state="disconnected" onConnect={() => {}} onRetry={() => {}} />
        </SubSection>
        <SubSection title={translateShell("shell:selected_and_searchable")}>
          <RepositoryEditor selected={[{ id: "1", fullName: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip", connections: ["Your GitHub"] }]}
            available={[{ id: "2", fullName: "paperclipai/docs", url: "https://github.com/paperclipai/docs", connections: ["Company GitHub"] }]}
            onChange={() => {}} onConnect={() => {}} onRetry={() => {}} />
        </SubSection>
        <p className="text-sm text-muted-foreground">{translateShell("shell:loading_errors_empty_search_mobile_and_short")}</p>
      </Section>

      <Section title={translateShell("shell:environment_variables_editor")}>
        <p className="text-sm text-muted-foreground"><Trans ns="shell" i18nKey="reusable_env_var_editor_agents_projects_environments" components={{ part1: <>{<span className="font-mono">{finalPagesT("final-pages:Product_Environment_Variables_Editor_732eaa")}</span>}</> }} /></p>
        <EnvironmentVariablesEditorShowcase />
      </Section>

      <Section title={translateShell("shell:tasks_created_from_a_task")}>
        <SubSection title={translateShell("shell:subtasks_and_created_work_are_independent")}>
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
        <SubSection title={translateShell("shell:empty_loading_and_failed")}>
          <TaskDetailTasksPanel subtasks={[]} createdTasks={[]} projects={[]} />
          <TaskDetailTasksPanel subtasks={[]} createdTasks={[]} projects={[]} isLoading />
          <TaskDetailTasksPanel subtasks={[]} createdTasks={[]} projects={[]} hasError onRetry={() => {}} />
        </SubSection>
      </Section>

      <Section title={translateShell("shell:disposition_recovery_notice")}>
        <SubSection title={translateShell("shell:needs_attention_with_inspectable_details")}>
          <DispositionRecoveryNotice snapshot={{ kind: "disposition_repair_escalated", actionId: "design-recovery", attemptCount: 2, maxAttempts: 2, reason: "unchanged_source_state_exhausted", assigneeAgentId: null }} defaultExpanded />
        </SubSection>
        <p className="text-sm text-muted-foreground">{translateShell("shell:storybook_s_recovery_notice_stories_show_the")}</p>
      </Section>

      <Section title={translateShell("shell:pending_task_input_above_composer")}>
        <p className="mb-3 text-sm text-muted-foreground">{translateShell("shell:a_decision_card_sits_above_the_ordinary")}</p>
        <TaskPendingInputExample />
      </Section>

      <Section title={translateShell("shell:execution_recovery")}>
        <p className="text-sm text-muted-foreground">{translateShell("shell:recovery_runs_in_the_background_task_lists")}</p>
        <p className="text-sm text-muted-foreground">{translateShell("shell:when_retained_file_recovery_needs_another_authorized")}</p>
      </Section>

      <Section title={translateShell("shell:cloud_sign_in_unavailable")}>
        <CloudSignIn cloud={{ managed: true, managedBy: "paperclip-cloud", cloudBaseUrl: null, stackSlug: null }} returnTo="/" />
      </Section>

      <Section title={translateShell("shell:saved_provider_api_keys")}>
        <SavedProviderKeySelect options={[{ id: "example", label: "Claude API key (Your key)", binding: { type: "user_secret_ref", key: "ANTHROPIC_API_KEY", version: "latest" } }]} value="example" onChange={() => {}} loading={false} error={false} />
        <SavedProviderKeySelect options={[]} value="" onChange={() => {}} loading error={false} />
        <SavedProviderKeySelect options={[]} value="" onChange={() => {}} loading={false} error />
      </Section>

      <Section title={translateShell("shell:voice_conversations")}>
        <div className="flex flex-col gap-6">
          <VoiceControls state="working" agentName="Company Phone Agent" onStart={() => {}} onMute={() => {}} onEnd={() => {}} onResumeAudio={() => {}} />
          <VoiceControls state="failed" agentName="Company Phone Agent" error={translateShell("shell:extra_12_microphone_access_was_denied_allow_access_in_")} onStart={() => {}} onMute={() => {}} onEnd={() => {}} onResumeAudio={() => {}} />
          <VoiceTranscript agentName="Company Phone Agent" entries={[
            { id: "ack", source: "agent", text: "I’m checking that now.", final: true },
            { id: "followup", source: "user", text: "Include the revised delivery address too.", final: true },
          ]} />
        </div>
      </Section>

      <Section title={translateShell("shell:speko_provider_setup")}>
        <SpekoPhoneCallbackForm onSave={() => {}} />
        <SpekoCallHistoryView onRetry={() => {}} />
        <div className="divide-y divide-border border-y border-border">
          <SpekoCallActivityItem presentation="activity" entry={{session: {id: "demo-call", companyId: "demo", endpointId: "demo", issueId: "demo-task", assignedAgentId: "demo-agent", state: "ended", mode: "browser", generation: 1, callerAuthority: "member", replyCursor: 0, createdAt: "2026-10-07T17:00:00Z", expiresAt: "2026-10-07T17:10:00Z", endedAt: "2026-10-07T17:02:00Z", errorCode: null}, report: {status: "pending", costMicroUsd: null, durationSeconds: null, updatedAt: null, transcript: []}}} />
          <SpekoUnapprovedCallActivityItem presentation="activity" call={{id: "demo-missed", state: "expired", createdAt: "2026-10-07T17:00:00Z", updatedAt: "2026-10-07T17:02:00Z"}} />
        </div>
        <SpekoPhoneLineForm onRefresh={() => {}} onSave={() => {}} />
        <SpekoIncomingCallCard call={{id: "demo", state: "awaiting_approval", approvalCode: "123456", createdAt: "2026-10-07T17:00:00Z", expiresAt: "2026-10-07T17:02:00Z", sessionId: null}} onDecide={() => {}} />
        <SpekoProviderSetup agentName="Company Phone Agent" callbackUrl="https://paperclip.example/api/voice-webhooks/example/tools" credentials={{}} onChange={() => {}} onConnect={() => {}} />
      </Section>

      <Section title={translateShell("shell:external_agent_invitation")}>
        <p className="text-sm text-muted-foreground">{translateShell("shell:match_the_harness_picker_with_provider_cards")}</p>
        <ExternalAgentPresetPicker onSelect={() => {}} />
        <DotConnectionChecks state={{ phase: "testing" }} />
        <ExternalAgentPresetPicker museEnabled onSelect={() => {}} />
        <MuseConnectionChecks state={{ paired: true, receiverDetected: true, backgroundReplyVerified: false, ready: false }} />
        <MuseConnectionChecks state={{ paired: true, receiverDetected: true, backgroundReplyVerified: true, ready: false, problem: "agent_unavailable" }} />
        <MuseConnectionChecks state={{ paired: true, receiverDetected: true, backgroundReplyVerified: true, ready: true }} />
        <MuseConnectionDetails connection={{ enabled: false, publicOrigin: null, agentStatus: "idle", agentLifecycleState: "ready", canConfigureConnection: true, binding: null, usage: null, cost: null }} onTest={() => {}} onRepair={() => {}} onPause={() => {}} onDisconnect={() => {}} onRefresh={() => {}} onAttest={() => {}} />
        <Dialog><DialogTrigger asChild><Button variant="outline">{translateShell("shell:preview_invitation_modal")}</Button></DialogTrigger>
          <AnimatedDialogContent><div className="space-y-4 p-6"><DialogTitle>{translateShell("shell:invite_an_external_agent")}</DialogTitle><DialogDescription>{translateShell("shell:choose_an_agent_you_already_use")}</DialogDescription><ExternalAgentPresetPicker onSelect={() => {}} /></div></AnimatedDialogContent>
        </Dialog>
      </Section>

      <Section title={translateShell("shell:browser_setup_prompt")}>
        <p className="text-sm text-muted-foreground">{translateShell("shell:use_agentsetupprompt_for_prompts_handed_to_an")}</p>
        <SetupPrompt prompt={finalPagesT("final-pages:Design_guide_example_This_is_a_preview_not_a_real_provider_setup__54722e")} />
        <p className="text-sm text-muted-foreground">{translateShell("shell:for_a_named_recipient_pass_the_optional")}</p>
        <SetupPrompt prompt={finalPagesT("final-pages:Design_guide_example_for_Dot_No_live_pairing_code_32c680")} label={translateShell("shell:copy_setup_prompt")} title={translateShell("shell:connect_your_dot")} agent={{ name: "Dot", src: "/brands/adapters/openai-dot.svg" }} />
      </Section>

      <Section title={translateShell("shell:connection_intent")}>
        <p className="text-sm text-muted-foreground">{translateShell("shell:the_task_card_is_the_dialog_host")}</p>
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

      <Section title={translateShell("shell:agentmail_api_key")}>
        <p className="text-sm text-muted-foreground">{translateShell("shell:agentmail_setup_has_two_steps_pick_an")}</p>
        <p className="text-sm text-muted-foreground">{translateShell("shell:preview_only_this_field_does_not_save")}</p>
        <div className="max-w-md">
          <AgentMailApiKeyField value={agentmailDemoKey} onChange={setAgentmailDemoKey} />
        </div>
      </Section>

      <Section title={translateShell("shell:resizable_panels")}>
        <p className="text-sm text-muted-foreground"><Trans ns="shell" i18nKey="design_system_wrapper_over_skill_studio_d2" components={{ part1: <>{<span className="font-mono">react-resizable-panels</span>}</>, part2: <>{<span className="font-mono">minSize="240px"</span>}</> }} /></p>
        <div className="h-48 max-w-2xl overflow-hidden rounded-md border border-border">
          <ResizablePanelGroup>
            <ResizablePanel id="a" minSize="120px" className="bg-muted/30">
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{translateShell("shell:panel_a")}</div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="b" minSize="120px" collapsible collapsedSize="40px" className="bg-muted/10">
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{translateShell("shell:panel_b_collapsible")}</div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="c" minSize="120px" className="bg-muted/30">
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{translateShell("shell:panel_c")}</div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  INLINE BANNER + BUILT-IN AGENTS                              */}
      {/* ============================================================ */}
      <Section title={translateShell("shell:webhook_url_warnings")}>
        <div className="space-y-3">
          {["http://localhost:3100", "https://paperclip.internal", "https://paperclip.example-tailnet.ts.net", "http://paperclip.example.com", "not-a-url"].map((url) => <WebhookUrlWarning key={url} url={url} />)}
        </div>
      </Section>

      <Section title={translateShell("shell:inline_banner")}>
        <p className="text-sm text-muted-foreground"><Trans ns="shell" i18nKey="token_backed_full_width_notice_tones_use" components={{ part1: <>{<span className="font-mono">brandBanner</span>}</>, part2: <>{<span className="font-mono">info</span>}</>, part3: <>{<span className="font-mono">warning</span>}</>, part4: <>{<span className="font-mono">bg-yellow-*</span>}</>, part5: <>{<span className="font-mono">bg-blue-*</span>}</> }} /></p>
        <div className="space-y-3">
          <InlineBanner
            tone="info"
            title={translateShell("shell:built_in_agent_4bdd28")}
            actions={<Button variant="outline" size="sm">{translateShell("shell:reset_to_defaults")}</Button>}
          ><Trans ns="shell" i18nKey="ships_with_paperclip_and_powers_it_can" components={{ part1: <>{<strong>{finalPagesT("final-pages:Briefs_997b20")}</strong>}</> }} /></InlineBanner>
          <InlineBanner
            tone="warning"
            title={translateShell("shell:briefs_is_paused")}
            actions={
              <>
                <Button variant="ghost" size="sm">{translateShell("shell:view_agent")}</Button>
                <Button size="sm">{translateShell("shell:resume_agent")}</Button>
              </>
            }
          >{translateShell("shell:its_built_in_agent_was_paused_2")}</InlineBanner>
          <InlineBanner
            tone="danger"
            title={translateShell("shell:summary_generation_failed")}
            actions={<Button size="sm">{translateShell("shell:retry")}</Button>}
          >{translateShell("shell:the_linked_issue_reached_a_terminal_state")}</InlineBanner>
          <InlineBanner tone="info" compact>{translateShell("shell:compact_variant_for_embedding_inside_dialogs_and")}</InlineBanner>
        </div>
      </Section>

      <Section title={translateShell("shell:text_attachment_tabs")}>
        <p className="text-sm text-muted-foreground">{translateShell("shell:uploaded_text_opens_in_a_named_task")}</p>
        <div className="grid gap-4 md:grid-cols-2">
          <TextAttachmentPreview title="README.md" text={"# Project notes\n\nReview the **original** file."} markdown downloadUrl="data:text/markdown,%23%20Project%20notes" />
          <TextAttachmentPreview title="notes.txt" text="Plain text stays literal: <example>" markdown={false} downloadUrl="data:text/plain,Plain%20text" />
        </div>
      </Section>

      <Section title={translateShell("shell:connection_recovery")}>
        <SubSection title={translateShell("shell:waiting_for_server")}>
          <CloudAccessError temporary retrying={false} onRetry={() => undefined} />
        </SubSection>
        <SubSection title={translateShell("shell:checking_connection")}>
          <CloudAccessError temporary retrying onRetry={() => undefined} />
        </SubSection>
        <SubSection title={translateShell("shell:access_check_failed")}>
          <CloudAccessError temporary={false} retrying={false} onRetry={() => undefined} />
        </SubSection>
      </Section>

      <Section title={translateShell("shell:browser_session_footer")}>
        <p className="text-sm text-muted-foreground">{translateShell("shell:fit_to_pane_follows_the_visible_panel")}</p>
        {(["running", "idle", "closing-soon", "closed"] as const).map((state) => (
          <SubSection key={state} title={state === "closing-soon" ? translateShell("shell:closing_soon") : getPageValueLabel(state)}>
            <TaskBrowserFooter
              browser={{
                id: "design-browser", sessionId: "design-session", issueId: "design-task",
                status: state === "closing-soon" ? "idle" : state,
                runStatus: "completed", progress: null, error: null, costCents: 15,
                idleDeadline: new Date(state === "closing-soon" ? 282000 : 600000).toISOString(),
                expiresAt: null, createdAt: new Date(0).toISOString(),
              } satisfies TaskBrowser}
              now={0}
              onControl={() => {}}
              onReconnect={() => {}}
              onResize={() => {}}
            />
          </SubSection>
        ))}
      </Section>

      <Section title={translateShell("shell:browser_activity_in_the_task_feed")}>
        <p className="text-sm text-muted-foreground">{translateShell("shell:each_browser_appears_once_at_its_opening")}</p>
        {(["starting", "running", "idle", "closed", "failed"] as const).map((status) => (
          <SubSection key={status} title={getPageValueLabel(status)}>
            <TaskBrowserActivity browser={{
              id: `design-${status}`, sessionId: `design-${status}`, issueId: "design-task", status,
              runStatus: "completed", progress: null, error: null, costCents: 0,
              idleDeadline: null, expiresAt: null, createdAt: new Date(0).toISOString(),
            }} onOpen={() => {}} />
          </SubSection>
        ))}
      </Section>

      <Section title={translateShell("shell:media_artifacts")}>
        <p className="text-sm text-muted-foreground">{translateShell("shell:images_and_videos_use_gallery_tiles_the")}</p>
        <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          <MediaArtifactCard id="design-image" title={translateShell("shell:launch_artwork")} contentPath="/announcement-preview.svg" contentType="image/svg+xml" originalFilename="launch.svg" detail={finalPagesT("final-pages:Image_1aa4cb")} />
          <MediaArtifactCard id="design-video" title={translateShell("shell:video_preview_unavailable")} contentPath="" contentType="video/mp4" originalFilename="preview.mp4" detail={finalPagesT("final-pages:Video_d534be")} />
        </div>
      </Section>

      <Section title={translateShell("shell:ai_connections")}>
        <AiConnectionDesignExamples />
      </Section>

      <Section title={translateShell("shell:built_in_agent_lifecycle_chips")}>
        <p className="text-sm text-muted-foreground"><Trans ns="shell" i18nKey="a_derived_lifecycle_chip_amber_for_attention" components={{ part1: <>{<span className="font-mono">needs_setup</span>}</>, part2: <>{<span className="font-mono">pending_approval</span>}</> }} /></p>
        <div className="flex flex-wrap items-center gap-4">
          <BuiltInLifecycleChip status="needs_setup" />
          <BuiltInLifecycleChip status="pending_approval" />
          <BuiltInLifecycleChip status="needs_setup" compact />
        </div>
        <p className="mt-3 text-sm text-muted-foreground"><Trans ns="shell" i18nKey="composes_to_render_the_loading_setup_pending" components={{ part1: <>{<span className="font-mono">&lt;BuiltInAgentGate agentKey&gt;</span>}</>, part2: <>{<span className="font-mono">PageSkeleton</span>}</>, part3: <>{<span className="font-mono">EmptyState</span>}</>, part4: <>{<span className="font-mono">InlineBanner</span>}</> }} /></p>
      </Section>
    </div>
  );
}

function SkillSourceTreeShowcase() {
  const { t: translateShell } = useTranslation("shell");
  const candidates = [
    { path: ".agents/review/SKILL.md", name: "Review", description: "Review changes before release.", error: null, inspection: { requirements: null, references: [], warnings: [], files: [
      { path: "SKILL.md", kind: "skill", sizeBytes: 120, encoding: "utf8" as const, executable: false },
      { path: "scripts/check.sh", kind: "script", sizeBytes: 45, encoding: "utf8" as const, executable: true },
    ] } },
    { path: ".agents/review/nested/SKILL.md", name: "Nested skill", description: "An independently selected package.", error: null, note: translateShell("shell:new_skill") },
    { path: "broken/SKILL.md", name: "Needs attention", description: null, error: translateShell("shell:missing_required_description") },
  ];
  const [selected, setSelected] = useState(new Set(candidates.map(skill => skill.path)));
  const [excluded, setExcluded] = useState<string[]>([]);
  return <SkillSourceTree candidates={candidates} selected={selected} excludedFolders={excluded} onChange={(paths, folders) => { setSelected(paths); setExcluded(folders); }} />;
}
