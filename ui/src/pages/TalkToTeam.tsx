import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare, Send, Loader2, FolderGit2, Bot } from "lucide-react";
import type { AgentStatus } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { AgentIcon } from "../components/AgentIconPicker";

const UNASSIGNED = "__unassigned__";
const NO_PROJECT = "__no_project__";

// Statuses that mean an agent is ready to pick up work; used to choose a sane
// default assignee (skips paused managed agents like the Wiki Maintainer).
const WORKING_STATUSES: ReadonlySet<AgentStatus> = new Set(["active", "idle", "running"]);

/** Derive a concise task title from the free-form message (first non-empty line). */
function deriveTitle(message: string): string {
  const firstLine =
    message
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const clean = firstLine.replace(/^#+\s*/, "");
  if (clean.length <= 120) return clean;
  return `${clean.slice(0, 117).trimEnd()}…`;
}

export function TalkToTeam() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [message, setMessage] = useState("");
  const [agentId, setAgentId] = useState<string>(UNASSIGNED);
  const [projectId, setProjectId] = useState<string>(NO_PROJECT);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Talk to the team" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const selectableAgents = useMemo(
    () => (agents ?? []).filter((agent) => agent.status !== "terminated"),
    [agents],
  );
  const activeProjects = useMemo(
    () => (projects ?? []).filter((project) => !project.archivedAt),
    [projects],
  );

  // Pre-select the first ready-to-work agent once the list loads, so the common
  // path (type a message, hit send) works without touching the picker.
  useEffect(() => {
    if (agentId !== UNASSIGNED) return;
    const preferred = selectableAgents.find((agent) => WORKING_STATUSES.has(agent.status));
    if (preferred) setAgentId(preferred.id);
  }, [selectableAgents, agentId]);

  const assignedAgent = useMemo(
    () => selectableAgents.find((agent) => agent.id === agentId) ?? null,
    [selectableAgents, agentId],
  );

  const canSubmit = !!selectedCompanyId && message.trim().length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit || !selectedCompanyId) return;
    setSubmitting(true);
    try {
      const description = message.trim();
      const payload: Record<string, unknown> = {
        title: deriveTitle(description),
        description,
      };
      // Assigning an agent flips the new issue to "todo" and wakes it; leaving it
      // unassigned files a backlog task the team can triage.
      if (agentId !== UNASSIGNED) payload.assigneeAgentId = agentId;
      if (projectId !== NO_PROJECT) payload.projectId = projectId;

      const issue = await issuesApi.create(selectedCompanyId, payload);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      navigate(`/issues/${issue.identifier ?? issue.id}`);
    } catch (error) {
      pushToast({
        tone: "error",
        title: "Could not start the task",
        body: error instanceof Error ? error.message : "Please try again.",
      });
      setSubmitting(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void handleSubmit();
    }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-2xl flex-col items-center justify-center gap-8 px-4 py-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <MessagesSquare className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Talk to the team</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Describe what you need and {selectedCompany?.name ?? "your team"} gets to work — this
            creates a task and opens it.
          </p>
        </div>
      </div>

      <div className="w-full overflow-hidden rounded-2xl border border-border bg-card shadow-sm focus-within:border-ring/60 focus-within:ring-[3px] focus-within:ring-ring/20 transition-[box-shadow,border-color]">
        <Textarea
          ref={textareaRef}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Draft a launch plan for the new pricing page, then share it for review."
          className="min-h-[132px] resize-none border-0 bg-transparent px-4 py-4 text-[15px] shadow-none focus-visible:ring-0"
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2.5">
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger size="sm" className="h-8 gap-2 rounded-lg" aria-label="Assign to agent">
              {assignedAgent ? (
                <span className="flex items-center gap-2">
                  <AgentIcon icon={assignedAgent.icon} className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="truncate">{assignedAgent.name}</span>
                </span>
              ) : (
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Bot className="h-3.5 w-3.5" />
                  <span>Unassigned</span>
                </span>
              )}
            </SelectTrigger>
            <SelectContent align="start">
              {selectableAgents.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No agents yet</div>
              ) : (
                selectableAgents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate">{agent.name}</span>
                  </SelectItem>
                ))
              )}
              <SelectItem value={UNASSIGNED}>
                <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                <span>Unassigned (triage later)</span>
              </SelectItem>
            </SelectContent>
          </Select>

          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger size="sm" className="h-8 gap-2 rounded-lg" aria-label="Choose project">
              <span className="flex items-center gap-2">
                <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
                <SelectValue placeholder="No project" />
              </span>
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value={NO_PROJECT}>No project</SelectItem>
              {activeProjects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-2.5">
            <span className="hidden text-[11px] text-muted-foreground sm:inline">⌘↵ to send</span>
            <Button size="sm" onClick={() => void handleSubmit()} disabled={!canSubmit} className="gap-1.5">
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {submitting ? "Starting…" : "Start task"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
