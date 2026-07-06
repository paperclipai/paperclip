import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Loader2, FolderGit2, Bot } from "lucide-react";
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

// Nothing-OS console texture: faint radial dot-grid. Works in both themes since
// it mixes against --foreground (dark ink on light, light ink on dark).
const DOT_TEXTURE: React.CSSProperties = {
  backgroundImage:
    "radial-gradient(circle, color-mix(in oklab, var(--foreground) 6%, transparent) 1px, transparent 1px)",
  backgroundSize: "16px 16px",
};

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

  const contextPath = (
    selectedCompany?.issuePrefix ??
    selectedCompany?.name ??
    "paperclip"
  ).toLowerCase();

  return (
    <div className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-2xl flex-col items-center justify-center gap-9 px-4 py-12">
      {/* Header — Nothing-OS glyph title */}
      <div className="flex flex-col items-center gap-4 text-center">
        {/* Dot-matrix rule, faded at the edges */}
        <div
          aria-hidden
          className="h-2 w-36"
          style={{
            backgroundImage:
              "radial-gradient(circle, color-mix(in oklab, var(--foreground) 40%, transparent) 1px, transparent 1px)",
            backgroundSize: "8px 8px",
            backgroundPosition: "center",
            WebkitMaskImage:
              "linear-gradient(90deg, transparent, black 35%, black 65%, transparent)",
            maskImage: "linear-gradient(90deg, transparent, black 35%, black 65%, transparent)",
          }}
        />
        <div className="flex items-center gap-3">
          {/* Signature red glyph dot — the one spot of colour, Nothing-style */}
          <span className="relative flex h-2.5 w-2.5" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/60 motion-reduce:animate-none" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
          <h1 className="font-display text-3xl leading-none sm:text-[2.5rem]">Talk to the team</h1>
        </div>
        <p className="max-w-md font-mono text-[12px] leading-relaxed text-muted-foreground">
          Describe what you need — {selectedCompany?.name ?? "your team"} gets to work. This files a
          task and opens it.
        </p>
      </div>

      {/* Console — matte, flat, exposed dot-grid (Nothing OS, not frosted glass) */}
      <div className="w-full border border-border bg-card/90 transition-colors focus-within:border-foreground/40">
        {/* Status bar */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <span className="truncate font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {contextPath} <span className="text-muted-foreground/40">/</span> new_task
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <span className="h-1.5 w-1.5 bg-foreground/45" aria-hidden />
            ready
          </span>
        </div>

        {/* Task input */}
        <div className="relative" style={DOT_TEXTURE}>
          <span
            aria-hidden
            className="pointer-events-none absolute left-4 top-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
          >
            // task
          </span>
          <Textarea
            ref={textareaRef}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Task description"
            placeholder="e.g. Draft a launch plan for the new pricing page, then share it for review."
            className="min-h-[168px] resize-none rounded-none border-0 bg-transparent px-4 pb-4 pt-9 font-mono text-[13.5px] leading-relaxed shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
          />
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger
              size="sm"
              aria-label="Assign to agent"
              className="h-8 min-w-0 max-w-[13rem] gap-2 rounded-none border-border bg-transparent font-mono text-[11px] tracking-wide hover:border-foreground/40"
            >
              {assignedAgent ? (
                <span className="flex min-w-0 items-center gap-2">
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
            <SelectContent
              position="popper"
              align="start"
              sideOffset={6}
              className="rounded-none border-border bg-popover font-mono text-[12px] shadow-none backdrop-blur-none dark:bg-popover"
            >
              {selectableAgents.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No agents yet</div>
              ) : (
                selectableAgents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id} className="rounded-none">
                    <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate">{agent.name}</span>
                  </SelectItem>
                ))
              )}
              <SelectItem value={UNASSIGNED} className="rounded-none">
                <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                <span>Unassigned (triage later)</span>
              </SelectItem>
            </SelectContent>
          </Select>

          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger
              size="sm"
              aria-label="Choose project"
              className="h-8 min-w-0 max-w-[13rem] gap-2 rounded-none border-border bg-transparent font-mono text-[11px] tracking-wide hover:border-foreground/40"
            >
              <span className="flex min-w-0 items-center gap-2">
                <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
                <SelectValue placeholder="No project" />
              </span>
            </SelectTrigger>
            <SelectContent
              position="popper"
              align="start"
              sideOffset={6}
              className="rounded-none border-border bg-popover font-mono text-[12px] shadow-none backdrop-blur-none dark:bg-popover"
            >
              <SelectItem value={NO_PROJECT} className="rounded-none">
                No project
              </SelectItem>
              {activeProjects.map((project) => (
                <SelectItem key={project.id} value={project.id} className="rounded-none">
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:inline">
              ⌘↵ send
            </span>
            <Button
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="h-8 gap-2 rounded-none font-mono text-[11px] uppercase tracking-[0.14em]"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowRight className="h-3.5 w-3.5" />
              )}
              {submitting ? "Starting" : "Start task"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
