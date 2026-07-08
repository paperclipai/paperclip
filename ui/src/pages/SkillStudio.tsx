import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Clock,
  Copy,
  FileCode,
  FilePlus,
  FolderMinus,
  FolderPlus,
  FlaskConical,
  History,
  MoreHorizontal,
  Play,
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
  CompanySkillVersion,
  IssueThreadInteraction,
  AskUserQuestionsInteraction,
  AskUserQuestionsAnswer,
} from "@paperclipai/shared";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import {
  SearchableSelect,
  type SearchableSelectGroup,
  type SearchableSelectOption,
} from "@/components/SearchableSelect";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useOptionalToastActions } from "../context/ToastContext";
import { agentsApi } from "@/api/agents";
import { companySkillsApi } from "@/api/companySkills";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn, formatCents, relativeTime } from "@/lib/utils";
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
import { MarkdownBody } from "@/components/MarkdownBody";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { EntityRow } from "@/components/EntityRow";
import { FilterBar } from "@/components/FilterBar";
import { Identity } from "@/components/Identity";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { buildLineDiff } from "@/lib/line-diff";
import {
  buildReRunRequest,
  evaluateRunGate,
  isAgentSelectable,
  isInteractionAnswerable,
  isTerminalRunStatus,
  routeInteraction,
  runBadgeStatus,
  runOutputMode,
  runShortId,
  shouldPollRun,
  showRunErrorCard,
  testTaskLinkState,
} from "@/lib/skill-studio";

const PANE_STORAGE_KEY = "skillStudio.paneSizes";
const MOBILE_BREAKPOINT = 900;
const POLL_MS = 2000;

/**
 * Surface a mutation rejection as an error toast. Every Studio mutation routes
 * failures through here so server rejections (409 agent_not_assignable, 422
 * read-only, …) never get silently swallowed (PAP-13001).
 */
function useMutationErrorToast() {
  const toast = useOptionalToastActions();
  return useCallback(
    (title: string) => (error: unknown) => {
      const body =
        error instanceof Error && error.message ? error.message : "Please try again.";
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
  const { skillId = "" } = useParams<{ skillId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? "";

  const detailQuery = useQuery({
    queryKey: queryKeys.companySkills.detail(companyId, skillId),
    queryFn: () => companySkillsApi.detail(companyId, skillId),
    enabled: Boolean(companyId && skillId),
  });
  const skill = detailQuery.data ?? null;

  useEffect(() => {
    if (!skill) return;
    setBreadcrumbs([
      { label: "Skills", href: "/skills" },
      { label: "Studio", href: "/skills" },
      { label: skill.name },
    ]);
  }, [setBreadcrumbs, skill]);

  if (!companyId) {
    return <StudioMessage message="Select a company to open Skill Studio." />;
  }
  if (detailQuery.isLoading) {
    return <StudioMessage message="Loading skill…" />;
  }
  if (detailQuery.isError || !detailQuery.data) {
    return <StudioMessage message="Skill not found." />;
  }

  return <StudioShell companyId={companyId} skill={detailQuery.data} />;
}

function StudioMessage({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-(--sz-60vh) items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell — header + three panes (or mobile tabs)
// ---------------------------------------------------------------------------

function StudioShell({ companyId, skill }: { companyId: string; skill: CompanySkillDetail }) {
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

  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(companyId),
    queryFn: () => companySkillsApi.list(companyId, { sort: "alphabetical" }),
    enabled: Boolean(companyId),
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
    />
  );
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
          skill={skill}
          skillDirty={skillDirty}
          skills={skillsQuery.data ?? []}
          skillsLoading={skillsQuery.isLoading}
          onSelectSkill={(nextSkillId) => navigate(`/skills/${encodeURIComponent(nextSkillId)}/studio`)}
          onOpenVersions={() => setVersionSheetOpen(true)}
        />
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
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function StudioHeader({
  skill,
  skillDirty,
  skills,
  skillsLoading,
  onSelectSkill,
  onOpenVersions,
}: {
  skill: CompanySkillDetail;
  skillDirty: boolean;
  skills: CompanySkillListItem[];
  skillsLoading: boolean;
  onSelectSkill: (skillId: string) => void;
  onOpenVersions: () => void;
}) {
  const version = skill.currentVersion?.revisionNumber ?? null;
  const toast = useOptionalToastActions();
  const copyShareLink = useCallback(() => {
    const href = typeof window !== "undefined" ? window.location.href : "";
    void copyTextToClipboard(href)
      .then(() => toast?.pushToast({ tone: "success", title: "Link copied", body: "Skill Studio link copied to clipboard." }))
      .catch((error) => toast?.pushToast({
        tone: "error",
        title: "Copy failed",
        body: error instanceof Error ? error.message : "Could not copy the link.",
      }));
  }, [toast]);

  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
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
        <Badge variant="secondary">Unsaved edits</Badge>
      ) : null}
      {!skill.editable ? (
        <Badge variant="secondary">Read-only</Badge>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onOpenVersions}>
          <History className="mr-1.5 h-3.5 w-3.5" />
          Version history
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Studio menu">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={copyShareLink}>
              <Share2 className="mr-2 h-4 w-4" /> Share link
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
}: {
  skill: CompanySkillDetail;
  skills: CompanySkillListItem[];
  loading: boolean;
  onSelectSkill: (skillId: string) => void;
}) {
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
      value={skill.id}
      groups={groups}
      loading={loading}
      loadingMessage="Loading skills..."
      placeholder="Select skill"
      searchPlaceholder="Search skills..."
      emptyMessage="No matching skills."
      onValueChange={(value) => {
        if (value !== skill.id) onSelectSkill(value);
      }}
      triggerClassName="h-8 w-64 border-0 bg-transparent px-1 text-base font-semibold shadow-none hover:bg-accent md:w-80"
      contentClassName="w-80"
      contentWidth="auto"
      renderValue={(option) => option?.label ?? skill.name}
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
  skill: CompanySkillDetail,
): Array<CompanySkillListItem | CompanySkillDetail> {
  return skills.some((candidate) => candidate.id === skill.id) ? skills : [skill, ...skills];
}

// ---------------------------------------------------------------------------
// Left — Skill files + editor
// ---------------------------------------------------------------------------

function SkillPane({
  companyId,
  skill,
  onDirtyChange,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  onDirtyChange: (dirty: boolean) => void;
}) {
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
  const [createDialog, setCreateDialog] = useState<"file" | "folder" | null>(null);
  const [deleteFolderOpen, setDeleteFolderOpen] = useState(false);

  const nodes: FileTreeNode[] = useMemo(
    () => buildFileTree(Object.fromEntries(paths.map((p) => [p, ""]))),
    [paths],
  );

  const fileQuery = useQuery({
    queryKey: queryKeys.companySkills.file(companyId, skillId, selectedFile),
    queryFn: () => companySkillsApi.file(companyId, skillId, selectedFile),
    enabled: Boolean(companyId && skillId && selectedFile),
  });

  useEffect(() => {
    if (fileQuery.data) {
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
      && !window.confirm("Discard unsaved edits and switch files?")
    ) {
      return;
    }
    setSelectedFile(path);
  }, [dirty, selectedFile]);

  const saveMutation = useMutation({
    mutationFn: () => companySkillsApi.updateFile(companyId, skillId, selectedFile, draft),
    onSuccess: (updated) => {
      setSavedContent(updated.content);
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
    onError: onError("Couldn't save file"),
  });

  const createMutation = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      companySkillsApi.updateFile(companyId, skillId, path, content),
    onSuccess: (created) => {
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
    onError: onError("Couldn't create file"),
  });

  const deleteMutation = useMutation({
    mutationFn: (input: { path: string; target: "file" | "folder" }) =>
      companySkillsApi.deleteFile(companyId, skillId, input),
    onSuccess: (result) => {
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
    onError: onError("Couldn't delete file"),
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
        <EmptyState icon={FileCode} message="This skill has no files yet." />
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
        {dirty && !readOnly ? (
          <div className="flex items-start gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span>Unsaved edits live only in this Studio session. Save to create the next version before running tests or switching files.</span>
          </div>
        ) : null}
        <div className="max-h-56 overflow-auto border-b border-border p-1">
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
            ariaLabel="Skill files"
          />
        </div>
        {readOnly && (
          <div className="flex items-start gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <div className="min-w-0">
              <span>
                {skill.editableReason ?? "This skill is read-only."}
              </span>{" "}
              <Link
                to={`/skills/${skill.id}`}
                className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
              >
                Fork or import locally ↗
              </Link>
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
              <Badge variant="secondary">Read-only</Badge>
            ) : (
              <>
                {dirty && <Badge variant="secondary">Unsaved</Badge>}
                <Button
                  size="sm"
                  disabled={!dirty || saveMutation.isPending}
                  onClick={() => saveMutation.mutate()}
                >
                  {saveMutation.isPending ? "Saving…" : "Save"}
                </Button>
              </>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
          {isMarkdown ? (
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
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
  const disabled = readOnly || pending;
  const deleteDisabled = disabled || !canDeleteFile;
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={onAddFile} aria-label="Add file">
              <FilePlus className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Add file</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={onAddFolder} aria-label="Add folder">
              <FolderPlus className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Add folder</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={deleteDisabled}
              onClick={() => {
                if (typeof window === "undefined" || window.confirm(`Delete ${selectedFile}?`)) {
                  onDeleteFile();
                }
              }}
              aria-label="Delete file"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{canDeleteFile ? "Delete file" : "SKILL.md cannot be deleted"}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={onDeleteFolder} aria-label="Delete folder">
              <FolderMinus className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Delete folder</TooltipContent>
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
  const [pathValue, setPathValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !mode) return;
    setPathValue(mode === "folder"
      ? normalizeStudioPath(currentFolder ? `${currentFolder}/new-folder` : "new-folder")
      : normalizeStudioPath(currentFolder ? `${currentFolder}/new-file.md` : "notes.md"));
    setError(null);
  }, [currentFolder, mode, open]);

  const title = mode === "folder" ? "Add folder" : "Add file";
  const label = mode === "folder" ? "Folder path" : "File path";

  function submit() {
    if (!mode) return;
    const normalized = normalizeStudioPath(pathValue);
    if (!normalized) {
      setError(`${label} is required.`);
      return;
    }
    if (mode === "file") {
      if (existingPaths.has(normalized)) {
        setError("A file already exists at that path.");
        return;
      }
      onSubmit(normalized, "");
      return;
    }

    const folderPath = normalized.replace(/\/+$/, "");
    if ([...existingPaths].some((path) => path.startsWith(`${folderPath}/`))) {
      setError("A folder already exists at that path.");
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
            Saved changes create a new version immediately. External sources are not updated until you publish or install an update.
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
            <p className="text-xs text-muted-foreground">A README.md seed file is created so the folder appears in the file tree.</p>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={submit}>
            Create
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
      setError("Folder path is required.");
      return;
    }
    const matchingFiles = [...existingPaths].filter((path) => path.startsWith(`${normalized}/`));
    if (matchingFiles.length === 0) {
      setError("No files exist under that folder.");
      return;
    }
    if (matchingFiles.includes("SKILL.md")) {
      setError("SKILL.md cannot be deleted.");
      return;
    }
    onSubmit(normalized);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete folder</DialogTitle>
          <DialogDescription>
            This removes every skill file under the folder and saves the result as the next version.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="skill-folder-delete">Folder path</Label>
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
            Cancel
          </Button>
          <Button variant="destructive" disabled={pending} onClick={submit}>
            Delete
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
  const queryClient = useQueryClient();
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [savedDraft, setSavedDraft] = useState("");
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);

  const selectedInput = inputs.find((i) => i.id === selectedInputId) ?? null;

  // In ad-hoc mode the editor is controlled by the shared shell state; otherwise
  // it edits a local copy of the selected saved input.
  const draft = adHocMode ? adHocContent : savedDraft;
  const setDraft = adHocMode ? onAdHocChange : setSavedDraft;

  useEffect(() => {
    if (!adHocMode && selectedInput) {
      setSavedDraft(selectedInput.content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInputId, adHocMode]);

  const nameToId = useMemo(
    () => new Map(inputs.map((i) => [i.name, i.id])),
    [inputs],
  );
  const nodes: FileTreeNode[] = useMemo(
    () => buildFileTree(Object.fromEntries(inputs.map((i) => [i.name, i.content]))),
    [inputs],
  );
  const selectedName = selectedInput?.name ?? null;

  const updateMutation = useMutation({
    mutationFn: (payload: { content: string }) =>
      companySkillsApi.updateTestInput(companyId, skillId, selectedInput!.id, payload),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testInputs(companyId, skillId),
      }),
  });
  const deleteMutation = useMutation({
    mutationFn: (inputId: string) => companySkillsApi.deleteTestInput(companyId, skillId, inputId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testInputs(companyId, skillId),
      }),
  });

  const dirty = selectedInput ? draft !== selectedInput.content : false;

  return (
    <PaneScaffold
      title="Input"
      action={
        <div className="flex items-center gap-1">
          <Button variant="outline" size="xs" onClick={onSelectAdHoc}>
            Paste ad-hoc
          </Button>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="max-h-56 overflow-auto border-b border-border p-1">
          {loading ? (
            <div className="p-3 text-xs text-muted-foreground">Loading inputs…</div>
          ) : inputs.length === 0 && !adHocMode ? (
            <EmptyState
              icon={FilePlus}
              message="No saved inputs. Paste text to test this skill."
              action="Paste ad-hoc"
              onAction={onSelectAdHoc}
            />
          ) : (
            <>
              {adHocMode && (
                <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sm italic text-muted-foreground">
                  <FilePlus className="h-3.5 w-3.5" /> Ad-hoc paste (not saved)
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
                  if (id) onSelectInput(id);
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
                          aria-label={`Input actions for ${node.name}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem
                          onClick={() => {
                            const input = inputs.find((i) => i.id === id);
                            if (input) navigator.clipboard?.writeText(input.content).catch(() => {});
                          }}
                        >
                          <Copy className="mr-2 h-4 w-4" /> Copy content
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => deleteMutation.mutate(id)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  );
                }}
                ariaLabel="Test inputs"
              />
            </>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            bordered={false}
            placeholder="Paste text — treated as a new-issue description."
            className="min-h-(--sz-220px)"
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          {selectedInput && dirty && (
            <Button
              variant="outline"
              size="sm"
              disabled={updateMutation.isPending}
              onClick={() => updateMutation.mutate({ content: draft })}
            >
              Save changes
            </Button>
          )}
          <Button
            size="sm"
            disabled={!draft.trim()}
            onClick={() => setSaveDialogOpen(true)}
          >
            Save as input
          </Button>
        </div>
      </div>
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
          <DialogTitle>Save test input</DialogTitle>
          <DialogDescription>
            Runs snapshot input at run time — editing later won't change past runs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="input-name">Name</Label>
            <Input
              id="input-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="onboarding/happy-path"
            />
            <p className="text-xs text-muted-foreground">Use “/” for folders, e.g. onboarding/happy-path</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="input-content">Content</Label>
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
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || !content.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Right — agent picker + Run + history + detail
// ---------------------------------------------------------------------------

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
  const skillId = skill.id;
  const queryClient = useQueryClient();
  const onError = useMutationErrorToast();

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const agents = agentsQuery.data ?? [];
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

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

  const createRunMutation = useMutation({
    mutationFn: () =>
      companySkillsApi.createTestRun(companyId, skillId, {
        agentId: selectedAgentId!,
        inputId: adHocMode ? null : selectedInput?.id ?? null,
        content: adHocMode ? adHocContent : selectedInput ? null : adHocContent,
      }),
    onSuccess: (run) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testRuns(companyId, skillId, filterInputId),
      });
      onSelectRun(run.id);
    },
    onError: onError("Couldn't start run"),
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
      title="Test runs"
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
                <Button size="sm" disabled={gate.disabled || createRunMutation.isPending} onClick={() => createRunMutation.mutate()}>
                  <Play className="mr-1.5 h-3.5 w-3.5" /> Run
                </Button>
              </span>
            </TooltipTrigger>
            {gate.reason && <TooltipContent side="bottom">{gate.reason}</TooltipContent>}
          </Tooltip>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {filterInput && (
          <div className="px-3 pt-2">
            <FilterBar
              filters={[{ key: "input", label: "Input", value: filterInput.name }]}
              onRemove={onClearFilter}
              onClear={onClearFilter}
            />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {runsQuery.isLoading ? (
            <div className="text-xs text-muted-foreground">Loading runs…</div>
          ) : runs.length === 0 ? (
            <EmptyState icon={FlaskConical} message="No test runs yet. Pick an agent and Run." />
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
    </PaneScaffold>
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
  const agent = agents.find((a) => a.id === run.agentId) ?? null;
  const removed = !agent;
  const snapshotName =
    (run.agentConfigSnapshot?.name as string | undefined) ?? "Agent";
  const name = agent?.name ?? snapshotName;
  return (
    <EntityRow
      leading={<StatusBadge status={runBadgeStatus(run.status)} />}
      identifier={runShortId(run)}
      title={removed ? `${name} (removed)` : name}
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
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          {selectedAgent ? (
            <Identity name={selectedAgent.name} size="xs" />
          ) : (
            <span className="text-muted-foreground">Pick an agent</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search agents…" />
          <CommandList>
            <CommandEmpty>No agents.</CommandEmpty>
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
                    <Identity name={agent.name} size="xs" />
                    {!selectable && (
                      <Badge variant="secondary" className="ml-auto">
                        Paused
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
    onError: onError("Couldn't cancel run"),
  });

  // Re-run reproduces the VIEWED run's snapshots — pinned skill version, saved
  // input (or the ad-hoc snapshot), and agent — rather than whatever the picker
  // happens to hold this session (PAP-13001 Bug A). Reading detailQuery.data at
  // mutate() time keeps the hook order stable across the loading guards below.
  const reRunMutation = useMutation({
    mutationFn: () => {
      const d = detailQuery.data;
      if (!d) throw new Error("Run details are still loading.");
      return companySkillsApi.createTestRun(companyId, skillId, buildReRunRequest(d));
    },
    onSuccess: (run) => {
      queryClient.invalidateQueries({
        queryKey: ["company-skills", companyId, skillId, "test-runs"],
      });
      onSelectRun(run.id);
    },
    onError: onError("Couldn't re-run"),
  });

  const deleteMutation = useMutation({
    mutationFn: () => companySkillsApi.deleteTestRun(companyId, skillId, runId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["company-skills", companyId, skillId, "test-runs"],
      });
      onSelectRun(null);
    },
    onError: onError("Couldn't delete run"),
  });

  if (detailQuery.isLoading) {
    return (
      <PaneScaffold title="Run" action={<BackButton onBack={onBack} />}>
        <div className="p-3 text-xs text-muted-foreground">Loading run…</div>
      </PaneScaffold>
    );
  }
  const detail = detailQuery.data;
  if (!detail) {
    return (
      <PaneScaffold title="Run" action={<BackButton onBack={onBack} />}>
        <div className="p-3 text-xs text-muted-foreground">Run not found.</div>
      </PaneScaffold>
    );
  }

  const agent = agents.find((a) => a.id === detail.agentId) ?? null;
  const agentName =
    agent?.name ?? (detail.agentConfigSnapshot?.name as string | undefined) ?? "Agent";
  const removed = !agent;
  const outputMode = runOutputMode(detail);
  const nonTerminal = !isTerminalRunStatus(detail.status);
  const taskLink = testTaskLinkState(detail);

  return (
    <PaneScaffold title="Run" action={<BackButton onBack={onBack} />}>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={runBadgeStatus(detail.status)} />
          <Identity name={agentName} size="xs" />
          {removed && <Badge variant="secondary">removed</Badge>}
          <span className="font-mono text-xs text-muted-foreground">
            v{detail.skillVersion.revisionNumber}
          </span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {formatCents(detail.cost.costCents)}
          </span>
        </div>

        {/* snapshot property block */}
        <div className="rounded-md border border-border text-xs">
          <PropRow label="Input" value={detail.inputId ? "saved input" : "ad-hoc paste"} />
          <PropRow label="Skill version" value={`v${detail.skillVersion.revisionNumber}`} />
          <PropRow label="Created" value={relativeTime(detail.createdAt)} />
        </div>

        {showRunErrorCard(detail.status) && (
          <Card className="border-destructive/50">
            <CardHeader className="flex-row items-center gap-2 space-y-0 pb-2">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
              <span className="text-sm font-medium">Run failed</span>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {detail.error ?? "The test task ended with an error."}
            </CardContent>
          </Card>
        )}

        {/* Output / draft-at-failure */}
        {outputMode === "output" || outputMode === "draft" ? (
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {outputMode === "draft" ? "Draft at failure" : "Output"}
            </h3>
            <div className="rounded-md border border-border p-3">
              <MarkdownBody>{detail.outputBody || "_No output_"}</MarkdownBody>
            </div>
          </section>
        ) : outputMode === "pending" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> Working… output will appear here.
          </div>
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

        {/* Artifacts */}
        {detail.artifacts.length > 0 && (
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Artifacts
            </h3>
            <div className="space-y-1 rounded-md border border-border p-1">
              {detail.artifacts.map((a) => (
                <EntityRow key={a.id} title={a.title} subtitle={a.summary ?? a.kind} />
              ))}
            </div>
          </section>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={reRunMutation.isPending}
            onClick={() => reRunMutation.mutate()}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Re-run
          </Button>
          {nonTerminal ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              Cancel
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
            </Button>
          )}
          {taskLink.enabled && detail.harnessIssue ? (
            <Button variant="link" size="sm" asChild>
              <Link to={`/issues/${detail.harnessIssue.id}`}>Open test task ↗</Link>
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-not-allowed text-xs text-muted-foreground">
                  Open test task ↗
                </span>
              </TooltipTrigger>
              <TooltipContent>{taskLink.reason}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </PaneScaffold>
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
  const harnessIssueId = detail.harnessIssue?.id ?? null;
  const hasInlineAnswerable = detail.interactions.some((i) => isInteractionAnswerable(i));

  // Only fetch the full interaction objects (needed to render answerable cards)
  // when there is at least one pending inline interaction on a live harness issue.
  const fullQuery = useQuery({
    queryKey: ["skill-studio", "interactions", harnessIssueId],
    queryFn: () => issuesApi.listInteractions(harnessIssueId!),
    enabled: Boolean(harnessIssueId && hasInlineAnswerable),
    refetchInterval: hasInlineAnswerable ? POLL_MS : false,
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
        Interactions
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
                    <Link to={`/issues/${harnessIssueId}`}>Open test task ↗</Link>
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
    mutationFn: async (version: CompanySkillVersion) => {
      // Restore = write each file from the chosen version back, then cut a new
      // head version (immutability: never rewrites history).
      for (const file of version.fileInventory) {
        await companySkillsApi.updateFile(companyId, skillId, file.path, file.content);
      }
      return companySkillsApi.createVersion(companyId, skillId, {
        label: `Restore of v${version.revisionNumber}`,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.versions(companyId, skillId) });
      onRestored();
    },
  });

  const left = versions.find((v) => v.id === leftId) ?? null;
  const right = versions.find((v) => v.id === rightId) ?? null;
  const diff = left && right ? buildLineDiff(
    left.fileInventory.map((f) => `# ${f.path}\n${f.content}`).join("\n\n"),
    right.fileInventory.map((f) => `# ${f.path}\n${f.content}`).join("\n\n"),
  ) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-full sm:max-w-(--sz-560px)">
        <SheetHeader>
          <SheetTitle>Version history</SheetTitle>
        </SheetHeader>
        <div className="mt-3 space-y-2 overflow-auto">
          {versionsQuery.isLoading ? (
            <div className="text-xs text-muted-foreground">Loading versions…</div>
          ) : versions.length === 0 ? (
            <EmptyState icon={History} message="No versions yet. Save changes to create the first." />
          ) : (
            <div className="space-y-1 rounded-md border border-border p-1">
              {versions.map((v) => (
                <EntityRow
                  key={v.id}
                  identifier={`v${v.revisionNumber}`}
                  title={v.label ?? `Version ${v.revisionNumber}`}
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
                      disabled={restore.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        restore.mutate(v);
                      }}
                    >
                      Restore as v{(skill.currentVersion?.revisionNumber ?? v.revisionNumber) + 1}
                    </Button>
                  }
                />
              ))}
            </div>
          )}
          {diff && (
            <div className="rounded-md border border-border">
              <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                Diff v{left?.revisionNumber} → v{right?.revisionNumber}
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
  return (
    <Button variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Back
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
  return (
    <Tabs defaultValue="skill" className="flex flex-1 flex-col">
      <TabsList variant="line" className="px-3">
        <TabsTrigger value="skill">Skill</TabsTrigger>
        <TabsTrigger value="input">Input</TabsTrigger>
        <TabsTrigger value="runs">Runs</TabsTrigger>
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
