import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { Modal } from "@heroui/react";
import { Button } from "@heroui/react";
import { Popover } from "@heroui/react";
import { Tooltip } from "@heroui/react";
import {
  Maximize2,
  Minimize2,
  Target,
  Calendar,
  Plus,
  X,
  HelpCircle,
} from "lucide-react";
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
    <Modal.Backdrop
      isOpen={newProjectOpen}
      onOpenChange={(open: boolean) => {
        if (!open) {
          reset();
          closeNewProject();
        }
      }}
    >
      <Modal.Container size={expanded ? "lg" : "md"}>
        <Modal.Dialog>
          <div
            className="p-0 gap-0"
            onKeyDown={handleKeyDown}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-default-200/60">
              <div className="flex items-center gap-2 text-sm">
                {selectedCompany && (
                  <span className="bg-accent/15 text-accent px-2 py-0.5 rounded-md text-xs font-semibold tracking-wide">
                    {selectedCompany.name.slice(0, 3).toUpperCase()}
                  </span>
                )}
                <span className="text-foreground/30">/</span>
                <span className="text-foreground/60 font-medium">New project</span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  isIconOnly
                  size="sm"
                  className="text-foreground/40"
                  onPress={() => setExpanded(!expanded)}
                >
                  {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  isIconOnly
                  size="sm"
                  className="text-foreground/40"
                  onPress={() => { reset(); closeNewProject(); }}
                >
                  <span className="text-lg leading-none">&times;</span>
                </Button>
              </div>
            </div>

            {/* Name */}
            <div className="px-4 pt-4 pb-2 shrink-0">
              <input
                className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-foreground/50"
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
                contentClassName={cn("text-sm text-foreground/40", expanded ? "min-h-[220px]" : "min-h-[120px]")}
                imageUploadHandler={async (file) => {
                  const asset = await uploadDescriptionImage.mutateAsync(file);
                  return asset.contentPath;
                }}
              />
            </div>

            <div className="px-4 pt-3 pb-3 space-y-3 border-t border-default-200/70">
              <div>
                <div className="mb-1 flex items-center gap-1.5">
                  <label className="block text-xs text-foreground/40">Repo URL</label>
                  <span className="text-xs text-foreground/50">optional</span>
                  <Tooltip>
                    <Tooltip.Trigger>
                      <HelpCircle className="h-3 w-3 text-foreground/50 cursor-help" />
                    </Tooltip.Trigger>
                    <Tooltip.Content className="max-w-[240px] text-xs">
                      Link a GitHub repository so agents can clone, read, and push code for this project.
                    </Tooltip.Content>
                  </Tooltip>
                </div>
                <input
                  className="w-full rounded-lg border border-default-200/70 bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-accent/30 focus:ring-1 focus:ring-accent/10 transition-colors"
                  value={workspaceRepoUrl}
                  onChange={(e) => { setWorkspaceRepoUrl(e.target.value); setWorkspaceError(null); }}
                  placeholder="https://github.com/org/repo"
                />
              </div>

              <div>
                <div className="mb-1 flex items-center gap-1.5">
                  <label className="block text-xs text-foreground/40">Local folder</label>
                  <span className="text-xs text-foreground/50">optional</span>
                  <Tooltip>
                    <Tooltip.Trigger>
                      <HelpCircle className="h-3 w-3 text-foreground/50 cursor-help" />
                    </Tooltip.Trigger>
                    <Tooltip.Content className="max-w-[240px] text-xs">
                      Set an absolute path on this machine where local agents will read and write files for this project.
                    </Tooltip.Content>
                  </Tooltip>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    className="w-full rounded-lg border border-default-200/70 bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none focus:border-accent/30 focus:ring-1 focus:ring-accent/10 transition-colors"
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
            <div className="flex items-center gap-1.5 px-4 py-2 border-t border-default-200/70 flex-wrap">
              {/* Status */}
              <Popover isOpen={statusOpen} onOpenChange={setStatusOpen}>
                <Popover.Trigger>
                  <button className="inline-flex items-center gap-1.5 rounded-md border border-default-200/70 px-2 py-1 text-xs hover:bg-accent/[0.05] transition-colors">
                    <StatusBadge status={status} />
                  </button>
                </Popover.Trigger>
                <Popover.Content className="w-44 p-0">
                  <Popover.Dialog className="overflow-hidden rounded-xl border border-default-200/60 bg-overlay shadow-lg p-1.5">
                    {projectStatuses.map((s) => (
                      <button
                        key={s.value}
                        className={cn(
                          "flex items-center gap-2 w-full px-2.5 py-2 text-xs rounded-lg transition-colors",
                          s.value === status
                            ? "bg-accent/[0.08] text-accent font-medium"
                            : "text-foreground hover:bg-default/40"
                        )}
                        onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                      >
                        {s.label}
                      </button>
                    ))}
                  </Popover.Dialog>
                </Popover.Content>
              </Popover>

              {selectedGoals.map((goal) => (
                <span
                  key={goal.id}
                  className="inline-flex items-center gap-1 rounded-md border border-default-200/70 px-2 py-1 text-xs"
                >
                  <Target className="h-3 w-3 text-foreground/40" />
                  <span className="max-w-[160px] truncate">{goal.title}</span>
                  <button
                    className="text-foreground/40 hover:text-foreground"
                    onClick={() => setGoalIds((prev) => prev.filter((id) => id !== goal.id))}
                    aria-label={`Remove goal ${goal.title}`}
                    type="button"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}

              <Popover isOpen={goalOpen} onOpenChange={setGoalOpen}>
                <Popover.Trigger>
                  <button
                    className="inline-flex items-center gap-1.5 rounded-md border border-default-200/70 px-2 py-1 text-xs hover:bg-accent/[0.05] transition-colors disabled:opacity-60"
                    disabled={selectedGoals.length > 0 && availableGoals.length === 0}
                  >
                    {selectedGoals.length > 0 ? <Plus className="h-3 w-3 text-foreground/40" /> : <Target className="h-3 w-3 text-foreground/40" />}
                    {selectedGoals.length > 0 ? "+ Goal" : "Goal"}
                  </button>
                </Popover.Trigger>
                <Popover.Content className="w-56 p-0">
                  <Popover.Dialog className="overflow-hidden rounded-xl border border-default-200/60 bg-overlay shadow-lg p-1.5 max-h-56 overflow-y-auto">
                    {selectedGoals.length === 0 && (
                      <button
                        className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-lg hover:bg-default/40 text-foreground/40"
                        onClick={() => setGoalOpen(false)}
                      >
                        No goal
                      </button>
                    )}
                    {availableGoals.map((g) => (
                      <button
                        key={g.id}
                        className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-lg hover:bg-default/40 truncate"
                        onClick={() => {
                          setGoalIds((prev) => [...prev, g.id]);
                          setGoalOpen(false);
                        }}
                      >
                        {g.title}
                      </button>
                    ))}
                    {selectedGoals.length > 0 && availableGoals.length === 0 && (
                      <div className="px-2 py-1.5 text-xs text-foreground/40">
                        All goals already selected.
                      </div>
                    )}
                  </Popover.Dialog>
                </Popover.Content>
              </Popover>

              {/* Target date */}
              <div className="inline-flex items-center gap-1.5 rounded-md border border-default-200/70 px-2 py-1 text-xs">
                <Calendar className="h-3 w-3 text-foreground/40" />
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
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-default-200/70">
              {createProject.isError ? (
                <p className="text-xs text-destructive">Failed to create project.</p>
              ) : (
                <span />
              )}
              <Button
                variant="primary"
                size="sm"
                isDisabled={!name.trim() || createProject.isPending}
                onPress={() => void handleSubmit()}
              >
                {createProject.isPending ? "Creating…" : "Create project"}
              </Button>
            </div>
          </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
