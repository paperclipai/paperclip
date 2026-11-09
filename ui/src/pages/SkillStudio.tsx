import { SkillsPageNavigation } from "@/components/skill-studio/SkillsNavigationTabs";
import { interactionReadinessRefetchInterval } from "@/lib/issue-thread-interactions";
import { SkillBinaryFile } from "../components/SkillBinaryFile";
import { SkillSourceProvenance } from "../components/SkillSourceProvenance";
import { AgentIdentity } from "@/components/AgentIdentity";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FileCode,
  FilePlus,
  FileText,
  FolderMinus,
  FolderPlus,
  FlaskConical,
  GitFork,
  History,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Share2,
  Trash2,
} from "lucide-react";
import type {
  Agent,
  CompanySkillDetail,
  CompanySkillListItem,
  CompanySkillTestInput,
  CompanySkillTestRun,
  CompanySkillTestRunDetail,
  CompanySkillTestRunTemplate,
  CompanySkillTestRunTemplateCreateRequest,
  CompanySkillTestRunTemplateUpdateRequest,
  IssueDocument,
  IssueThreadInteraction,
  AskUserQuestionsInteraction,
  AskUserQuestionsAnswer,
} from "@paperclipai/shared";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "@/lib/router";
import {
  SearchableSelect,
  type SearchableSelectGroup,
  type SearchableSelectOption,
} from "@/components/SearchableSelect";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useOptionalToastActions } from "../context/ToastContext";
import { classifySkillDenial } from "@/lib/skill-policy-denial";
import { agentsApi } from "@/api/agents";
import { companySkillsApi } from "@/api/companySkills";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { t, useTranslation } from "@/i18n";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useCopyToast } from "@/lib/use-copy-action";
import { skillStudioNewRoute, skillStudioRoute } from "@/lib/company-skill-routes";
import {
  buildBlankSkillDraft,
  buildForkSkillDraft,
  defaultSkillMarkdown,
  normalizeSkillDraftSlug,
  SKILL_CREATE_ACCENTS,
  skillAccentColor,
  skillCreateDraftToPayload,
  splitCategoryDraft,
  type SkillCreateDraft,
} from "@/lib/skill-create";
import { getRecentStudioSkillIds, trackRecentStudioSkill } from "@/lib/recent-skills";
import { AgentsUsingSkillBadge } from "@/components/skill-studio/AgentsUsingSkillDialog";
import { ForkSkillDialog } from "@/components/skill-studio/ForkSkillDialog";
import {
  ProjectScanNotice,
  SkillLineageChip,
} from "@/components/skill-studio/SkillProvenance";
import { isProjectScanSkill } from "@/lib/skill-fork";
import { cn, formatCents, relativeTime } from "@/lib/utils";
import { SkillCardIcon, type DiscoveryCard } from "./CompanySkills";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable-panels";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileTree, buildFileTree, type FileTreeNode } from "@/components/FileTree";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { FrontmatterPanel } from "@/components/FrontmatterPanel";
import { joinFrontmatterBlock, splitFrontmatterBlock } from "@paperclipai/shared";
import { MarkdownBody } from "@/components/MarkdownBody";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { EntityRow } from "@/components/EntityRow";
import { FilterBar } from "@/components/FilterBar";
import { Identity } from "@/components/Identity";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { IssueAttachmentsSection } from "@/components/IssueAttachmentsSection";
import { ImageGalleryModal, type GalleryMediaItem } from "@/components/ImageGalleryModal";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { IssueOutputSection } from "@/components/issue-output/IssueOutputSection";
import { buildLineDiff } from "@/lib/line-diff";
import {
  buildCreateRunRequest,
  buildReRunRequest,
  DEFAULT_TEST_RUN_TEMPLATE_ID,
  EMPTY_SAVED_INPUT_DRAFT_STATE,
  evaluateRunGate,
  getRunAdditionalDocuments,
  getRunMediaGalleryItems,
  getRunRawAttachments,
  isAgentSelectable,
  isInteractionAnswerable,
  isTerminalRunStatus,
  orderRecentlyUpdatedSkills,
  orderRecentlyVisitedSkills,
  skillEditorAvatar,
  NO_TEST_RUN_TEMPLATE_STORAGE_VALUE,
  parseRunTemplateSelection,
  routeInteraction,
  runBadgeStatus,
  runHarnessUnavailableCopy,
  runOutputMode,
  runShortId,
  resolveRunTemplateSelection,
  serializeRunTemplateSelection,
  savedInputDraftDirty,
  selectedSavedInputDraft,
  shouldPollRun,
  showRunErrorCard,
  syncSavedInputDraftState,
  testTaskLinkState,
  type RunTemplateSelection,
  type SavedInputDraftState,
} from "@/lib/skill-studio";

const PANE_STORAGE_KEY = "skillStudio.paneSizes";
const RUN_TEMPLATE_STORAGE_KEY_PREFIX = "skillStudio.runTemplate";
const MOBILE_BREAKPOINT = 900;
const POLL_MS = 2000;
const EMPTY_RUN_TEMPLATES: CompanySkillTestRunTemplate[] = [];

/**
 * Surface a mutation rejection as an error toast. Every Studio mutation routes
 * failures through here so server rejections (409 agent_not_assignable, 422
 * read-only, …) never get silently swallowed (PAP-13001).
 */
function useMutationErrorToast() {
  const toast = useOptionalToastActions();
  return useCallback(
    (title: string) => (error: unknown) => {
      // Under the open default there is no permission chrome. When an action is
      // actually denied — by an explicit company policy (State B) or a platform
      // safety invariant (State C) — show the actionable denial title/remediation
      // instead of a generic "try again" error (§9.10, PAP-13865). Transient
      // failures keep the plain error toast.
      const denial = classifySkillDenial(error);
      if (denial) {
        toast?.pushToast({ tone: "warn", title: denial.title, body: denial.remediation });
        return;
      }
      const body =
        error instanceof Error && error.message ? error.message : t("skills.SkillStudio.tryAgain");
      toast?.pushToast({ tone: "error", title, body });
    },
    [toast],
  );
}

// ---------------------------------------------------------------------------
// Pane-size persistence (contract: persist per user `skillStudio.paneSizes`)
// ---------------------------------------------------------------------------

type PaneLayout = { skill: number; input: number; runs: number };
const DEFAULT_LAYOUT: PaneLayout = { skill: 37.5, input: 25, runs: 37.5 };

function loadPaneLayout(): PaneLayout {
  try {
    const raw = localStorage.getItem(PANE_STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<PaneLayout>;
    if (
      typeof parsed?.skill === "number"
      && typeof parsed?.input === "number"
      && typeof parsed?.runs === "number"
    ) {
      return { skill: parsed.skill, input: parsed.input, runs: parsed.runs };
    }
  } catch {
    /* ignore malformed persisted layout */
  }
  return DEFAULT_LAYOUT;
}

function runTemplateStorageKey(companyId: string) {
  return `${RUN_TEMPLATE_STORAGE_KEY_PREFIX}.${companyId}`;
}

function loadRunTemplateSelection(companyId: string): RunTemplateSelection {
  try {
    return parseRunTemplateSelection(localStorage.getItem(runTemplateStorageKey(companyId)));
  } catch {
    return DEFAULT_TEST_RUN_TEMPLATE_ID;
  }
}

function persistRunTemplateSelection(companyId: string, selection: RunTemplateSelection) {
  try {
    localStorage.setItem(runTemplateStorageKey(companyId), serializeRunTemplateSelection(selection));
  } catch {
    /* storage may be unavailable (private mode) — non-fatal */
  }
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT,
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function SkillStudio() {
  const { t } = useTranslation();
  const { skillId = "" } = useParams<{ skillId: string }>();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const companyId = selectedCompanyId ?? "";
  const isCreateMode = location.pathname.replace(/\/+$/, "").endsWith("/skills/studio/new");
  const forkFromSkillId = isCreateMode ? searchParams.get("forkFrom")?.trim() || null : null;
  // New skills created from a folder context (e.g. My Skills) carry their
  // destination folder through this query param; without it the created skill
  // silently lands in Unfiled (PAP-14086).
  const newSkillFolderId = isCreateMode ? searchParams.get("folderId")?.trim() || null : null;

  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(companyId),
    queryFn: () => companySkillsApi.list(companyId, { sort: "alphabetical" }),
    enabled: Boolean(companyId),
  });

  const detailQuery = useQuery({
    queryKey: queryKeys.companySkills.detail(companyId, skillId),
    queryFn: () => companySkillsApi.detail(companyId, skillId),
    enabled: Boolean(companyId && skillId && !isCreateMode),
  });
  const detailView = useQueryView(detailQuery);
  const forkDetailQuery = useQuery({
    queryKey: queryKeys.companySkills.detail(companyId, forkFromSkillId ?? ""),
    queryFn: () => companySkillsApi.detail(companyId, forkFromSkillId!),
    enabled: Boolean(companyId && forkFromSkillId),
  });
  const skill = detailQuery.data ?? null;

  useEffect(() => {
    setBreadcrumbs(
      isCreateMode
        ? [
            { label: t("skills.SkillStudio.breadcrumbSkills"), href: "/skills" },
            { label: "Studio", href: "/skills/studio" },
            { label: t("skills.SkillStudio.newSkill") },
          ]
        : skill
        ? [
            { label: t("skills.SkillStudio.breadcrumbSkills"), href: "/skills" },
            { label: "Studio", href: "/skills/studio" },
            { label: skill.name },
          ]
        : [
            { label: t("skills.SkillStudio.breadcrumbSkills"), href: "/skills" },
            { label: "Studio" },
          ],
    );
  }, [isCreateMode, setBreadcrumbs, skill, t]);

  // Record a per-browser visit whenever a skill successfully opens, powering the
  // landing's "Recently visited" section (PAP-13150).
  useEffect(() => {
    if (skill?.id) trackRecentStudioSkill(skill.id);
  }, [skill?.id]);

  if (!companyId) {
    return <StudioMessage message={t("skills.SkillStudio.selectOrganization")} />;
  }
  if (isCreateMode) {
    return (
      <StudioCreateMode
        companyId={companyId}
        skills={skillsQuery.data ?? []}
        skillsLoading={skillsQuery.isLoading}
        forkFromSkillId={forkFromSkillId}
        folderId={newSkillFolderId}
        forkSkill={forkDetailQuery.data ?? null}
        forkLoading={forkDetailQuery.isLoading}
        forkError={forkDetailQuery.isError}
        onSelectSkill={(nextSkillId) => navigate(skillStudioRoute(nextSkillId))}
      />
    );
  }
  if (!skillId) {
    return (
      <StudioLanding
        companyId={companyId}
        skills={skillsQuery.data ?? []}
        skillsLoading={skillsQuery.isLoading}
        onSelectSkill={(nextSkillId) => navigate(skillStudioRoute(nextSkillId))}
        onCreateNew={() => navigate(skillStudioNewRoute())}
      />
    );
  }
  if (detailQuery.isLoading || detailView.kind === "reconnecting") {
    return <StudioMessage message={t("skills.SkillStudio.loadingSkill")} />;
  }
  // "Not found" only for a real 404; an outage never looks like a missing skill.
  if (detailView.kind === "error" && detailView.errorKind !== "not_found") {
    return (
      <QueryErrorState
        size="page"
        error={detailQuery.error}
        action={t("errorActions.loadThisSkill")}
        onRetry={detailView.retry}
        retrying={detailView.isFetching}
      />
    );
  }
  if (detailView.kind === "error" || !detailQuery.data) {
    return <StudioMessage message={t("skills.SkillStudio.skillNotFound")} />;
  }

  return (
    <StudioShell
      companyId={companyId}
      skill={detailQuery.data}
      skills={skillsQuery.data ?? []}
      skillsLoading={skillsQuery.isLoading}
    />
  );
}

function StudioCreateMode({
  companyId,
  skills,
  skillsLoading,
  forkFromSkillId,
  folderId,
  forkSkill,
  forkLoading,
  forkError,
  onSelectSkill,
}: {
  companyId: string;
  skills: CompanySkillListItem[];
  skillsLoading: boolean;
  forkFromSkillId: string | null;
  folderId: string | null;
  forkSkill: CompanySkillDetail | null;
  forkLoading: boolean;
  forkError: boolean;
  onSelectSkill: (skillId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-3 py-2">
          <SkillSwitcher
            skill={null}
            skills={skills}
            loading={skillsLoading}
            onSelectSkill={onSelectSkill}
            emptyLabel={t("skills.SkillStudio.newSkill")}
          />
        </header>
        <SkillsPageNavigation activeView="authored" />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <StudioNewSkillPanel
            companyId={companyId}
            forkFromSkillId={forkFromSkillId}
            folderId={folderId}
            forkSkill={forkSkill}
            forkLoading={forkLoading}
            forkError={forkError}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

function StudioNewSkillPanel({
  companyId,
  forkFromSkillId,
  folderId,
  forkSkill,
  forkLoading,
  forkError,
}: {
  companyId: string;
  forkFromSkillId: string | null;
  folderId: string | null;
  forkSkill: CompanySkillDetail | null;
  forkLoading: boolean;
  forkError: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const initialDraft = useMemo(() => {
    const base = forkSkill ? buildForkSkillDraft(forkSkill) : buildBlankSkillDraft();
    // An explicit folder context from the URL wins over a fork source's folder
    // so the new skill is filed where the user launched creation (PAP-14086).
    return folderId ? { ...base, folderId } : base;
  }, [forkSkill, folderId]);
  const [draft, setDraft] = useState<SkillCreateDraft>(initialDraft);
  const [slugDirty, setSlugDirty] = useState(initialDraft.slug.trim().length > 0);
  const [categoryDraft, setCategoryDraft] = useState(initialDraft.categories.join(", "));
  const parsedCategories = splitCategoryDraft(categoryDraft);
  const effectiveSlug = draft.slug.trim() || normalizeSkillDraftSlug(draft.name);
  const nameValid = draft.name.trim().length > 0;

  useEffect(() => {
    setDraft(initialDraft);
    setSlugDirty(initialDraft.slug.trim().length > 0);
    setCategoryDraft(initialDraft.categories.join(", "));
  }, [initialDraft]);

  function patchDraft(patch: Partial<SkillCreateDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  const createSkill = useMutation({
    mutationFn: () => companySkillsApi.create(companyId, skillCreateDraftToPayload({
      ...draft,
      categories: parsedCategories,
    })),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) });
      toast?.pushToast({
        tone: "success",
        title: skill.forkedFromSkillId ? t("skills.SkillStudio.forkCreated") : t("skills.SkillStudio.skillCreated"),
        body: t("skills.SkillStudio.skillEditable", { name: skill.name }),
      });
      navigate(skillStudioRoute(skill.id));
    },
    onError: (error) => {
      toast?.pushToast({
        tone: "error",
        title: t("skills.SkillStudio.skillCreationFailed"),
        body: error instanceof Error ? error.message : t("skills.SkillStudio.createSkillFailed"),
      });
    },
  });

  if (forkFromSkillId && forkLoading) {
    return <StudioMessage message={t("skills.SkillStudio.loadingForkSource")} />;
  }

  const previewCard: DiscoveryCard = {
    key: effectiveSlug || draft.name || "new-skill",
    skillId: null,
    catalogRef: null,
    name: draft.name || t("skills.SkillStudio.newSkillPreview"),
    slug: effectiveSlug || "skill",
    author: "you",
    version: null,
    tagline: draft.tagline || null,
    description: draft.tagline,
    categories: parsedCategories,
    iconUrl: null,
    color: draft.color,
    starCount: 0,
    agentCount: 0,
    forkCount: 0,
    installed: false,
    required: false,
    forkedFrom: Boolean(draft.forkedFromSkillId),
    updatedAt: Date.now(),
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">
          {draft.forkedFromSkillId ? t("skills.SkillStudio.forkSkill") : t("skills.SkillStudio.createNewSkill")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("skills.SkillStudio.createSkillDescription")}
        </p>
      </div>

      {draft.forkedFromName ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <GitFork className="h-4 w-4" />
          {t("skills.SkillStudio.forkingFrom", { name: draft.forkedFromName })}
        </div>
      ) : forkError ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {t("skills.SkillStudio.forkSourceNotFound")}
        </div>
      ) : null}

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">{t("skills.SkillStudio.basics")}</h2>
          <p className="text-xs text-muted-foreground">{t("skills.SkillStudio.basicsHelp")}</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="skill-name">{t("common.name")}</Label>
            <Input
              id="skill-name"
              value={draft.name}
              onChange={(event) => {
                const nextName = event.target.value;
                patchDraft({
                  name: nextName,
                  slug: slugDirty ? draft.slug : normalizeSkillDraftSlug(nextName),
                  markdown: draft.markdown === defaultSkillMarkdown(draft.name, draft.tagline)
                    ? defaultSkillMarkdown(nextName, draft.tagline)
                    : draft.markdown,
                });
              }}
              placeholder={t("skills.SkillStudio.namePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="skill-slug">{t("skills.SkillStudio.slug")}</Label>
            <Input
              id="skill-slug"
              value={draft.slug}
              onChange={(event) => {
                const nextSlug = normalizeSkillDraftSlug(event.target.value);
                setSlugDirty(nextSlug.length > 0);
                patchDraft({ slug: nextSlug });
              }}
              placeholder="code-review"
              className="font-mono"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="skill-tagline">{t("skills.SkillStudio.tagline")}</Label>
          <Textarea
            id="skill-tagline"
            value={draft.tagline}
            onChange={(event) => {
              const nextTagline = event.target.value;
              patchDraft({
                tagline: nextTagline,
                description: draft.description ? draft.description : nextTagline,
                markdown: draft.markdown === defaultSkillMarkdown(draft.name, draft.tagline)
                  ? defaultSkillMarkdown(draft.name, nextTagline)
                  : draft.markdown,
              });
            }}
            placeholder={t("skills.SkillStudio.taglinePlaceholder")}
            className="min-h-20"
          />
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">{t("skills.SkillStudio.appearance")}</h2>
          <p className="text-xs text-muted-foreground">{t("skills.SkillStudio.appearanceHelp")}</p>
        </div>
        <div className="flex items-center gap-3">
          <SkillCardIcon card={previewCard} size={48} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{previewCard.name}</div>
            <div className="truncate text-xs text-muted-foreground">{draft.tagline || t("skills.SkillStudio.noTagline")}</div>
          </div>
        </div>
        <div className="space-y-2">
          <Label>{t("skills.SkillStudio.color")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            {SKILL_CREATE_ACCENTS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => patchDraft({ color })}
                className={cn(
                  "h-7 w-7 rounded-md border",
                  draft.color === color ? "border-foreground" : "border-border",
                )}
                style={{ backgroundColor: color }}
                aria-label={t("skills.SkillStudio.useColor", { color })}
              />
            ))}
            <Input
              aria-label={t("skills.SkillStudio.hexColor")}
              value={draft.color}
              onChange={(event) => patchDraft({ color: event.target.value })}
              className="h-7 w-28 font-mono text-xs"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="skill-categories">{t("skills.SkillStudio.categories")}</Label>
          <Input
            id="skill-categories"
            value={categoryDraft}
            onChange={(event) => setCategoryDraft(event.target.value)}
            placeholder={t("skills.SkillStudio.categoriesPlaceholder")}
          />
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">{t("skills.SkillStudio.sharing")}</h2>
          <p className="text-xs text-muted-foreground">{t("skills.SkillStudio.sharingHelp")}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {(["company", "private"] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              onClick={() => patchDraft({ sharingScope: scope })}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm",
                draft.sharingScope === scope ? "border-foreground bg-accent/50" : "border-border",
              )}
            >
              <span className="block font-medium">{scope === "company" ? t("skills.SkillStudio.organization") : t("skills.SkillStudio.privateScope")}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {scope === "company" ? t("skills.SkillStudio.organizationHelp") : t("skills.SkillStudio.privateHelp")}
              </span>
            </button>
          ))}
          <button
            type="button"
            disabled
            className="rounded-md border border-dashed border-border px-3 py-2 text-left text-sm text-muted-foreground"
          >
            <span className="block font-medium">{t("skills.SkillStudio.publicScope")}</span>
            <span className="mt-1 block text-xs">{t("skills.SkillStudio.comingLater")}</span>
          </button>
        </div>
      </section>

      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-foreground">{t("skills.SkillStudio.starterContent")}</summary>
        <Textarea
          value={draft.markdown}
          onChange={(event) => patchDraft({ markdown: event.target.value })}
          className="mt-3 min-h-(--sz-22rem) resize-y font-mono text-xs"
        />
      </details>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <Button variant="ghost" onClick={() => navigate("/skills/studio")} disabled={createSkill.isPending}>
          {t("common.cancel")}
        </Button>
        <Button onClick={() => createSkill.mutate()} disabled={createSkill.isPending || !nameValid}>
          <FilePlus className="h-4 w-4" />
          {createSkill.isPending ? t("skills.SkillStudio.creating") : draft.forkedFromSkillId ? t("skills.SkillStudio.createFork") : t("skills.SkillStudio.createSkill")}
        </Button>
      </div>
    </div>
  );
}

function StudioMessage({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-(--sz-60vh) items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function StudioEmptyState({
  skills,
  skillsLoading,
  onSelectSkill,
  onCreateNew,
}: {
  skills: CompanySkillListItem[];
  skillsLoading: boolean;
  onSelectSkill: (skillId: string) => void;
  onCreateNew: () => void;
}) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-3 py-2">
          <SkillSwitcher
            skill={null}
            skills={skills}
            loading={skillsLoading}
            onSelectSkill={onSelectSkill}
            emptyLabel={t("skills.SkillStudio.selectSkill")}
          />
        </header>
        <SkillsPageNavigation activeView="authored" />
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={FileCode}
            message={skillsLoading ? t("skills.SkillStudio.loadingSkills") : t("skills.SkillStudio.selectSkillPrompt")}
            action={t("skills.SkillStudio.createNewSkill")}
            onAction={onCreateNew}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Landing — recently visited + recently updated (PAP-13150)
// ---------------------------------------------------------------------------

function StudioLanding({
  companyId,
  skills,
  skillsLoading,
  onSelectSkill,
  onCreateNew,
}: {
  companyId: string;
  skills: CompanySkillListItem[];
  skillsLoading: boolean;
  onSelectSkill: (skillId: string) => void;
  onCreateNew: () => void;
}) {
  const { t } = useTranslation();
  // Recency-sorted list, enriched with the last human editor (PAP-13149) — the
  // source for both landing sections. Kept separate from the alphabetical
  // switcher list so each cache stays sorted the way its consumer expects.
  const recentQuery = useQuery({
    queryKey: queryKeys.companySkills.listRecent(companyId),
    queryFn: () => companySkillsApi.list(companyId, { sort: "recent", include: ["lastEditor"] }),
    enabled: Boolean(companyId),
  });
  const recentSkills = recentQuery.data ?? [];

  const visited = useMemo(
    () => orderRecentlyVisitedSkills(recentSkills, getRecentStudioSkillIds()),
    [recentSkills],
  );
  const updated = useMemo(
    () => orderRecentlyUpdatedSkills(recentSkills, visited.map((skill) => skill.id)),
    [recentSkills, visited],
  );

  // No skills at all (or still loading) -> today's empty/loading fallback.
  if (recentSkills.length === 0) {
    return (
      <StudioEmptyState
        skills={skills}
        skillsLoading={skillsLoading || recentQuery.isLoading}
        onSelectSkill={onSelectSkill}
        onCreateNew={onCreateNew}
      />
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-3 py-2">
          <SkillSwitcher
            skill={null}
            skills={skills}
            loading={skillsLoading}
            onSelectSkill={onSelectSkill}
            emptyLabel={t("skills.SkillStudio.selectSkill")}
          />
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onCreateNew}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t("skills.SkillStudio.newSkill")}
          </Button>
        </header>
        <SkillsPageNavigation activeView="authored" />
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8">
            {visited.length > 0 ? (
              <StudioLandingSection
                title={t('skills.studio.recentlyVisited', { defaultValue: 'Recently visited' })}
                skills={visited}
                onSelectSkill={onSelectSkill}
              />
            ) : null}
            <StudioLandingSection
              title={t('skills.studio.recentlyUpdated', { defaultValue: 'Recently updated' })}
              skills={updated}
              onSelectSkill={onSelectSkill}
            />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function StudioLandingSection({
  title,
  skills,
  onSelectSkill,
}: {
  title: string;
  skills: CompanySkillListItem[];
  onSelectSkill: (skillId: string) => void;
}) {
  if (skills.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {skills.map((skill) => (
          <StudioLandingRow
            key={skill.id}
            skill={skill}
            onSelect={() => onSelectSkill(skill.id)}
          />
        ))}
      </div>
    </section>
  );
}

function StudioLandingRow({
  skill,
  onSelect,
}: {
  skill: CompanySkillListItem;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const editor = skillEditorAvatar(skill.lastEditor);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent"
    >
      <SkillLandingIcon skill={skill} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{skill.name}</span>
        {skill.tagline ? (
          <span className="truncate text-xs text-muted-foreground">{skill.tagline}</span>
        ) : null}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {t("skills.SkillStudio.updatedAgo", { time: relativeTime(skill.updatedAt) })}
      </span>
      {editor ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Avatar size="xs">
              {editor.imageUrl ? <AvatarImage src={editor.imageUrl} alt="" /> : null}
              <AvatarFallback>{editor.initials}</AvatarFallback>
            </Avatar>
          </TooltipTrigger>
          <TooltipContent>{editor.name}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="w-5 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

function SkillLandingIcon({ skill }: { skill: CompanySkillListItem }) {
  if (skill.iconUrl) {
    return (
      <img
        src={skill.iconUrl}
        alt=""
        className="h-9 w-9 shrink-0 rounded-md object-cover"
      />
    );
  }
  const accent = skillAccentColor(skill.key, skill.color);
  const letter = (skill.slug || skill.name || "?").trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-semibold text-white"
      style={{ backgroundColor: accent }}
    >
      {letter}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shell — header + three panes (or mobile tabs)
// ---------------------------------------------------------------------------

function StudioShell({
  companyId,
  skill,
  skills,
  skillsLoading,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  skills: CompanySkillListItem[];
  skillsLoading: boolean;
}) {
  const skillId = skill.id;
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // --- selection / cross-pane state ---
  const [selectedInputId, setSelectedInputId] = useState<string | null>(
    () => searchParams.get("input"),
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    () => searchParams.get("run"),
  );
  const [adHocMode, setAdHocMode] = useState(false);
  const [adHocContent, setAdHocContent] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [skillDirty, setSkillDirty] = useState(false);
  const [versionSheetOpen, setVersionSheetOpen] = useState(false);
  const [forkDialogOpen, setForkDialogOpen] = useState(false);

  const layoutRef = useRef<PaneLayout>(loadPaneLayout());

  // Keep deep-link params in sync (?input, ?run).
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (selectedInputId) next.set("input", selectedInputId);
    else next.delete("input");
    if (selectedRunId) next.set("run", selectedRunId);
    else next.delete("run");
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInputId, selectedRunId]);

  const inputsQuery = useQuery({
    queryKey: queryKeys.companySkills.testInputs(companyId, skillId),
    queryFn: () => companySkillsApi.testInputs(companyId, skillId),
    enabled: Boolean(companyId && skillId),
  });

  const persistLayout = useCallback((layout: Record<string, number>) => {
    const next: PaneLayout = {
      skill: layout.skill ?? layoutRef.current.skill,
      input: layout.input ?? layoutRef.current.input,
      runs: layout.runs ?? layoutRef.current.runs,
    };
    layoutRef.current = next;
    try {
      localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage may be unavailable (private mode) — non-fatal */
    }
  }, []);

  const inputs = inputsQuery.data ?? [];
  const selectedInput = inputs.find((i) => i.id === selectedInputId) ?? null;

  const leftPane = (
    <SkillPane
      companyId={companyId}
      skill={skill}
      onDirtyChange={setSkillDirty}
      onEditACopy={() => setForkDialogOpen(true)}
    />
  );
  const projectScan = isProjectScanSkill(skill.metadata);
  const middlePane = (
    <InputPane
      companyId={companyId}
      skillId={skillId}
      inputs={inputs}
      loading={inputsQuery.isLoading}
      selectedInputId={selectedInputId}
      adHocMode={adHocMode}
      adHocContent={adHocContent}
      onAdHocChange={setAdHocContent}
      onSelectInput={(id) => {
        setSelectedInputId(id);
        setAdHocMode(false);
      }}
      onSelectAdHoc={() => {
        setAdHocContent("");
        setAdHocMode(true);
        setSelectedInputId(null);
      }}
    />
  );
  const rightPane = (
    <RunsPane
      companyId={companyId}
      skill={skill}
      inputs={inputs}
      selectedInput={selectedInput}
      adHocMode={adHocMode}
      adHocContent={adHocContent}
      selectedRunId={selectedRunId}
      onSelectRun={setSelectedRunId}
      selectedAgentId={selectedAgentId}
      onSelectAgent={setSelectedAgentId}
      skillDirty={skillDirty}
      filterInput={selectedInput}
      onClearFilter={() => setSelectedInputId(null)}
    />
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <StudioHeader
          companyId={companyId}
          skill={skill}
          skillDirty={skillDirty}
          skills={skills}
          skillsLoading={skillsLoading}
          onSelectSkill={(nextSkillId) => navigate(skillStudioRoute(nextSkillId))}
          onOpenVersions={() => setVersionSheetOpen(true)}
        />
        <SkillsPageNavigation activeView="authored" />
        {projectScan ? (
          <ProjectScanNotice skill={skill} onEditACopy={() => setForkDialogOpen(true)} />
        ) : null}
        {isMobile ? (
          <MobileTabs skill={leftPane} input={middlePane} runs={rightPane} />
        ) : (
          <ResizablePanelGroup
            className="flex-1 min-h-0"
            defaultLayout={{
              skill: layoutRef.current.skill,
              input: layoutRef.current.input,
              runs: layoutRef.current.runs,
            }}
            onLayoutChanged={persistLayout}
          >
            <ResizablePanel id="skill" minSize="280px" className="border-r border-border">
              {leftPane}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              id="input"
              minSize="240px"
              collapsible
              collapsedSize="40px"
              className="border-r border-border"
            >
              {middlePane}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="runs" minSize="360px">
              {rightPane}
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
      <VersionHistorySheet
        open={versionSheetOpen}
        onOpenChange={setVersionSheetOpen}
        companyId={companyId}
        skill={skill}
        onRestored={() => {
          setSkillDirty(false);
          queryClient.invalidateQueries({
            queryKey: queryKeys.companySkills.detail(companyId, skillId),
          });
        }}
        onFilterRuns={(inputId) => setSelectedInputId(inputId)}
      />
      <ForkSkillDialog
        companyId={companyId}
        skill={skill}
        open={forkDialogOpen}
        onOpenChange={setForkDialogOpen}
      />
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function StudioHeader({
  companyId,
  skill,
  skillDirty,
  skills,
  skillsLoading,
  onSelectSkill,
  onOpenVersions,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  skillDirty: boolean;
  skills: CompanySkillListItem[];
  skillsLoading: boolean;
  onSelectSkill: (skillId: string) => void;
  onOpenVersions: () => void;
}) {
  const { t } = useTranslation();
  const version = skill.currentVersion?.revisionNumber ?? null;
  const toast = useOptionalToastActions();
  const copyShareLink = useCallback(() => {
    const href = typeof window !== "undefined" ? window.location.href : "";
    void copyTextToClipboard(href)
      .then(() => toast?.pushToast({ tone: "success", title: t("skills.SkillStudio.linkCopied"), body: t("skills.SkillStudio.studioLinkCopied") }))
      .catch((error) => toast?.pushToast({
        tone: "error",
        title: t("skills.SkillStudio.copyFailed"),
        body: error instanceof Error ? error.message : t("skills.SkillStudio.couldNotCopyLink"),
      }));
  }, [toast, t]);

  return (
    <header className="flex items-center gap-3 border-b border-border px-3 py-2">
      <SkillSwitcher
        skill={skill}
        skills={skills}
        loading={skillsLoading}
        onSelectSkill={onSelectSkill}
      />
      {version !== null && (
        <span className="font-mono text-xs text-muted-foreground">v{version}</span>
      )}
      {skillDirty ? (
        <Badge variant="secondary">{t("skills.SkillStudio.unsavedEdits")}</Badge>
      ) : null}
      {!skill.editable ? (
        <Badge variant="secondary">{t("skills.SkillStudio.readOnly")}</Badge>
      ) : null}
      {skill.forkedFromSkillId ? (
        <SkillLineageChip
          companyId={companyId}
          forkedFromSkillId={skill.forkedFromSkillId}
        />
      ) : null}
      <AgentsUsingSkillBadge companyId={companyId} skill={skill} />
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onOpenVersions}>
          <History className="mr-1.5 h-3.5 w-3.5" />
          {t("skills.SkillStudio.versionHistory")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t("skills.SkillStudio.studioMenu")}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={copyShareLink}>
              <Share2 className="mr-2 h-4 w-4" /> {t("skills.SkillStudio.shareLink")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

type SkillSwitcherOption = SearchableSelectOption<string> & {
  skill: CompanySkillListItem | CompanySkillDetail;
};

function SkillSwitcher({
  skill,
  skills,
  loading,
  onSelectSkill,
  emptyLabel,
}: {
  skill: CompanySkillDetail | null;
  skills: CompanySkillListItem[];
  loading: boolean;
  onSelectSkill: (skillId: string) => void;
  emptyLabel?: string;
}) {
  const { t } = useTranslation();
  const emptyText = emptyLabel ?? t("skills.SkillStudio.selectSkill");
  const groups = useMemo<readonly SearchableSelectGroup<string, SkillSwitcherOption>[]>(() => {
    const options: SkillSwitcherOption[] = withCurrentSkill(skills, skill).map((item) => ({
      key: item.id,
      value: item.id,
      label: item.name,
      title: item.name,
      searchText: [item.name, item.slug, item.key, item.description ?? ""].join(" "),
      skill: item,
    }));
    return [{ id: "skills", options }];
  }, [skill, skills]);

  return (
    <SearchableSelect<string, SkillSwitcherOption>
      value={skill?.id ?? ""}
      groups={groups}
      loading={loading}
      loadingMessage={t("skills.SkillStudio.loadingSkills")}
      placeholder={emptyText}
      searchPlaceholder={t("skills.SkillStudio.searchSkills")}
      emptyMessage={t("skills.SkillStudio.noMatchingSkills")}
      onValueChange={(value) => {
        if (value !== skill?.id) onSelectSkill(value);
      }}
      triggerClassName="h-8 w-64 border-0 bg-transparent px-0 text-base font-semibold shadow-none hover:bg-accent md:w-80"
      contentClassName="w-80"
      contentWidth="auto"
      renderValue={(option) => option?.label ?? skill?.name ?? emptyText}
      renderOption={(option, { selected }) => (
        <span className="flex min-w-0 flex-col">
          <span className={cn("truncate", selected && "font-medium")}>{option.label}</span>
          <span className="truncate text-(length:--text-micro) text-muted-foreground">
            {option.skill.slug}
          </span>
        </span>
      )}
    />
  );
}

function withCurrentSkill(
  skills: CompanySkillListItem[],
  skill: CompanySkillDetail | null,
): Array<CompanySkillListItem | CompanySkillDetail> {
  if (!skill) return skills;
  return skills.some((candidate) => candidate.id === skill.id) ? skills : [skill, ...skills];
}

// ---------------------------------------------------------------------------
// Left — Skill files + editor
// ---------------------------------------------------------------------------

function SkillPane({
  companyId,
  skill,
  onDirtyChange,
  onEditACopy,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  onDirtyChange: (dirty: boolean) => void;
  onEditACopy: () => void;
}) {
  const { t } = useTranslation();
  const skillId = skill.id;
  const queryClient = useQueryClient();
  const onError = useMutationErrorToast();
  const paths = useMemo(
    () => skill.fileInventory.map((f) => f.path),
    [skill.fileInventory],
  );
  const [selectedFile, setSelectedFile] = useState<string>(
    () => paths.find((p) => /skill\.md$/i.test(p)) ?? paths[0] ?? "SKILL.md",
  );
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<string>("");
  const [savedContent, setSavedContent] = useState<string>("");
  const [versionConflict, setVersionConflict] = useState(false);
  const [createDialog, setCreateDialog] = useState<"file" | "folder" | null>(null);
  const [deleteFolderOpen, setDeleteFolderOpen] = useState(false);
  // Gate rich-editor onChange until the user actually interacts with the body.
  // MDXEditor can emit a normalizing onChange on mount, which would otherwise
  // dirty the file on open and break the byte-identity guarantee (PAP-13156).
  const bodyInteractedRef = useRef(false);
  const markBodyInteracted = useCallback(() => {
    bodyInteractedRef.current = true;
  }, []);

  const nodes: FileTreeNode[] = useMemo(
    () => buildFileTree(Object.fromEntries(paths.map((p) => [p, ""]))),
    [paths],
  );

  const [baseVersionId, setBaseVersionId] = useState<string | null | undefined>();
  const draftFileRef = useRef<string | null>(null);
  const currentDraftRef = useRef({ skillId, selectedFile, draft });
  currentDraftRef.current = { skillId, selectedFile, draft };
  const fileQuery = useQuery({
    queryKey: queryKeys.companySkills.file(companyId, skillId, selectedFile),
    queryFn: () => companySkillsApi.file(companyId, skillId, selectedFile),
    enabled: Boolean(companyId && skillId && selectedFile),
  });

  useEffect(() => {
    if (fileQuery.data) {
      if (draftFileRef.current === selectedFile && draft !== savedContent) return;
      draftFileRef.current = selectedFile;
      setBaseVersionId(fileQuery.data.versionId);
      setVersionConflict(false);
      bodyInteractedRef.current = false;
      setDraft(fileQuery.data.content);
      setSavedContent(fileQuery.data.content);
    }
  }, [fileQuery.data]);

  const dirty = draft !== savedContent;
  const currentFolder = parentFolder(selectedFile);
  const pathSet = useMemo(() => new Set(paths), [paths]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const selectFile = useCallback((path: string) => {
    if (path === selectedFile) return;
    if (
      dirty
      && typeof window !== "undefined"
      && !window.confirm(t("skills.SkillStudio.discardSwitchFiles"))
    ) {
      return;
    }
    setSelectedFile(path);
  }, [dirty, selectedFile]);

  const saveMutation = useMutation({
    mutationFn: ({ path, content, versionId }: { path: string; content: string; versionId: string | null | undefined }) =>
      companySkillsApi.updateFile(companyId, skillId, path, content, { expectedVersionId: versionId }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.companySkills.file(companyId, skillId, updated.path), updated);
      if (draftFileRef.current === updated.path) {
        setBaseVersionId(updated.versionId);
        setSavedContent(updated.content);
        setVersionConflict(false);
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.detail(companyId, skillId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.versions(companyId, skillId),
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setVersionConflict(true);
      onError(t("skills.SkillStudio.couldntSaveFile"))(error);
    },
  });

  async function loadLatestSavedFile() {
    if (dirty && !window.confirm(t("skills.SkillStudio.discardLoadLatest"))) return;
    const result = await fileQuery.refetch();
    if (result.error) { onError(t("skills.SkillStudio.couldntLoadLatestFile"))(result.error); return; }
    if (!result.data) return;
    // Discard confirmation covers only the draft that started this request.
    const current = currentDraftRef.current;
    if (current.skillId !== skillId || current.selectedFile !== selectedFile || current.draft !== draft) return;
    draftFileRef.current = selectedFile;
    setDraft(result.data.content);
    setSavedContent(result.data.content);
    setBaseVersionId(result.data.versionId);
    setVersionConflict(false);
  }

  const createMutation = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      companySkillsApi.updateFile(companyId, skillId, path, content, { expectedVersionId: baseVersionId ?? skill.currentVersionId }),
    onSuccess: (created) => {
      setBaseVersionId(created.versionId);
      queryClient.setQueryData(queryKeys.companySkills.file(companyId, skillId, created.path), created);
      setSelectedFile(created.path);
      setDraft(created.content);
      setSavedContent(created.content);
      setCreateDialog(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.detail(companyId, skillId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.versions(companyId, skillId),
      });
    },
    onError: onError(t("skills.SkillStudio.couldntCreateFile")),
  });

  const deleteMutation = useMutation({
    mutationFn: (input: { path: string; target: "file" | "folder" }) =>
      companySkillsApi.deleteFile(companyId, skillId, { ...input, expectedVersionId: baseVersionId ?? skill.currentVersionId }),
    onSuccess: (result) => {
      setBaseVersionId(result.versionId);
      queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.file(companyId, skillId, selectedFile) });
      const deleted = new Set(result.deletedPaths);
      const remaining = paths.filter((path) => !deleted.has(path));
      setSelectedFile(remaining.find((path) => /skill\.md$/i.test(path)) ?? remaining[0] ?? "SKILL.md");
      setDeleteFolderOpen(false);
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.detail(companyId, skillId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.versions(companyId, skillId),
      });
    },
    onError: onError(t("skills.SkillStudio.couldntDeleteFile")),
  });

  // Read-only skills (bundled Paperclip, remote GitHub, URL, skills.sh) reject
  // file writes server-side; reflect that up-front instead of letting the user
  // type into an editor whose Save silently 422s (PAP-13001 Bug B).
  const readOnly = skill.editable === false || fileQuery.data?.editable === false;

  if (paths.length === 0) {
    return (
      <PaneScaffold
        title={<SkillPaneTitle skillName={skill.name} folder="root" />}
        action={
          <SkillFileActions
            readOnly={readOnly}
            selectedFile={selectedFile}
            currentFolder=""
            canDeleteFile={false}
            pending={createMutation.isPending || deleteMutation.isPending || dirty}
            onAddFile={() => setCreateDialog("file")}
            onAddFolder={() => setCreateDialog("folder")}
            onDeleteFile={() => {}}
            onDeleteFolder={() => setDeleteFolderOpen(true)}
          />
        }
      >
        <EmptyState icon={FileCode} message={t("skills.SkillStudio.emptySkillFiles")} />
        <SkillPathDialog
          mode={createDialog}
          open={createDialog !== null}
          onOpenChange={(open) => {
            if (!open) setCreateDialog(null);
          }}
          currentFolder=""
          existingPaths={pathSet}
          pending={createMutation.isPending}
          onSubmit={(path, content) => createMutation.mutate({ path, content })}
        />
      </PaneScaffold>
    );
  }

  const isMarkdown = fileQuery.data?.markdown ?? /\.md$/i.test(selectedFile);
  const markdownBlock = isMarkdown ? splitFrontmatterBlock(draft) : null;

  return (
    <PaneScaffold
      title={<SkillPaneTitle skillName={skill.name} folder={currentFolder || "root"} />}
      action={
        <SkillFileActions
          readOnly={readOnly}
          selectedFile={selectedFile}
          currentFolder={currentFolder}
          canDeleteFile={selectedFile !== "SKILL.md"}
          pending={createMutation.isPending || deleteMutation.isPending || dirty}
          onAddFile={() => setCreateDialog("file")}
          onAddFolder={() => setCreateDialog("folder")}
          onDeleteFile={() => deleteMutation.mutate({ path: selectedFile, target: "file" })}
          onDeleteFolder={() => setDeleteFolderOpen(true)}
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {versionConflict ? (
          <div role="alert" className="flex items-center gap-2 border-b border-border bg-muted px-3 py-2 text-xs">
            <span>{t("skills.SkillStudio.staleVersion")}</span>
            <Button size="sm" variant="outline" disabled={fileQuery.isFetching} onClick={() => void loadLatestSavedFile()}>
              {t("skills.SkillStudio.loadLatestSavedFile")}
            </Button>
          </div>
        ) : null}
        {dirty && !readOnly ? (
          <div className="flex items-start gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span>{t("skills.SkillStudio.unsavedLiveOnly")}</span>
          </div>
        ) : null}
        <div className="max-h-(--sz-11_75rem) overflow-auto border-b border-border p-1">
          <FileTree
            nodes={nodes}
            selectedFile={selectedFile}
            expandedDirs={expandedDirs}
            onToggleDir={(path) =>
              setExpandedDirs((prev) => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
            onSelectFile={selectFile}
            showCheckboxes={false}
            ariaLabel={t("skills.SkillStudio.skillFilesAria")}
          />
        </div>
        <SkillSourceProvenance skill={skill} />
        {readOnly && (
          <div className="flex items-start gap-3 border-b border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p>
                {skill.metadata?.skillSourceId ? t("skills.SkillStudio.readOnlySynced") : skill.editableReason ?? t("skills.SkillStudio.readOnlyExternal")}
                {" "}{t("skills.SkillStudio.makeEditableCopy")}
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-2"
                onClick={onEditACopy}
              >
                <GitFork className="mr-1.5 h-3.5 w-3.5" />
                {t("skills.SkillStudio.makeCopy")}
              </Button>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 px-3 py-1.5">
          <span className="truncate font-mono text-xs text-muted-foreground">
            {selectedFile}
            {skill.currentVersion ? ` · v${skill.currentVersion.revisionNumber}` : ""}
          </span>
          <div className="flex items-center gap-2">
            {readOnly ? (
              <Badge variant="secondary">{t("skills.SkillStudio.readOnly")}</Badge>
            ) : (
              <>
                {dirty && <Badge variant="secondary">{t("skills.SkillStudio.unsavedBadge")}</Badge>}
                <Button
                  size="sm"
                  disabled={!dirty || saveMutation.isPending}
                  onClick={() => saveMutation.mutate({ path: selectedFile, content: draft, versionId: baseVersionId })}
                >
                  {saveMutation.isPending ? t("skills.SkillStudio.savingEllipsis") : t("common.save")}
                </Button>
              </>
            )}
          </div>
        </div>
        {isMarkdown && markdownBlock?.hasFrontmatter ? (
          <FrontmatterPanel
            key={`fm:${selectedFile}`}
            frontmatterText={markdownBlock.frontmatterText}
            hasFrontmatter={markdownBlock.hasFrontmatter}
            fileName={selectedFile}
            skillSlug={skill.slug}
            readOnly={readOnly}
            onChange={(change) => {
              setDraft((prev) =>
                joinFrontmatterBlock({
                  frontmatterText: change.frontmatterText,
                  body: splitFrontmatterBlock(prev).body,
                  hasFrontmatter: change.hasFrontmatter,
                }),
              );
            }}
          />
        ) : null}
        <div
          className="min-h-0 flex-1 overflow-auto px-3 pb-3"
          onBeforeInputCapture={markBodyInteracted}
          onDropCapture={markBodyInteracted}
          onInput={markBodyInteracted}
          onKeyDownCapture={markBodyInteracted}
          onPasteCapture={markBodyInteracted}
          onPointerDownCapture={markBodyInteracted}
        >
          {fileQuery.data?.encoding === "base64" ? <SkillBinaryFile file={fileQuery.data} /> : isMarkdown && markdownBlock ? (
            <MarkdownEditor
              key={`body:${selectedFile}`}
              value={markdownBlock.body}
              onChange={(nextBody) => {
                // Ignore MDXEditor's on-mount normalization; only apply real edits.
                if (!bodyInteractedRef.current) return;
                setDraft((prev) => {
                  const block = splitFrontmatterBlock(prev);
                  return joinFrontmatterBlock({ ...block, body: nextBody });
                });
              }}
              bordered={false}
              readOnly={readOnly}
              className="min-h-(--sz-320px)"
            />
          ) : (
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              readOnly={readOnly}
              className="min-h-(--sz-320px) font-mono text-xs"
              spellCheck={false}
            />
          )}
        </div>
      </div>
      <SkillPathDialog
        mode={createDialog}
        open={createDialog !== null}
        onOpenChange={(open) => {
          if (!open) setCreateDialog(null);
        }}
        currentFolder={currentFolder}
        existingPaths={pathSet}
        pending={createMutation.isPending}
        onSubmit={(path, content) => createMutation.mutate({ path, content })}
      />
      <DeleteFolderDialog
        open={deleteFolderOpen}
        onOpenChange={setDeleteFolderOpen}
        currentFolder={currentFolder}
        existingPaths={pathSet}
        pending={deleteMutation.isPending}
        onSubmit={(path) => deleteMutation.mutate({ path, target: "folder" })}
      />
    </PaneScaffold>
  );
}

function parentFolder(filePath: string) {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function normalizeStudioPath(value: string) {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join("/");
}

function folderSeedFile(folderPath: string) {
  return `${folderPath}/README.md`;
}

function folderSeedContent(folderPath: string) {
  const label = folderPath.split("/").filter(Boolean).at(-1) ?? "Folder";
  return `# ${label}\n`;
}

function SkillPaneTitle({ skillName, folder }: { skillName: string; folder: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{skillName}</span>
      <ChevronRight className="h-3 w-3 shrink-0" />
      <span className="truncate font-mono normal-case tracking-normal">{folder}</span>
    </span>
  );
}

function SkillFileActions({
  readOnly,
  selectedFile,
  canDeleteFile,
  pending,
  onAddFile,
  onAddFolder,
  onDeleteFile,
  onDeleteFolder,
}: {
  readOnly: boolean;
  selectedFile: string;
  currentFolder: string;
  canDeleteFile: boolean;
  pending: boolean;
  onAddFile: () => void;
  onAddFolder: () => void;
  onDeleteFile: () => void;
  onDeleteFolder: () => void;
}) {
  const { t } = useTranslation();
  const disabled = readOnly || pending;
  const deleteDisabled = disabled || !canDeleteFile;
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={onAddFile} aria-label={t("skills.SkillStudio.addFile")}>
              <FilePlus className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("skills.SkillStudio.addFile")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={onAddFolder} aria-label={t("skills.SkillStudio.addFolder")}>
              <FolderPlus className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("skills.SkillStudio.addFolder")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={deleteDisabled}
              onClick={() => {
                if (typeof window === "undefined" || window.confirm(t("skills.SkillStudio.deleteFileConfirm", { file: selectedFile }))) {
                  onDeleteFile();
                }
              }}
              aria-label={t("skills.SkillStudio.deleteFile")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{canDeleteFile ? t("skills.SkillStudio.deleteFile") : t("skills.SkillStudio.skillMdCannotDelete")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={onDeleteFolder} aria-label={t("skills.SkillStudio.deleteFolder")}>
              <FolderMinus className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("skills.SkillStudio.deleteFolder")}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function SkillPathDialog({
  mode,
  open,
  onOpenChange,
  currentFolder,
  existingPaths,
  pending,
  onSubmit,
}: {
  mode: "file" | "folder" | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentFolder: string;
  existingPaths: Set<string>;
  pending: boolean;
  onSubmit: (path: string, content: string) => void;
}) {
  const { t } = useTranslation();
  const [pathValue, setPathValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !mode) return;
    setPathValue(mode === "folder"
      ? normalizeStudioPath(currentFolder ? `${currentFolder}/new-folder` : "new-folder")
      : normalizeStudioPath(currentFolder ? `${currentFolder}/new-file.md` : "notes.md"));
    setError(null);
  }, [currentFolder, mode, open]);

  const title = mode === "folder" ? t("skills.SkillStudio.addFolder") : t("skills.SkillStudio.addFile");
  const label = mode === "folder" ? t("skills.SkillStudio.folderPath") : t("skills.SkillStudio.filePath");

  function submit() {
    if (!mode) return;
    const normalized = normalizeStudioPath(pathValue);
    if (!normalized) {
      setError(t("skills.SkillStudio.pathRequired", { label }));
      return;
    }
    if (mode === "file") {
      if (existingPaths.has(normalized)) {
        setError(t("skills.SkillStudio.fileExists"));
        return;
      }
      onSubmit(normalized, "");
      return;
    }

    const folderPath = normalized.replace(/\/+$/, "");
    if ([...existingPaths].some((path) => path.startsWith(`${folderPath}/`))) {
      setError(t("skills.SkillStudio.folderExists"));
      return;
    }
    onSubmit(folderSeedFile(folderPath), folderSeedContent(folderPath));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("skills.SkillStudio.saveNewVersionDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="skill-path-input">{label}</Label>
          <Input
            id="skill-path-input"
            value={pathValue}
            onChange={(event) => {
              setPathValue(event.target.value);
              setError(null);
            }}
            placeholder={mode === "folder" ? "references/examples" : "references/examples.md"}
          />
          {mode === "folder" ? (
            <p className="text-xs text-muted-foreground">{t("skills.SkillStudio.folderSeedHint")}</p>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={pending} onClick={submit}>
            {t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteFolderDialog({
  open,
  onOpenChange,
  currentFolder,
  existingPaths,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentFolder: string;
  existingPaths: Set<string>;
  pending: boolean;
  onSubmit: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [pathValue, setPathValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPathValue(currentFolder);
    setError(null);
  }, [currentFolder, open]);

  function submit() {
    const normalized = normalizeStudioPath(pathValue).replace(/\/+$/, "");
    if (!normalized) {
      setError(t("skills.SkillStudio.folderPathRequired"));
      return;
    }
    const matchingFiles = [...existingPaths].filter((path) => path.startsWith(`${normalized}/`));
    if (matchingFiles.length === 0) {
      setError(t("skills.SkillStudio.noFilesInFolder"));
      return;
    }
    if (matchingFiles.includes("SKILL.md")) {
      setError(t("skills.SkillStudio.skillMdCannotDeleteError"));
      return;
    }
    onSubmit(normalized);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("skills.SkillStudio.deleteFolder")}</DialogTitle>
          <DialogDescription>
            {t("skills.SkillStudio.deleteFolderDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="skill-folder-delete">{t("skills.SkillStudio.folderPath")}</Label>
          <Input
            id="skill-folder-delete"
            value={pathValue}
            onChange={(event) => {
              setPathValue(event.target.value);
              setError(null);
            }}
            placeholder="references/examples"
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={submit}>
            {t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Middle — Inputs (path-foldered) + editor + save-as-input
// ---------------------------------------------------------------------------

function InputPane({
  companyId,
  skillId,
  inputs,
  loading,
  selectedInputId,
  adHocMode,
  adHocContent,
  onAdHocChange,
  onSelectInput,
  onSelectAdHoc,
}: {
  companyId: string;
  skillId: string;
  inputs: CompanySkillTestInput[];
  loading: boolean;
  selectedInputId: string | null;
  adHocMode: boolean;
  adHocContent: string;
  onAdHocChange: (value: string) => void;
  onSelectInput: (id: string) => void;
  onSelectAdHoc: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const onError = useMutationErrorToast();
  // The row's menu closes on click, so its copy confirmation goes to a toast.
  const copyWithToast = useCopyToast();
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [savedInputDraft, setSavedInputDraft] = useState<SavedInputDraftState>(
    EMPTY_SAVED_INPUT_DRAFT_STATE,
  );
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const selectedInput = inputs.find((i) => i.id === selectedInputId) ?? null;

  // In ad-hoc mode the editor is controlled by the shared shell state; otherwise
  // it edits a local copy of the selected saved input.
  const savedDraft = selectedSavedInputDraft(savedInputDraft, selectedInput);
  const draft = adHocMode ? adHocContent : savedDraft;
  const setDraft = adHocMode
    ? onAdHocChange
    : (value: string) => {
        setSavedInputDraft((previous) => ({
          inputId: selectedInput?.id ?? previous.inputId,
          draft: value,
          baselineContent: selectedInput?.content ?? previous.baselineContent,
        }));
      };

  useEffect(() => {
    if (adHocMode) return;
    setSavedInputDraft((previous) => syncSavedInputDraftState(previous, selectedInput));
  }, [adHocMode, selectedInput?.content, selectedInput?.id]);

  useEffect(() => {
    if (!loading && inputs.length === 0 && !adHocMode && !selectedInputId) {
      onSelectAdHoc();
    }
  }, [adHocMode, inputs.length, loading, onSelectAdHoc, selectedInputId]);

  const nameToId = useMemo(
    () => new Map(inputs.map((i) => [i.name, i.id])),
    [inputs],
  );
  const nodes: FileTreeNode[] = useMemo(
    () => buildFileTree(Object.fromEntries(inputs.map((i) => [i.name, i.content]))),
    [inputs],
  );
  const selectedName = selectedInput?.name ?? null;
  const dirty = !adHocMode && savedInputDraftDirty(savedInputDraft, selectedInput);
  const canSaveSelectedInput = Boolean(selectedInput && dirty && draft.trim());

  const confirmDiscardDirtyInput = useCallback(() => {
    if (!dirty) return true;
    return (
      typeof window === "undefined"
      || window.confirm(t("skills.SkillStudio.discardUnsavedInput"))
    );
  }, [dirty]);

  const selectSavedInput = useCallback((id: string) => {
    if (!adHocMode && id === selectedInputId) return;
    if (!confirmDiscardDirtyInput()) return;
    onSelectInput(id);
  }, [adHocMode, confirmDiscardDirtyInput, onSelectInput, selectedInputId]);

  const selectAdHocInput = useCallback(() => {
    if (!adHocMode && !confirmDiscardDirtyInput()) return;
    onSelectAdHoc();
  }, [adHocMode, confirmDiscardDirtyInput, onSelectAdHoc]);

  const updateMutation = useMutation({
    mutationFn: (payload: { content: string }) =>
      companySkillsApi.updateTestInput(companyId, skillId, selectedInput!.id, payload),
    onSuccess: (updated) => {
      setSavedInputDraft({
        inputId: updated.id,
        draft: updated.content,
        baselineContent: updated.content,
      });
      queryClient.setQueryData<CompanySkillTestInput[]>(
        queryKeys.companySkills.testInputs(companyId, skillId),
        (current) => current?.map((input) => input.id === updated.id ? updated : input),
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testInputs(companyId, skillId),
      });
    },
    onError: onError(t("skills.SkillStudio.couldntSaveInput")),
  });
  const deleteMutation = useMutation({
    mutationFn: (inputId: string) => companySkillsApi.deleteTestInput(companyId, skillId, inputId),
    onSuccess: (deleted) => {
      if (deleted.id === selectedInputId) {
        onSelectAdHoc();
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testInputs(companyId, skillId),
      });
    },
    onError: onError(t("skills.SkillStudio.couldntDeleteInput")),
  });

  return (
    <PaneScaffold
      title={
        <span className="flex min-w-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={collapsed ? t("skills.SkillStudio.expandInput") : t("skills.SkillStudio.collapseInput")}
                onClick={() => setCollapsed((current) => !current)}
              >
                {collapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{collapsed ? t("skills.SkillStudio.expandInput") : t("skills.SkillStudio.collapseInput")}</TooltipContent>
          </Tooltip>
          <span>{t("skills.SkillStudio.inputTitle")}</span>
        </span>
      }
      action={
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={selectAdHocInput} aria-label={t("skills.SkillStudio.newInput")}>
                <Plus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("skills.SkillStudio.newInput")}</TooltipContent>
          </Tooltip>
        </div>
      }
    >
      {collapsed ? (
        <button
          type="button"
          className="flex min-h-(--sz-32px) items-center gap-2 border-b border-border px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setCollapsed(false)}
        >
          <ChevronRight className="h-3.5 w-3.5" />
          <span>{t("skills.SkillStudio.inputFolded")}</span>
        </button>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {loading || inputs.length > 0 ? (
            <div className="max-h-(--sz-11_75rem) overflow-auto border-b border-border p-1">
              {loading ? (
                <div className="p-3 text-xs text-muted-foreground">{t("skills.SkillStudio.loadingInputs")}</div>
              ) : (
                <>
                  {adHocMode && (
                    <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sm italic text-muted-foreground">
                      <FilePlus className="h-3.5 w-3.5" /> {t("skills.SkillStudio.newInputNotSaved")}
                    </div>
                  )}
                  <FileTree
                    nodes={nodes}
                    selectedFile={selectedName}
                    expandedDirs={expandedDirs}
                    onToggleDir={(path) =>
                      setExpandedDirs((prev) => {
                        const next = new Set(prev);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      })
                    }
                    onSelectFile={(name) => {
                      const id = nameToId.get(name);
                      if (id) selectSavedInput(id);
                    }}
                    showCheckboxes={false}
                    renderFileExtra={(node) => {
                      const id = nameToId.get(node.path);
                      if (!id) return null;
                      return (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                              aria-label={t("skills.SkillStudio.inputActionsFor", { name: node.name })}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                              onClick={() => {
                                const input = inputs.find((i) => i.id === id);
                                if (input) void copyWithToast(input.content, t("skills.SkillStudio.inputContentCopied"));
                              }}
                            >
                              <Copy className="mr-2 h-4 w-4" /> {t("skills.SkillStudio.copyContent")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => deleteMutation.mutate(id)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> {t("common.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      );
                    }}
                    ariaLabel={t("skills.SkillStudio.testInputsAria")}
                  />
                </>
              )}
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("skills.SkillStudio.pasteInputPlaceholder")}
              aria-label={t("skills.SkillStudio.skillTestInputAria")}
              className="min-h-0 flex-1 resize-none border-0 bg-transparent px-3 py-3 text-sm leading-6 outline-none placeholder:text-muted-foreground focus-visible:ring-0"
            />
          </div>
          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <div className="mr-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">
                {selectedInput ? selectedInput.name : adHocMode ? t("skills.SkillStudio.newInput") : t("skills.SkillStudio.noInputSelected")}
              </span>
              {dirty ? <Badge variant="secondary">{t("skills.SkillStudio.unsavedBadge")}</Badge> : null}
            </div>
            {selectedInput && dirty ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={updateMutation.isPending}
                  onClick={() => setSavedInputDraft({
                    inputId: selectedInput.id,
                    draft: selectedInput.content,
                    baselineContent: selectedInput.content,
                  })}
                >
                  {t("skills.SkillStudio.revert")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canSaveSelectedInput || updateMutation.isPending}
                  onClick={() => updateMutation.mutate({ content: draft })}
                >
                  {updateMutation.isPending ? t("common.saving") : t("skills.SkillStudio.saveChanges")}
                </Button>
              </>
            ) : null}
            <Button
              size="sm"
              disabled={!draft.trim()}
              onClick={() => setSaveDialogOpen(true)}
            >
              {t("skills.SkillStudio.saveAsInput")}
            </Button>
          </div>
        </div>
      )}
      <SaveInputDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        companyId={companyId}
        skillId={skillId}
        initialContent={draft}
        onSaved={(input) => {
          setSaveDialogOpen(false);
          onSelectInput(input.id);
        }}
      />
    </PaneScaffold>
  );
}

function SaveInputDialog({
  open,
  onOpenChange,
  companyId,
  skillId,
  initialContent,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  skillId: string;
  initialContent: string;
  onSaved: (input: CompanySkillTestInput) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [content, setContent] = useState(initialContent);

  useEffect(() => {
    if (open) {
      setContent(initialContent);
      setName("");
    }
  }, [open, initialContent]);

  const createMutation = useMutation({
    mutationFn: () => companySkillsApi.createTestInput(companyId, skillId, { name: name.trim(), content }),
    onSuccess: (input) => {
      queryClient.setQueryData<CompanySkillTestInput[]>(
        queryKeys.companySkills.testInputs(companyId, skillId),
        (current) => {
          const withoutDuplicate = (current ?? []).filter((item) => item.id !== input.id);
          return [...withoutDuplicate, input].sort((a, b) =>
            a.name.localeCompare(b.name) || Number(new Date(a.createdAt)) - Number(new Date(b.createdAt)),
          );
        },
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testInputs(companyId, skillId),
      });
      onSaved(input);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("skills.SkillStudio.saveTestInput")}</DialogTitle>
          <DialogDescription>
            {t("skills.SkillStudio.saveTestInputDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="input-name">{t("common.name")}</Label>
            <Input
              id="input-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="onboarding/happy-path"
            />
            <p className="text-xs text-muted-foreground">{t("skills.SkillStudio.folderHint")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="input-content">{t("skills.SkillStudio.content")}</Label>
            <Textarea
              id="input-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-(--sz-160px)"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!name.trim() || !content.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Right — agent picker + Run + history + detail
// ---------------------------------------------------------------------------

type RunTemplateDialogState =
  | { mode: "create"; source?: CompanySkillTestRunTemplate | null }
  | { mode: "edit"; source: CompanySkillTestRunTemplate }
  | null;

function RunsPane({
  companyId,
  skill,
  inputs,
  selectedInput,
  adHocMode,
  adHocContent,
  selectedRunId,
  onSelectRun,
  selectedAgentId,
  onSelectAgent,
  skillDirty,
  filterInput,
  onClearFilter,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  inputs: CompanySkillTestInput[];
  selectedInput: CompanySkillTestInput | null;
  adHocMode: boolean;
  adHocContent: string;
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  skillDirty: boolean;
  filterInput: CompanySkillTestInput | null;
  onClearFilter: () => void;
}) {
  const { t } = useTranslation();
  const skillId = skill.id;
  const queryClient = useQueryClient();
  const onError = useMutationErrorToast();
  const toast = useOptionalToastActions();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<RunTemplateSelection>(
    () => loadRunTemplateSelection(companyId),
  );
  const [templateDialog, setTemplateDialog] = useState<RunTemplateDialogState>(null);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const agents = agentsQuery.data ?? [];
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

  useEffect(() => {
    setSelectedTemplateId(loadRunTemplateSelection(companyId));
  }, [companyId]);

  const updateTemplateSelection = useCallback((selection: RunTemplateSelection) => {
    setSelectedTemplateId(selection);
    persistRunTemplateSelection(companyId, selection);
  }, [companyId]);

  const templatesQuery = useQuery({
    queryKey: queryKeys.companySkills.testRunTemplates(companyId),
    queryFn: () => companySkillsApi.testRunTemplates(companyId),
    enabled: Boolean(companyId),
  });
  const templatesQueryView = useQueryView(templatesQuery);
  const templates = templatesQuery.data ?? EMPTY_RUN_TEMPLATES;

  useEffect(() => {
    if (!templatesQuery.isSuccess) return;
    const resolution = resolveRunTemplateSelection(selectedTemplateId, templates);
    if (!resolution.recovered) return;
    updateTemplateSelection(resolution.selection);
    toast?.pushToast({
      tone: "warn",
      title: t("skills.SkillStudio.templateResetTitle"),
      body: t("skills.SkillStudio.templateResetBody"),
      dedupeKey: `skill-studio-template-reset:${companyId}`,
    });
  }, [
    companyId,
    selectedTemplateId,
    templates,
    templatesQuery.isSuccess,
    toast,
    updateTemplateSelection,
  ]);

  const filterInputId = filterInput?.id ?? null;
  const runsQuery = useQuery({
    queryKey: queryKeys.companySkills.testRuns(companyId, skillId, filterInputId),
    queryFn: () =>
      companySkillsApi.testRuns(companyId, skillId, filterInputId ? { inputId: filterInputId } : {}),
    enabled: Boolean(companyId && skillId),
    refetchInterval: (query) => {
      const data = query.state.data as CompanySkillTestRun[] | undefined;
      return data?.some((r) => shouldPollRun(r.status)) ? POLL_MS : false;
    },
  });
  const runs = runsQuery.data ?? [];

  const hasInput = adHocMode ? adHocContent.trim().length > 0 : Boolean(selectedInput?.content.trim());
  const gate = evaluateRunGate({
    hasAgent: Boolean(selectedAgent),
    hasInput,
    skillFileCount: skill.fileInventory.length,
    hasUnsavedSkillEdits: skillDirty,
  });
  const templateGateReason = templatesQuery.isLoading
    ? t("skills.SkillStudio.loadingRunTemplates")
    : (templatesQueryView.kind === "error")
      ? t("skills.SkillStudio.runTemplatesCouldntLoad")
      : null;

  const createTemplateMutation = useMutation({
    mutationFn: (payload: CompanySkillTestRunTemplateCreateRequest) =>
      companySkillsApi.createTestRunTemplate(companyId, payload),
    onSuccess: (template) => {
      setTemplateDialog(null);
      updateTemplateSelection(template.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testRunTemplates(companyId),
      });
      toast?.pushToast({
        tone: "success",
        title: t("skills.SkillStudio.templateSaved"),
        body: t("skills.SkillStudio.templateReady", { name: template.name }),
      });
    },
    onError: onError(t("skills.SkillStudio.couldntSaveTemplate")),
  });

  const updateTemplateMutation = useMutation({
    mutationFn: ({ templateId, payload }: {
      templateId: string;
      payload: CompanySkillTestRunTemplateUpdateRequest;
    }) => companySkillsApi.updateTestRunTemplate(companyId, templateId, payload),
    onSuccess: (template) => {
      setTemplateDialog(null);
      updateTemplateSelection(template.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testRunTemplates(companyId),
      });
      toast?.pushToast({
        tone: "success",
        title: t("skills.SkillStudio.templateUpdated"),
        body: t("skills.SkillStudio.templateReady", { name: template.name }),
      });
    },
    onError: onError(t("skills.SkillStudio.couldntUpdateTemplate")),
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: (templateId: string) => companySkillsApi.deleteTestRunTemplate(companyId, templateId),
    onSuccess: (template) => {
      const fallback = resolveRunTemplateSelection(selectedTemplateId, templates.filter((entry) => entry.id !== template.id));
      if (selectedTemplateId === template.id || fallback.recovered) {
        updateTemplateSelection(fallback.selection);
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testRunTemplates(companyId),
      });
      toast?.pushToast({
        tone: "success",
        title: t("skills.SkillStudio.templateDeleted"),
        body: t("skills.SkillStudio.templateRemoved", { name: template.name }),
      });
    },
    onError: onError(t("skills.SkillStudio.couldntDeleteTemplate")),
  });

  const selectedTemplate = selectedTemplateId === null
    ? null
    : templates.find((template) => template.id === selectedTemplateId) ?? null;
  const selectedTemplateName = selectedTemplateId === null
    ? t("skills.SkillStudio.noTemplate")
    : selectedTemplate?.name ?? t("skills.SkillStudio.defaultTestTemplate");
  const runDisabledReason = gate.reason ?? templateGateReason;

  const createRunMutation = useMutation({
    mutationFn: () => {
      if (!templatesQuery.isSuccess) {
        throw new Error(templateGateReason ?? t("skills.SkillStudio.runTemplatesNotReady"));
      }
      const resolution = resolveRunTemplateSelection(selectedTemplateId, templates);
      if (resolution.recovered) {
        updateTemplateSelection(resolution.selection);
        throw new Error(t("skills.SkillStudio.selectedTemplateResetError"));
      }
      return companySkillsApi.createTestRun(companyId, skillId, buildCreateRunRequest({
        agentId: selectedAgentId!,
        inputId: adHocMode ? null : selectedInput?.id ?? null,
        content: adHocMode ? adHocContent : selectedInput ? null : adHocContent,
        templateId: resolution.selection,
      }));
    },
    onSuccess: (run) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testRuns(companyId, skillId, filterInputId),
      });
      onSelectRun(run.id);
    },
    onError: onError(t("skills.SkillStudio.couldntStartRun")),
  });

  if (selectedRunId) {
    return (
      <RunDetailView
        companyId={companyId}
        skill={skill}
        runId={selectedRunId}
        agents={agents}
        onBack={() => onSelectRun(null)}
        onSelectRun={onSelectRun}
      />
    );
  }

  return (
    <PaneScaffold
      title={t("skills.SkillStudio.testRuns")}
      action={
        <div className="flex items-center gap-2">
          <AgentPicker
            agents={agents}
            selectedAgent={selectedAgent}
            onSelect={onSelectAgent}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              {/* span wrapper keeps the tooltip reachable while the button is disabled */}
              <span>
                <Button
                  size="sm"
                  disabled={gate.disabled || Boolean(templateGateReason) || createRunMutation.isPending}
                  onClick={() => createRunMutation.mutate()}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" /> {t("skills.SkillStudio.runButton")}
                </Button>
              </span>
            </TooltipTrigger>
            {runDisabledReason && <TooltipContent side="bottom">{runDisabledReason}</TooltipContent>}
          </Tooltip>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <RunTemplateAdvancedPanel
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          templates={templates}
          templatesLoading={templatesQuery.isLoading}
          templatesError={(templatesQueryView.kind === "error")}
          selectedTemplateId={selectedTemplateId}
          selectedTemplate={selectedTemplate}
          selectedTemplateName={selectedTemplateName}
          onSelectTemplate={updateTemplateSelection}
          onCreateTemplate={() => setTemplateDialog({ mode: "create" })}
          onEditTemplate={(template) => setTemplateDialog({ mode: "edit", source: template })}
          onDuplicateTemplate={(template) => setTemplateDialog({ mode: "create", source: template })}
          onDeleteTemplate={(template) => {
            if (
              typeof window !== "undefined"
              && !window.confirm(t("skills.SkillStudio.confirmDeleteTemplate", { name: template.name }))
            ) {
              return;
            }
            deleteTemplateMutation.mutate(template.id);
          }}
          deletingTemplateId={deleteTemplateMutation.variables ?? null}
          actionPending={
            createTemplateMutation.isPending
            || updateTemplateMutation.isPending
            || deleteTemplateMutation.isPending
          }
        />
        {filterInput && (
          <div className="px-3 pt-2">
            <FilterBar
              filters={[{ key: "input", label: t("skills.SkillStudio.inputTitle"), value: filterInput.name }]}
              onRemove={onClearFilter}
              onClear={onClearFilter}
            />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {runsQuery.isLoading ? (
            <div className="text-xs text-muted-foreground">{t("skills.SkillStudio.loadingRuns")}</div>
          ) : runs.length === 0 ? (
            <EmptyState icon={FlaskConical} message={t("skills.SkillStudio.noTestRuns")} />
          ) : (
            <div className="space-y-1 rounded-md border border-border p-1">
              {runs.map((run) => (
                <RunHistoryRow
                  key={run.id}
                  run={run}
                  agents={agents}
                  onSelect={() => onSelectRun(run.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <RunTemplateDialog
        state={templateDialog}
        pending={createTemplateMutation.isPending || updateTemplateMutation.isPending}
        onOpenChange={(open) => {
          if (!open) setTemplateDialog(null);
        }}
        onSubmit={(payload) => {
          if (templateDialog?.mode === "edit") {
            updateTemplateMutation.mutate({ templateId: templateDialog.source.id, payload });
          } else {
            createTemplateMutation.mutate(payload);
          }
        }}
      />
    </PaneScaffold>
  );
}

type RunTemplateOption = SearchableSelectOption<string> & {
  description: string | null;
  builtIn: boolean;
};

function runTemplateOptionValue(selection: RunTemplateSelection) {
  return selection ?? NO_TEST_RUN_TEMPLATE_STORAGE_VALUE;
}

function runTemplateSelectionFromOption(value: string): RunTemplateSelection {
  return value === NO_TEST_RUN_TEMPLATE_STORAGE_VALUE ? null : value;
}

function RunTemplateAdvancedPanel({
  open,
  onOpenChange,
  templates,
  templatesLoading,
  templatesError,
  selectedTemplateId,
  selectedTemplate,
  selectedTemplateName,
  onSelectTemplate,
  onCreateTemplate,
  onEditTemplate,
  onDuplicateTemplate,
  onDeleteTemplate,
  deletingTemplateId,
  actionPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: CompanySkillTestRunTemplate[];
  templatesLoading: boolean;
  templatesError: boolean;
  selectedTemplateId: RunTemplateSelection;
  selectedTemplate: CompanySkillTestRunTemplate | null;
  selectedTemplateName: string;
  onSelectTemplate: (selection: RunTemplateSelection) => void;
  onCreateTemplate: () => void;
  onEditTemplate: (template: CompanySkillTestRunTemplate) => void;
  onDuplicateTemplate: (template: CompanySkillTestRunTemplate) => void;
  onDeleteTemplate: (template: CompanySkillTestRunTemplate) => void;
  deletingTemplateId: string | null;
  actionPending: boolean;
}) {
  const { t } = useTranslation();
  const templateGroups = useMemo<readonly SearchableSelectGroup<string, RunTemplateOption>[]>(() => {
    const noTemplateOption: RunTemplateOption = {
      key: "no-template",
      value: NO_TEST_RUN_TEMPLATE_STORAGE_VALUE,
      label: t("skills.SkillStudio.noTemplate"),
      title: t("skills.SkillStudio.noTemplate"),
      description: t("skills.SkillStudio.noTemplateDescription"),
      builtIn: true,
      searchText: "no template plain input",
    };
    const toOption = (template: CompanySkillTestRunTemplate): RunTemplateOption => ({
      key: template.id,
      value: template.id,
      label: template.name,
      title: template.name,
      description: template.description,
      builtIn: template.builtIn,
      searchText: [template.name, template.description ?? "", template.builtIn ? "built in" : "custom"].join(" "),
    });
    const builtIn = templates.filter((template) => template.builtIn).map(toOption);
    const custom = templates.filter((template) => !template.builtIn).map(toOption);
    return [
      { id: "built-in", label: t("skills.SkillStudio.builtIn"), options: [noTemplateOption, ...builtIn] },
      ...(custom.length > 0 ? [{ id: "custom", label: t("skills.SkillStudio.custom"), options: custom }] : []),
    ];
  }, [templates, t]);

  const selectedValue = runTemplateOptionValue(selectedTemplateId);
  const selectedMissing = selectedTemplateId !== null && !selectedTemplate && !templatesLoading;
  const canEdit = Boolean(selectedTemplate && !selectedTemplate.builtIn);
  const canDuplicate = Boolean(selectedTemplate);
  const canDelete = Boolean(selectedTemplate && !selectedTemplate.builtIn);

  return (
    <div className="border-b border-border">
      <button
        type="button"
        className="flex min-h-(--sz-32px) w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => onOpenChange(!open)}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <span className="font-semibold uppercase tracking-wide">{t("skills.SkillStudio.advanced")}</span>
        <span className="ml-auto truncate">{selectedTemplateName}</span>
      </button>
      {open ? (
        <div className="space-y-3 px-3 pb-3 pt-1">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Label>{t("skills.SkillStudio.runTemplateLabel")}</Label>
              <SearchableSelect<string, RunTemplateOption>
                value={selectedValue}
                groups={templateGroups}
                loading={templatesLoading}
                disabled={templatesLoading || templatesError}
                loadingMessage={t("skills.SkillStudio.loadingTemplates")}
                placeholder={t("skills.SkillStudio.selectTemplate")}
                searchPlaceholder={t("skills.SkillStudio.searchTemplates")}
                emptyMessage={t("skills.SkillStudio.noTemplates")}
                contentClassName="w-(--sz-320px)"
                onValueChange={(value) => onSelectTemplate(runTemplateSelectionFromOption(value))}
                renderValue={(option) => option?.label ?? selectedTemplateName}
                renderOption={(option, { selected }) => (
                  <span className="flex min-w-0 flex-col">
                    <span className={cn("truncate", selected && "font-medium")}>{option.label}</span>
                    <span className="truncate text-(length:--text-micro) text-muted-foreground">
                      {option.description ?? (option.builtIn ? t("skills.SkillStudio.builtIn") : t("skills.SkillStudio.custom"))}
                    </span>
                  </span>
                )}
              />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={t("skills.SkillStudio.createRunTemplate")}
                  disabled={actionPending}
                  onClick={onCreateTemplate}
                >
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("skills.SkillStudio.createRunTemplate")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("skills.SkillStudio.editRunTemplate")}
                    disabled={!canEdit || actionPending}
                    onClick={() => selectedTemplate && onEditTemplate(selectedTemplate)}
                  >
                    <Pencil />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t("skills.SkillStudio.editCustomTemplate")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("skills.SkillStudio.duplicateRunTemplate")}
                    disabled={!canDuplicate || actionPending}
                    onClick={() => selectedTemplate && onDuplicateTemplate(selectedTemplate)}
                  >
                    <Copy />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {selectedTemplate?.builtIn ? t("skills.SkillStudio.duplicateBuiltIn") : t("skills.SkillStudio.duplicateTemplate")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("skills.SkillStudio.deleteRunTemplate")}
                    className="text-destructive hover:text-destructive"
                    disabled={!canDelete || actionPending || deletingTemplateId === selectedTemplate?.id}
                    onClick={() => selectedTemplate && onDeleteTemplate(selectedTemplate)}
                  >
                    <Trash2 />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t("skills.SkillStudio.deleteCustomTemplate")}</TooltipContent>
            </Tooltip>
          </div>

          {templatesError ? (
            <p className="text-xs text-destructive">{t("skills.SkillStudio.runTemplatesLoadError")}</p>
          ) : selectedTemplateId === null ? (
            <p className="text-xs text-muted-foreground">{t("skills.SkillStudio.runsUseInputOnly")}</p>
          ) : selectedMissing ? (
            <p className="text-xs text-destructive">{t("skills.SkillStudio.selectedTemplateMissing")}</p>
          ) : selectedTemplate ? (
            <div className="space-y-2">
              {selectedTemplate.description ? (
                <p className="text-xs text-muted-foreground">{selectedTemplate.description}</p>
              ) : null}
              <pre className="max-h-(--sz-240px) overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                {selectedTemplate.body}
              </pre>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("skills.SkillStudio.loadingTemplate")}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function RunTemplateDialog({
  state,
  pending,
  onOpenChange,
  onSubmit,
}: {
  state: RunTemplateDialogState;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: CompanySkillTestRunTemplateCreateRequest) => void;
}) {
  const { t } = useTranslation();
  const source = state?.source ?? null;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (!state) return;
    setName(state.mode === "edit" ? source?.name ?? "" : source ? t("skills.SkillStudio.copyOf", { name: source.name }) : "");
    setDescription(source?.description ?? "");
    setBody(source?.body ?? "");
  }, [source, state]);

  const title = state?.mode === "edit"
    ? t("skills.SkillStudio.editRunTemplate")
    : source?.builtIn
      ? t("skills.SkillStudio.duplicateBuiltIn")
      : t("skills.SkillStudio.createRunTemplate");
  const descriptionText = state?.mode === "edit"
    ? t("skills.SkillStudio.updateCustomInstructions")
    : t("skills.SkillStudio.saveReusableInstructions");

  return (
    <Dialog open={Boolean(state)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{descriptionText}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="run-template-name">{t("common.name")}</Label>
            <Input
              id="run-template-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("skills.SkillStudio.templateNamePlaceholder")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="run-template-description">{t("common.description")}</Label>
            <Input
              id="run-template-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("skills.SkillStudio.templateDescriptionPlaceholder")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="run-template-body">{t("skills.SkillStudio.body")}</Label>
            <Textarea
              id="run-template-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              className="min-h-(--sz-240px) font-mono text-xs leading-5"
            />
            <p className="text-xs text-muted-foreground">
              {t("skills.SkillStudio.placeholdersHint")} {"{{skillName}}"}, {"{{skillKey}}"}, {"{{skillInvocation}}"}, {"{{skillVersion}}"}, {"{{runId}}"}, {"{{issueId}}"}, {"{{outputDocumentKey}}"}.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!name.trim() || !body.trim() || pending}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                description: description.trim() || null,
                body,
              })
            }
          >
            {pending ? t("common.saving") : t("skills.SkillStudio.saveTemplate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunHistoryRow({
  run,
  agents,
  onSelect,
}: {
  run: CompanySkillTestRun;
  agents: Agent[];
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const agent = agents.find((a) => a.id === run.agentId) ?? null;
  const removed = !agent;
  const snapshotName =
    (run.agentConfigSnapshot?.name as string | undefined) ?? t("skills.SkillStudio.agentFallback");
  const name = agent?.name ?? snapshotName;
  return (
    <EntityRow
      leading={<StatusBadge status={runBadgeStatus(run.status)} />}
      identifier={runShortId(run)}
      title={removed ? t("skills.SkillStudio.nameRemoved", { name }) : name}
      subtitle={relativeTime(run.createdAt)}
      trailing={
        <span className="font-mono text-xs text-muted-foreground">
          {formatCents(run.cost.costCents)}
        </span>
      }
      onClick={onSelect}
    />
  );
}

function AgentPicker({
  agents,
  selectedAgent,
  onSelect,
}: {
  agents: Agent[];
  selectedAgent: Agent | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          {selectedAgent ? (
            <AgentIdentity agent={selectedAgent} size="xs" />
          ) : (
            <span className="text-muted-foreground">{t("skills.SkillStudio.pickAgent")}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={t("skills.SkillStudio.searchAgents")} />
          <CommandList>
            <CommandEmpty>{t("skills.SkillStudio.noAgents")}</CommandEmpty>
            <CommandGroup>
              {agents.map((agent) => {
                const selectable = isAgentSelectable(agent);
                return (
                  <CommandItem
                    key={agent.id}
                    value={agent.name}
                    disabled={!selectable}
                    onSelect={() => {
                      if (!selectable) return;
                      onSelect(agent.id);
                      setOpen(false);
                    }}
                    className={cn("flex items-center gap-2", !selectable && "opacity-50")}
                  >
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        selectable ? "bg-green-500" : "bg-orange-400",
                      )}
                      aria-hidden
                    />
                    <AgentIdentity agent={agent} size="xs" />
                    {!selectable && (
                      <Badge variant="secondary" className="ml-auto">
                        {t("skills.SkillStudio.paused")}
                      </Badge>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Run detail
// ---------------------------------------------------------------------------

function RunDetailView({
  companyId,
  skill,
  runId,
  agents,
  onBack,
  onSelectRun,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  runId: string;
  agents: Agent[];
  onBack: () => void;
  onSelectRun: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const skillId = skill.id;
  const queryClient = useQueryClient();
  const onError = useMutationErrorToast();
  const detailQuery = useQuery({
    queryKey: queryKeys.companySkills.testRunDetail(companyId, skillId, runId),
    queryFn: () => companySkillsApi.testRunDetail(companyId, skillId, runId),
    enabled: Boolean(companyId && skillId && runId),
    refetchInterval: (query) => {
      const data = query.state.data as CompanySkillTestRunDetail | undefined;
      return data && shouldPollRun(data.status) ? POLL_MS : false;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => companySkillsApi.cancelTestRun(companyId, skillId, runId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testRunDetail(companyId, skillId, runId),
      }),
    onError: onError(t("skills.SkillStudio.couldntCancelRun")),
  });

  // Re-run reproduces the VIEWED run's snapshots — pinned skill version, saved
  // input (or the ad-hoc snapshot), and agent — rather than whatever the picker
  // happens to hold this session (PAP-13001 Bug A). Reading detailQuery.data at
  // mutate() time keeps the hook order stable across the loading guards below.
  const reRunMutation = useMutation({
    mutationFn: () => {
      const d = detailQuery.data;
      if (!d) throw new Error(t("skills.SkillStudio.runDetailsLoading"));
      return companySkillsApi.createTestRun(companyId, skillId, buildReRunRequest(d));
    },
    onSuccess: (run) => {
      queryClient.invalidateQueries({
        queryKey: ["company-skills", companyId, skillId, "test-runs"],
      });
      onSelectRun(run.id);
    },
    onError: onError(t("skills.SkillStudio.couldntRerun")),
  });

  const deleteMutation = useMutation({
    mutationFn: () => companySkillsApi.deleteTestRun(companyId, skillId, runId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["company-skills", companyId, skillId, "test-runs"],
      });
      onSelectRun(null);
    },
    onError: onError(t("skills.SkillStudio.couldntDeleteRun")),
  });

  const detail = detailQuery.data ?? null;
  const additionalDocuments = useMemo(() => detail ? getRunAdditionalDocuments(detail) : [], [detail]);
  const rawAttachments = useMemo(() => detail ? getRunRawAttachments(detail) : [], [detail]);
  const unavailableCopy = useMemo(() => detail ? runHarnessUnavailableCopy(detail) : null, [detail]);
  const mediaGalleryItems = useMemo<GalleryMediaItem[]>(
    () => detail ? getRunMediaGalleryItems(detail) : [],
    [detail],
  );
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);

  if (detailQuery.isLoading) {
    return (
      <PaneScaffold title={t("skills.SkillStudio.runTitle")} action={<BackButton onBack={onBack} />}>
        <div className="p-3 text-xs text-muted-foreground">{t("skills.SkillStudio.loadingRun")}</div>
      </PaneScaffold>
    );
  }
  if (!detail) {
    return (
      <PaneScaffold title={t("skills.SkillStudio.runTitle")} action={<BackButton onBack={onBack} />}>
        <div className="p-3 text-xs text-muted-foreground">{t("skills.SkillStudio.runNotFound")}</div>
      </PaneScaffold>
    );
  }

  const agent = agents.find((a) => a.id === detail.agentId) ?? null;
  const agentName =
    agent?.name ?? (detail.agentConfigSnapshot?.name as string | undefined) ?? t("skills.SkillStudio.agentFallback");
  const removed = !agent;
  const outputMode = runOutputMode(detail);
  const nonTerminal = !isTerminalRunStatus(detail.status);
  const taskLink = testTaskLinkState(detail);

  return (
    <PaneScaffold title={t("skills.SkillStudio.runTitle")} action={<BackButton onBack={onBack} />}>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={runBadgeStatus(detail.status)} />
          <AgentIdentity agent={agent ?? { id: detail.agentId, name: agentName }} size="xs" />
          {removed && <Badge variant="secondary">{t("skills.SkillStudio.removedBadge")}</Badge>}
          <span className="font-mono text-xs text-muted-foreground">
            v{detail.skillVersion.revisionNumber}
          </span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {formatCents(detail.cost.costCents)}
          </span>
        </div>

        {/* snapshot property block */}
        <div className="rounded-md border border-border text-xs">
          <PropRow label={t("skills.SkillStudio.inputTitle")} value={detail.inputId ? t("skills.SkillStudio.savedInput") : t("skills.SkillStudio.adHocPaste")} />
          <PropRow label={t("skills.SkillStudio.template")} value={detail.templateName ?? t("skills.SkillStudio.noTemplate")} />
          <PropRow label={t("skills.SkillStudio.skillVersion")} value={`v${detail.skillVersion.revisionNumber}`} />
          <PropRow label={t("skills.SkillStudio.created")} value={relativeTime(detail.createdAt)} />
        </div>

        {showRunErrorCard(detail.status) && (
          <Card className="border-destructive/50">
            <CardHeader className="flex-row items-center gap-2 space-y-0 pb-2">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
              <span className="text-sm font-medium">{t("skills.SkillStudio.runFailed")}</span>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {detail.error ?? t("skills.SkillStudio.taskEndedWithError")}
            </CardContent>
          </Card>
        )}

        {/* Output snapshot / draft-at-failure */}
        {outputMode === "output" || outputMode === "draft" ? (
          <section className="space-y-2">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {outputMode === "draft" ? t("skills.SkillStudio.draftAtFailure") : t("skills.SkillStudio.outputSnapshot")}
            </h3>
            <div className="rounded-md border border-border p-3">
              <MarkdownBody>{detail.outputBody || t("skills.SkillStudio.noOutput")}</MarkdownBody>
            </div>
          </section>
        ) : outputMode === "pending" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> {t("skills.SkillStudio.workingOutput")}
          </div>
        ) : null}

        {unavailableCopy ? (
          <RunHarnessUnavailableNotice copy={unavailableCopy} />
        ) : null}

        {additionalDocuments.length > 0 ? (
          <RunDocumentsSection documents={additionalDocuments} />
        ) : null}

        <IssueOutputSection
          workProducts={detail.harnessContent.workProducts}
          onMediaClick={(item) => {
            const meta = item.metadata;
            if (!meta) return;
            const idx = mediaGalleryItems.findIndex((galleryItem) => (
              galleryItem.contentPath === meta.contentPath ||
              galleryItem.id === `work-product-${item.id}` ||
              galleryItem.id === meta.attachmentId
            ));
            setGalleryIndex(idx >= 0 ? idx : 0);
            setGalleryOpen(true);
          }}
        />

        {rawAttachments.length > 0 ? (
          <IssueAttachmentsSection
            attachments={rawAttachments}
            onImageClick={(attachment) => {
              const idx = mediaGalleryItems.findIndex((item) => (
                item.id === attachment.id || item.contentPath === attachment.contentPath
              ));
              setGalleryIndex(idx >= 0 ? idx : 0);
              setGalleryOpen(true);
            }}
          />
        ) : null}

        {/* Interactions */}
        <InteractionSection
          companyId={companyId}
          detail={detail}
          agents={agents}
          onAnswered={() =>
            queryClient.invalidateQueries({
              queryKey: queryKeys.companySkills.testRunDetail(companyId, skillId, runId),
            })
          }
        />

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={reRunMutation.isPending}
            onClick={() => reRunMutation.mutate()}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> {t("skills.SkillStudio.rerun")}
          </Button>
          {nonTerminal ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              {t("common.cancel")}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> {t("common.delete")}
            </Button>
          )}
          {taskLink.enabled && detail.harnessIssue ? (
            <Button variant="link" size="sm" asChild>
              <Link to={`/issues/${detail.harnessIssue.id}`}>{t("skills.SkillStudio.openTestTask")}</Link>
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-not-allowed text-xs text-muted-foreground">
                  {t("skills.SkillStudio.openTestTask")}
                </span>
              </TooltipTrigger>
              <TooltipContent>{taskLink.reason}</TooltipContent>
            </Tooltip>
          )}
        </div>

        <ImageGalleryModal
          items={mediaGalleryItems}
          initialIndex={galleryIndex}
          open={galleryOpen}
          onOpenChange={setGalleryOpen}
        />
      </div>
    </PaneScaffold>
  );
}

function RunHarnessUnavailableNotice({
  copy,
}: {
  copy: NonNullable<ReturnType<typeof runHarnessUnavailableCopy>>;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-foreground">{copy.title}</p>
        <p className="text-muted-foreground">{copy.body}</p>
      </div>
    </div>
  );
}

function RunDocumentsSection({ documents }: { documents: IssueDocument[] }) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-medium text-muted-foreground">{t("skills.SkillStudio.documents")}</h3>
        <span className="text-xs text-muted-foreground">{documents.length}</span>
      </div>
      <div className="space-y-2">
        {documents.map((document) => (
          <article key={document.id} className="rounded-md border border-border p-3">
            <div className="mb-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate font-medium text-foreground">
                {document.title ?? document.key}
              </span>
              <span className="ml-auto shrink-0">{relativeTime(document.updatedAt)}</span>
            </div>
            <MarkdownBody className="paperclip-edit-in-place-content text-sm leading-7" softBreaks={false}>
              {document.body}
            </MarkdownBody>
          </article>
        ))}
      </div>
    </section>
  );
}

function InteractionSection({
  companyId,
  detail,
  agents,
  onAnswered,
}: {
  companyId: string;
  detail: CompanySkillTestRunDetail;
  agents: Agent[];
  onAnswered: () => void;
}) {
  const { t } = useTranslation();
  const harnessIssueId = detail.harnessIssue?.id ?? null;
  const hasInlineAnswerable = detail.interactions.some((i) => isInteractionAnswerable(i));

  // Only fetch the full interaction objects (needed to render answerable cards)
  // when there is at least one pending inline interaction on a live harness issue.
  const fullQuery = useQuery({
    queryKey: ["skill-studio", "interactions", harnessIssueId],
    queryFn: () => issuesApi.listInteractions(harnessIssueId!),
    enabled: Boolean(harnessIssueId && hasInlineAnswerable),
    refetchInterval: (query) => interactionReadinessRefetchInterval(query.state.data, hasInlineAnswerable ? POLL_MS : false),
  });
  const fullById = useMemo(
    () => new Map((fullQuery.data ?? []).map((i) => [i.id, i])),
    [fullQuery.data],
  );
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const accept = useMutation({
    mutationFn: (vars: { interaction: IssueThreadInteraction; optionIds?: string[] }) =>
      issuesApi.acceptInteraction(harnessIssueId!, vars.interaction.id, {
        selectedOptionIds: vars.optionIds,
      }),
    onSuccess: onAnswered,
  });
  const respond = useMutation({
    mutationFn: (vars: { interaction: AskUserQuestionsInteraction; answers: AskUserQuestionsAnswer[] }) =>
      issuesApi.respondToInteraction(harnessIssueId!, vars.interaction.id, { answers: vars.answers }),
    onSuccess: onAnswered,
  });
  const reject = useMutation({
    mutationFn: (vars: { interaction: IssueThreadInteraction; reason?: string }) =>
      issuesApi.rejectInteraction(harnessIssueId!, vars.interaction.id, vars.reason),
    onSuccess: onAnswered,
  });

  if (detail.interactions.length === 0) return null;

  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("skills.SkillStudio.interactions")}
      </h3>
      <div className="space-y-2">
        {detail.interactions.map((summary) => {
          const inline = routeInteraction(summary.kind) === "inline";
          const full = fullById.get(summary.id);
          if (inline && full) {
            return (
              <IssueThreadInteractionCard
                key={summary.id}
                interaction={full}
                agentMap={agentMap}
                onAcceptInteraction={async (interaction, _keys, optionIds) => {
                  await accept.mutateAsync({ interaction, optionIds });
                }}
                onRejectInteraction={async (interaction, reason) => {
                  await reject.mutateAsync({ interaction, reason });
                }}
                onSubmitInteractionAnswers={async (interaction, answers) => {
                  await respond.mutateAsync({ interaction, answers });
                }}
              />
            );
          }
          // Fallback: summary row + open-test-task link (never dropped).
          return (
            <EntityRow
              key={summary.id}
              title={summary.title}
              subtitle={`${summary.kind} · ${summary.status}`}
              trailing={
                harnessIssueId ? (
                  <Button variant="link" size="xs" asChild>
                    <Link to={`/issues/${harnessIssueId}`}>{t("skills.SkillStudio.openTestTask")}</Link>
                  </Button>
                ) : null
              }
            />
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Version history drawer
// ---------------------------------------------------------------------------

function VersionHistorySheet({
  open,
  onOpenChange,
  companyId,
  skill,
  onRestored,
  onFilterRuns,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  skill: CompanySkillDetail;
  onRestored: () => void;
  onFilterRuns: (inputId: string) => void;
}) {
  const { t } = useTranslation();
  const skillId = skill.id;
  const queryClient = useQueryClient();
  const versionsQuery = useQuery({
    queryKey: queryKeys.companySkills.versions(companyId, skillId),
    queryFn: () => companySkillsApi.versions(companyId, skillId),
    enabled: open && Boolean(companyId && skillId),
  });
  const versions = versionsQuery.data ?? [];
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);

  const restore = useMutation({
    mutationFn: async (selection: { id: string }) => {
      if (skill.sourceType === "local_path") {
        const version = await companySkillsApi.version(companyId, skillId, selection.id);
        let expectedVersionId = skill.currentVersionId;
        for (const file of version.fileInventory) {
          const saved = await companySkillsApi.updateFile(companyId, skillId, file.path, file.content, {
            encoding: file.encoding, executable: file.executable ?? false, expectedVersionId,
          });
          expectedVersionId = saved.versionId ?? expectedVersionId;
        }
        return companySkillsApi.createVersion(companyId, skillId, {
          label: `Restore of v${version.revisionNumber}`, expectedVersionId,
        });
      }
      return companySkillsApi.createVersion(companyId, skillId, {
        sourceVersionId: selection.id, expectedVersionId: skill.currentVersionId,
        label: "Restored saved version",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.versions(companyId, skillId) });
      onRestored();
    },
  });

  const leftQuery = useQuery({
    queryKey: [...queryKeys.companySkills.versions(companyId, skillId), leftId],
    queryFn: () => companySkillsApi.version(companyId, skillId, leftId!),
    enabled: open && Boolean(leftId && rightId),
  });
  const rightQuery = useQuery({
    queryKey: [...queryKeys.companySkills.versions(companyId, skillId), rightId],
    queryFn: () => companySkillsApi.version(companyId, skillId, rightId!),
    enabled: open && Boolean(leftId && rightId),
  });
  const left = leftQuery.data ?? null;
  const right = rightQuery.data ?? null;
  const diff = left && right ? buildLineDiff(
    left.fileInventory.map((f) => `# ${f.path}${f.executable ? ` ${t("skills.SkillStudio.executableTag")}` : ""}\n${f.encoding === "base64" ? t("skills.SkillStudio.binaryAsset") : f.content}`).join("\n\n"),
    right.fileInventory.map((f) => `# ${f.path}${f.executable ? ` ${t("skills.SkillStudio.executableTag")}` : ""}\n${f.encoding === "base64" ? t("skills.SkillStudio.binaryAsset") : f.content}`).join("\n\n"),
  ) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-full sm:max-w-(--sz-560px)">
        <SheetHeader>
          <SheetTitle>{t('skills.studio.versionHistory', { defaultValue: 'Version history' })}</SheetTitle>
        </SheetHeader>
        <div className="mt-3 space-y-2 overflow-auto">
          {versionsQuery.isLoading ? (
            <div className="text-xs text-muted-foreground">{t("skills.SkillStudio.loadingVersions")}</div>
          ) : versions.length === 0 ? (
            <EmptyState icon={History} message={t("skills.SkillStudio.noVersions")} />
          ) : (
            <div className="space-y-1 rounded-md border border-border p-1">
              {versions.map((v) => (
                <EntityRow
                  key={v.id}
                  identifier={`v${v.revisionNumber}`}
                  title={v.label ?? t("skills.SkillStudio.versionNumber", { number: v.revisionNumber })}
                  subtitle={relativeTime(v.createdAt)}
                  selected={v.id === leftId || v.id === rightId}
                  onClick={() => {
                    // click to build a two-version diff selection
                    if (!leftId) setLeftId(v.id);
                    else if (!rightId && v.id !== leftId) setRightId(v.id);
                    else {
                      setLeftId(v.id);
                      setRightId(null);
                    }
                  }}
                  trailing={
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={restore.isPending || skill.editable === false}
                      onClick={(e) => {
                        e.stopPropagation();
                        restore.mutate(v);
                      }}
                    >
                      {t("skills.SkillStudio.restoreAs", { version: (skill.currentVersion?.revisionNumber ?? v.revisionNumber) + 1 })}
                    </Button>
                  }
                />
              ))}
            </div>
          )}
          {(versionsQuery.error || leftQuery.error || rightQuery.error || restore.error) && (
            <p role="alert" className="text-sm text-destructive">
              {(versionsQuery.error ?? leftQuery.error ?? rightQuery.error ?? restore.error)?.message}
            </p>
          )}
          {leftId && rightId && (leftQuery.isLoading || rightQuery.isLoading) && (
            <p className="text-sm text-muted-foreground">{t("skills.SkillStudio.loadingSelectedVersions")}</p>
          )}
          {diff && (
            <div className="rounded-md border border-border">
              <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                {t("skills.SkillStudio.diffTitle", { left: left?.revisionNumber, right: right?.revisionNumber })}
              </div>
              <pre className="max-h-64 overflow-auto p-2 text-xs">
                {diff.map((row, i) => (
                  <div
                    key={i}
                    className={cn(
                      "whitespace-pre-wrap",
                      row.kind === "added" && "bg-green-500/10 text-green-700 dark:text-green-300",
                      row.kind === "removed" && "bg-red-500/10 text-red-700 dark:text-red-300",
                    )}
                  >
                    {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
                    {row.text}
                  </div>
                ))}
              </pre>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function PaneScaffold({
  title,
  action,
  children,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        {action}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> {t("skills.SkillStudio.back")}
    </Button>
  );
}

function MobileTabs({
  skill,
  input,
  runs,
}: {
  skill: React.ReactNode;
  input: React.ReactNode;
  runs: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Tabs defaultValue="skill" className="flex flex-1 flex-col">
      <TabsList variant="line" className="px-3">
        <TabsTrigger value="skill">{t("skills.SkillStudio.tabSkill")}</TabsTrigger>
        <TabsTrigger value="input">{t("skills.SkillStudio.inputTitle")}</TabsTrigger>
        <TabsTrigger value="runs">{t("skills.SkillStudio.tabRuns")}</TabsTrigger>
      </TabsList>
      <TabsContent value="skill" className="min-h-0 flex-1">
        {skill}
      </TabsContent>
      <TabsContent value="input" className="min-h-0 flex-1">
        {input}
      </TabsContent>
      <TabsContent value="runs" className="min-h-0 flex-1">
        {runs}
      </TabsContent>
    </Tabs>
  );
}
