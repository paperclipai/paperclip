import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Maximize2,
  Minimize2,
  Target,
  Calendar,
  Plus,
  X,
  HelpCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PROJECT_COLORS } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { StatusBadge } from "./StatusBadge";
import { ChoosePathButton } from "./PathInstructionsModal";

const projectStatuses = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

export function NewProjectDialog() {
  const { newProjectOpen, closeNewProject } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("planned");
  const [goalIds, setGoalIds] = useState<string[]>([]);
  const [targetDate, setTargetDate] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [workspaceLocalPath, setWorkspaceLocalPath] = useState("");
  const [workspaceRepoUrl, setWorkspaceRepoUrl] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const [statusOpen, setStatusOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newProjectOpen,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newProjectOpen,
  });

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({
        id: `agent:${agent.id}`,
        name: agent.name,
        kind: "agent",
        agentId: agent.id,
        agentIcon: agent.icon,
      });
    }
    return options;
  }, [agents]);

  const createProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.create(selectedCompanyId!, data),
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(selectedCompanyId, file, "projects/drafts");
    },
  });

  function reset() {
    setName("");
    setDescription("");
    setStatus("planned");
    setGoalIds([]);
    setTargetDate("");
    setExpanded(false);
    setWorkspaceLocalPath("");
    setWorkspaceRepoUrl("");
    setWorkspaceError(null);
  }

  const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

  const looksLikeRepoUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") return false;
      const segments = parsed.pathname.split("/").filter(Boolean);
      return segments.length >= 2;
    } catch {
      return false;
    }
  };

  const deriveWorkspaceNameFromPath = (value: string) => {
    const normalized = value.trim().replace(/[\\/]+$/, "");
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? "Local folder";
  };

  const deriveWorkspaceNameFromRepo = (value: string) => {
    try {
      const parsed = new URL(value);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const repo = segments[segments.length - 1]?.replace(/\.git$/i, "") ?? "";
      return repo || "GitHub repo";
    } catch {
      return "GitHub repo";
    }
  };

  async function handleSubmit() {
    if (!selectedCompanyId || !name.trim()) return;
    const localPath = workspaceLocalPath.trim();
    const repoUrl = workspaceRepoUrl.trim();

    if (localPath && !isAbsolutePath(localPath)) {
      setWorkspaceError("Local folder must be a full absolute path.");
      return;
    }
    if (repoUrl && !looksLikeRepoUrl(repoUrl)) {
      setWorkspaceError("Repo must use a valid GitHub or GitHub Enterprise repo URL.");
      return;
    }

    setWorkspaceError(null);

    try {
      const created = await createProject.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        status,
        color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
        ...(goalIds.length > 0 ? { goalIds } : {}),
        ...(targetDate ? { targetDate } : {}),
      });

      if (localPath || repoUrl) {
        const workspacePayload: Record<string, unknown> = {
          name: localPath
            ? deriveWorkspaceNameFromPath(localPath)
            : deriveWorkspaceNameFromRepo(repoUrl),
          ...(localPath ? { cwd: localPath } : {}),
          ...(repoUrl ? { repoUrl } : {}),
        };
        await projectsApi.createWorkspace(created.id, workspacePayload);
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(created.id) });
      reset();
      closeNewProject();
    } catch {
      // surface through createProject.isError
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const selectedGoals = (goals ?? []).filter((g) => goalIds.includes(g.id));
  const availableGoals = (goals ?? []).filter((g) => !goalIds.includes(g.id));

  return (
    <Dialog
      open={newProjectOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewProject();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn("p-0 gap-0", expanded ? "sm:max-w-2xl" : "sm:max-w-lg")}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {selectedCompany && (
              <span className="bg-muted px-1.5 py-0.5 rounded text-xs font-medium">
                {selectedCompany.name.slice(0, 3).toUpperCase()}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>New project</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => { reset(); closeNewProject(); }}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        {/* Name */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
            }}
            autoFocus
          />
        </div>

        {/* Description */}
        <div className="px-4 pb-2">
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
            mentions={mentionOptions}
            contentClassName={cn("text-sm text-muted-foreground", expanded ? "min-h-[220px]" : "min-h-[120px]")}
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </div>

        <div className="px-4 pt-3 pb-3 space-y-3 border-t border-border">
          <div>
            <div className="mb-1 flex items-center gap-1.5">
              <label className="block text-xs text-muted-foreground">Repo URL</label>
              <span className="text-xs text-muted-foreground/50">optional</span>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3 w-3 text-muted-foreground/50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[240px] text-xs">
                  Link a GitHub repository so agents can clone, read, and push code for this project.
                </TooltipContent>
              </Tooltip>
            </div>
            <input
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
              value={workspaceRepoUrl}
              onChange={(e) => { setWorkspaceRepoUrl(e.target.value); setWorkspaceError(null); }}
              placeholder="https://github.com/org/repo"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center gap-1.5">
              <label className="block text-xs text-muted-foreground">Local folder</label>
              <span className="text-xs text-muted-foreground/50">optional</span>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3 w-3 text-muted-foreground/50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[240px] text-xs">
                  Set an absolute path on this machine where local agents will read and write files for this project.
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-2">
              <input
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                value={workspaceLocalPath}
                onChange={(e) => { setWorkspaceLocalPath(e.target.value); setWorkspaceError(null); }}
                placeholder="/absolute/path/to/workspace"
              />
              <ChoosePathButton />
            </div>
          </div>

          {workspaceError && (
            <p className="text-xs text-destructive">{workspaceError}</p>
          )}
        </div>

        {/* Property chips */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
          {/* Status */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <StatusBadge status={status} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="start">
              {projectStatuses.map((s) => (
                <button
                  key={s.value}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    s.value === status && "bg-accent"
                  )}
                  onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                >
                  {s.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {selectedGoals.map((goal) => (
            <span
              key={goal.id}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
            >
              <Target className="h-3 w-3 text-muted-foreground" />
              <span className="max-w-[160px] truncate">{goal.title}</span>
              <button
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setGoalIds((prev) => prev.filter((id) => id !== goal.id))}
                aria-label={`Remove goal ${goal.title}`}
                type="button"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}

          <Popover open={goalOpen} onOpenChange={setGoalOpen}>
            <PopoverTrigger asChild>
              <button
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors disabled:opacity-60"
                disabled={selectedGoals.length > 0 && availableGoals.length === 0}
              >
                {selectedGoals.length > 0 ? <Plus className="h-3 w-3 text-muted-foreground" /> : <Target className="h-3 w-3 text-muted-foreground" />}
                {selectedGoals.length > 0 ? "+ Goal" : "Goal"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="start">
              {selectedGoals.length === 0 && (
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground"
                  onClick={() => setGoalOpen(false)}
                >
                  No goal
                </button>
              )}
              {availableGoals.map((g) => (
                <button
                  key={g.id}
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 truncate"
                  onClick={() => {
                    setGoalIds((prev) => [...prev, g.id]);
                    setGoalOpen(false);
                  }}
                >
                  {g.title}
                </button>
              ))}
              {selectedGoals.length > 0 && availableGoals.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  All goals already selected.
                </div>
              )}
            </PopoverContent>
          </Popover>

          {/* Target date */}
          <div className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
            <Calendar className="h-3 w-3 text-muted-foreground" />
            <input
              type="date"
              className="bg-transparent outline-none text-xs w-24"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              placeholder="Target date"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          {createProject.isError ? (
            <p className="text-xs text-destructive">Failed to create project.</p>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            disabled={!name.trim() || createProject.isPending}
            onClick={handleSubmit}
          >
            {createProject.isPending ? "Creating…" : "Create project"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
