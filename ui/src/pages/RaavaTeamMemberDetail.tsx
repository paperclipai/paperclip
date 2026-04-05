import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDate, formatCents, agentRouteRef } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  Circle,
  Clock,
  Send,
  ChevronDown,
  ChevronRight,
  Bold,
  Italic,
  List,
  ListOrdered,
  Heading,
  AlertTriangle,
  Eye,
  EyeOff,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import {
  isUuidLike,
  AGENT_ROLE_LABELS,
  type AgentDetail as AgentDetailRecord,
  type Issue,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

type TabId = "overview" | "tasks" | "work-history" | "personality" | "chat" | "settings";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "tasks", label: "Tasks" },
  { id: "work-history", label: "Work History" },
  { id: "personality", label: "Personality" },
  { id: "chat", label: "Chat" },
  { id: "settings", label: "Settings" },
];

// ---------------------------------------------------------------------------
// Avatar colors (reused from Agents page)
// ---------------------------------------------------------------------------

const AVATAR_COLORS = [
  { bg: "rgba(34,74,232,0.15)", text: "#224ae8" },
  { bg: "rgba(113,110,255,0.15)", text: "#716eff" },
  { bg: "rgba(73,92,244,0.15)", text: "#495cf4" },
  { bg: "rgba(140,51,217,0.15)", text: "#8c33d9" },
  { bg: "rgba(229,140,26,0.15)", text: "#e58c1a" },
  { bg: "rgba(26,166,153,0.15)", text: "#1aa699" },
];

function getAvatarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function mapStatusLabel(status: string): { label: string; dotClass: string } {
  switch (status) {
    case "active":
    case "running":
      return { label: "Working", dotClass: "bg-emerald-500" };
    case "idle":
      return { label: "Idle", dotClass: "bg-gray-400" };
    case "paused":
      return { label: "Paused", dotClass: "bg-amber-500" };
    case "error":
      return { label: "Needs Attention", dotClass: "bg-red-500" };
    default:
      return { label: status, dotClass: "bg-gray-400" };
  }
}

function mapIssueStatusToFilter(status: string): "completed" | "in_progress" | "waiting" {
  if (status === "done") return "completed";
  if (status === "in_progress" || status === "in_review") return "in_progress";
  return "waiting";
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

// TODO: Replace with real chat API when available
const MOCK_CHAT_MESSAGES = [
  { id: "1", sender: "agent", text: "I've started working on the lead follow-ups from yesterday's list.", ts: "10:32 AM" },
  { id: "2", sender: "user", text: "Great. Prioritize the ones from the eMerge Americas event first.", ts: "10:33 AM" },
  { id: "3", sender: "agent", text: "Got it. I found 12 leads from eMerge. I'll draft personalized follow-ups for each. Want me to send them directly or queue for your review?", ts: "10:34 AM" },
  { id: "4", sender: "user", text: "Queue them for review. I want to check the messaging before they go out.", ts: "10:35 AM" },
  { id: "5", sender: "agent", text: "Understood. I'll have all 12 drafts ready within the next 15 minutes. I'll tag each with the lead's company name for easy scanning.", ts: "10:36 AM" },
];

// TODO: Replace with real work history API when available
const MOCK_WORK_HISTORY = [
  { id: "1", date: "Apr 3, 2026 — 10:32 AM", task: "Follow up on eMerge leads", duration: "23m", outcome: "completed" as const, cost: "$2.40" },
  { id: "2", date: "Apr 3, 2026 — 9:15 AM", task: "Draft weekly KPI summary", duration: "18m", outcome: "completed" as const, cost: "$1.85" },
  { id: "3", date: "Apr 2, 2026 — 4:48 PM", task: "Audit overdue tasks in Project Alpha", duration: "45m", outcome: "in_progress" as const, cost: "$4.60" },
  { id: "4", date: "Apr 2, 2026 — 2:10 PM", task: "Respond to support tickets batch #12", duration: "31m", outcome: "completed" as const, cost: "$3.20" },
  { id: "5", date: "Apr 2, 2026 — 11:00 AM", task: "Generate competitor analysis report", duration: "52m", outcome: "completed" as const, cost: "$5.40" },
  { id: "6", date: "Apr 1, 2026 — 3:30 PM", task: "Organize shared drive folders", duration: "15m", outcome: "completed" as const, cost: "$1.50" },
];

// TODO: Replace with real personality/instructions from agent config when API supports it
const MOCK_PERSONALITY = `You are a professional sales assistant. Your communication style is warm but concise. You focus on building genuine relationships with leads rather than pushing for immediate conversions.

## Core Principles
- **Always personalize** — Reference specific details from previous conversations
- **Be proactive** — Suggest follow-up actions before being asked
- **Stay organized** — Keep detailed notes on every lead interaction
- **Respect boundaries** — Never follow up more than twice without a response

## Tone Guidelines
Write in a professional yet approachable tone. Avoid jargon. Use short paragraphs and bullet points for clarity. Sign off with a warm but professional closing.`;

// ---------------------------------------------------------------------------
// Sub-components: Shared Header
// ---------------------------------------------------------------------------

function ProfileHeader({
  agent,
  onAssignTask,
  onPause,
  onRemove,
  isActionPending,
}: {
  agent: AgentDetailRecord;
  onAssignTask: () => void;
  onPause: () => void;
  onRemove: () => void;
  isActionPending?: boolean;
}) {
  const color = getAvatarColor(agent.name);
  const status = mapStatusLabel(agent.status);
  const initial = agent.name[0]?.toUpperCase() ?? "?";

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-4">
        {/* Avatar */}
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: color.bg }}
        >
          <span className="font-display text-2xl" style={{ color: color.text }}>
            {initial}
          </span>
        </div>

        {/* Name, role, status, hired date */}
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-[20px] text-foreground">{agent.name}</h1>
            <span className="rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {roleLabels[agent.role] ?? agent.role}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className={cn("h-2 w-2 rounded-full", status.dotClass)} />
              {status.label}
            </span>
            <span>Hired {formatDate(agent.createdAt)}</span>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button variant="gradient" size="sm" onClick={onAssignTask}>
          Assign Task
        </Button>
        <Button variant="outline" size="sm" onClick={onPause} disabled={isActionPending}>
          {agent.status === "paused" ? "Resume" : "Pause"}
        </Button>
        <button
          className="px-3 py-1.5 text-[13px] font-medium text-red-500 hover:text-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onRemove}
          disabled={isActionPending}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function TabBar({
  activeTab,
  onTabChange,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-border">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            "px-4 py-2.5 text-[13px] font-medium transition-colors border-b-2 -mb-px",
            activeTab === tab.id
              ? "border-[#224ae8] text-foreground font-semibold"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview Tab (Figma Screen 11)
// ---------------------------------------------------------------------------

function OverviewTab({
  agent,
  issues,
}: {
  agent: AgentDetailRecord;
  issues: Issue[];
}) {
  const completedIssues = issues.filter((i) => i.status === "done");
  const completedThisMonth = completedIssues.filter((i) => {
    if (!i.completedAt) return false;
    const d = new Date(i.completedAt);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const successRate = issues.length > 0
    ? Math.round((completedIssues.length / issues.length) * 100)
    : null;
  const currentTask = issues.find((i) => i.status === "in_progress");

  // TODO: Replace with real average task time from analytics API
  const avgTaskTime: number | null = null;

  // TODO: Replace with real monthly cost from billing API
  const monthlyCost = formatCents(agent.spentMonthlyCents ?? 0);

  return (
    <div className="space-y-6">
      {/* Current Task */}
      {currentTask && (
        <div className="raava-card bg-white px-6 py-5 dark:bg-card">
          <h3 className="text-[13px] font-semibold text-muted-foreground mb-2">
            Current Task
          </h3>
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-medium text-foreground">
              {currentTask.title}
            </span>
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-[#224ae8]" />
              <span className="text-[13px] text-[#224ae8] font-medium">In Progress</span>
            </div>
          </div>
          {/* Blue progress indicator */}
          <div className="mt-3 h-1 w-full rounded-full bg-secondary">
            <div
              className="h-1 rounded-full"
              style={{ width: "65%", background: "linear-gradient(90deg, #224AE8, #716EFF)" }}
            />
          </div>
        </div>
      )}

      {/* Performance Stats — 4 cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Tasks Completed", value: issues.length > 0 ? completedIssues.length : "\u2014" },
          { label: "This Month", value: issues.length > 0 ? completedThisMonth.length : "\u2014" },
          { label: "Success Rate", value: successRate != null ? `${successRate}%` : "\u2014" },
          { label: "Avg Task Time", value: avgTaskTime != null ? `${avgTaskTime} min` : "\u2014" },
        ].map((stat) => (
          <div key={stat.label} className="raava-card bg-white px-5 py-4 dark:bg-card">
            <p className="font-display text-[28px] text-foreground">
              {stat.value}
            </p>
            <p className="text-[12px] text-muted-foreground mt-1">
              {stat.label}
            </p>
          </div>
        ))}
      </div>

      {/* This Month's Cost */}
      <div className="raava-card bg-white px-6 py-5 dark:bg-card">
        <h3 className="text-[13px] font-semibold text-muted-foreground mb-1">
          This Month&apos;s Cost
        </h3>
        <div className="flex items-baseline gap-2">
          <span className="raava-gradient-text font-display text-[32px]">
            {monthlyCost}
          </span>
          {/* TODO: Replace with real trend data */}
          <span className="text-sm font-medium text-red-500">+12%</span>
        </div>
      </div>

      {/* Tools & Skills */}
      <div className="raava-card bg-white px-6 py-5 dark:bg-card">
        <h3 className="text-[13px] font-semibold text-muted-foreground mb-3">
          Tools & Skills
        </h3>
        <div className="flex flex-wrap gap-2">
          {/* TODO: Pull real skills from agent capabilities or skills API */}
          {["Email", "CRM", "Document Drafting", "Data Analysis", "Web Search"].map((skill) => (
            <span
              key={skill}
              className="rounded-full bg-secondary px-3.5 py-1.5 text-[12px] font-medium text-foreground"
            >
              {skill}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks Tab (Figma Screen 12)
// ---------------------------------------------------------------------------

type TaskFilter = "all" | "completed" | "in_progress" | "waiting";

function TasksTab({ issues }: { issues: Issue[] }) {
  const [filter, setFilter] = useState<TaskFilter>("all");

  const filtered = useMemo(() => {
    if (filter === "all") return issues;
    return issues.filter((i) => mapIssueStatusToFilter(i.status) === filter);
  }, [issues, filter]);

  const filters: { value: TaskFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "completed", label: "Completed" },
    { value: "in_progress", label: "In Progress" },
    { value: "waiting", label: "Waiting" },
  ];

  return (
    <div className="space-y-4">
      {/* Filter row */}
      <div className="flex items-center gap-1">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors",
              filter === f.value
                ? "bg-foreground text-background"
                : "bg-secondary text-muted-foreground hover:bg-accent/50",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Task list */}
      <div className="raava-card bg-white dark:bg-card overflow-hidden">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No tasks match the selected filter.
          </p>
        ) : (
          filtered.map((issue, idx) => {
            const isLast = idx === filtered.length - 1;
            const statusType = mapIssueStatusToFilter(issue.status);
            return (
              <Link
                key={issue.id}
                to={`/issues/${issue.identifier ?? issue.id}`}
                className={cn(
                  "flex items-center gap-3 px-5 py-3.5 hover:bg-accent/30 transition-colors no-underline text-inherit",
                  !isLast && "border-b border-border",
                )}
              >
                {/* Status icon */}
                {statusType === "completed" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                ) : statusType === "in_progress" ? (
                  <Circle className="h-4 w-4 text-[#224ae8] fill-[#224ae8]/20 shrink-0" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground shrink-0" />
                )}

                {/* Task title */}
                <span className="text-[13px] font-medium text-foreground flex-1 truncate">
                  {issue.title}
                </span>

                {/* Timestamp */}
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {formatDate(issue.updatedAt)}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Work History Tab (Figma Screen 13)
// ---------------------------------------------------------------------------

function WorkHistoryTab() {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="raava-card bg-white dark:bg-card overflow-hidden">
      {MOCK_WORK_HISTORY.map((entry, idx) => {
        const isLast = idx === MOCK_WORK_HISTORY.length - 1;
        const isExpanded = expandedId === entry.id;
        return (
          <div
            key={entry.id}
            className={cn(!isLast && "border-b border-border")}
          >
            <div className="flex items-center justify-between px-5 py-3.5">
              <div className="flex items-center gap-4 min-w-0">
                <span className="text-[11px] text-muted-foreground shrink-0 w-[160px]">
                  {entry.date}
                </span>
                <span className="text-[13px] font-medium text-foreground truncate">
                  {entry.task}
                </span>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <span className="text-[12px] text-muted-foreground">{entry.duration}</span>
                <span
                  className={cn(
                    "rounded-xl px-2.5 py-0.5 text-[11px] font-medium",
                    entry.outcome === "completed"
                      ? "bg-emerald-500/10 text-emerald-500"
                      : "bg-[rgba(34,74,232,0.1)] text-[#224ae8]",
                  )}
                >
                  {entry.outcome === "completed" ? "Completed" : "In Progress"}
                </span>
                <span className="text-[12px] font-medium text-foreground w-[60px] text-right">
                  {entry.cost}
                </span>
                <button
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {isExpanded ? "Hide" : "View work log"}
                </button>
              </div>
            </div>
            {isExpanded && (
              <div className="px-5 pb-4 pl-[180px]">
                {/* TODO: Replace with real work log data from runs API */}
                <p className="text-[12px] text-muted-foreground bg-secondary/50 rounded-lg p-3">
                  Work log details will be displayed here when the work history API is available.
                  This will include step-by-step actions, tool usage, and intermediate outputs.
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Personality Tab (Figma Screen 14)
// ---------------------------------------------------------------------------

function PersonalityTab() {
  // Personality editing is read-only until the instructions API is available
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">
        This guides how your team member thinks, communicates, and approaches tasks.
      </p>

      {/* Toolbar (disabled — read-only) */}
      <div className="raava-card bg-white dark:bg-card overflow-hidden">
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          <button disabled className="p-1.5 rounded text-muted-foreground/40 cursor-not-allowed">
            <Bold className="h-4 w-4" />
          </button>
          <button disabled className="p-1.5 rounded text-muted-foreground/40 cursor-not-allowed">
            <Italic className="h-4 w-4" />
          </button>
          <div className="w-px h-5 bg-border mx-1" />
          <button disabled className="p-1.5 rounded text-muted-foreground/40 cursor-not-allowed">
            <List className="h-4 w-4" />
          </button>
          <button disabled className="p-1.5 rounded text-muted-foreground/40 cursor-not-allowed">
            <ListOrdered className="h-4 w-4" />
          </button>
          <div className="w-px h-5 bg-border mx-1" />
          <button disabled className="p-1.5 rounded text-muted-foreground/40 cursor-not-allowed">
            <Heading className="h-4 w-4" />
          </button>
        </div>

        <textarea
          readOnly
          value={MOCK_PERSONALITY}
          className="w-full min-h-[320px] px-5 py-4 text-[13px] text-foreground bg-transparent resize-y focus:outline-none leading-relaxed cursor-default"
          placeholder="Describe this team member's personality, communication style, and approach to work..."
        />
      </div>

      {/* Action row — disabled with "Coming soon" tooltip */}
      <div className="flex items-center gap-3">
        <Button variant="gradient" size="sm" disabled title="Coming soon">
          Save Changes
        </Button>
        <button
          disabled
          title="Coming soon"
          className="text-[13px] text-muted-foreground/50 cursor-not-allowed"
        >
          Reset to Default
        </button>
        <span className="text-[11px] text-muted-foreground italic">Coming soon</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat Tab (Figma Screen 31)
// ---------------------------------------------------------------------------

function ChatTab({ agentName }: { agentName: string }) {
  return (
    <div className="raava-card bg-white dark:bg-card flex flex-col" style={{ height: "500px" }}>
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {MOCK_CHAT_MESSAGES.map((msg) => {
          const isUser = msg.sender === "user";
          return (
            <div
              key={msg.id}
              className={cn(
                "flex",
                isUser ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[70%] rounded-2xl px-4 py-2.5",
                  isUser
                    ? "text-white text-[13px]"
                    : "bg-secondary text-foreground text-[13px]",
                )}
                style={
                  isUser
                    ? { background: "linear-gradient(135deg, #224AE8, #716EFF)" }
                    : undefined
                }
              >
                <p className="leading-relaxed">{msg.text}</p>
                <p
                  className={cn(
                    "text-[10px] mt-1",
                    isUser ? "text-white/70" : "text-muted-foreground",
                  )}
                >
                  {msg.ts}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Input area — disabled until chat API is available */}
      <div className="border-t border-border px-4 py-3 flex items-center gap-3">
        <input
          type="text"
          readOnly
          placeholder={`Message ${agentName}... (Coming soon)`}
          className="flex-1 bg-secondary rounded-lg px-4 py-2.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none cursor-not-allowed opacity-60"
        />
        <Button
          variant="gradient"
          size="sm"
          disabled
          title="Coming soon"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings Tab (Figma Screen 37)
// ---------------------------------------------------------------------------

function SettingsTab({ agent }: { agent: AgentDetailRecord }) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [showApiKey, setShowApiKey] = useState(false);
  // Read-only permission state — persistence not yet wired
  const permissions = {
    canCreateAgents: agent.permissions.canCreateAgents,
    canAssignTasks: agent.access.canAssignTasks,
    canAccessInternet: true,
    canSendEmails: true,
  };
  // Read-only budget limit display
  const monthlyLimit =
    agent.budgetMonthlyCents > 0 ? (agent.budgetMonthlyCents / 100).toString() : "500";

  function toggleSection(section: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }

  const sections = [
    {
      id: "engine",
      title: "Engine Configuration",
      badge: "Advanced",
      content: (
        <div className="space-y-3 text-[13px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Adapter</span>
            <span className="font-medium text-foreground">{agent.adapterType}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Model</span>
            <span className="font-medium text-foreground">
              {(agent.adapterConfig?.model as string) ?? "Default"}
            </span>
          </div>
        </div>
      ),
    },
    {
      id: "api-keys",
      title: "API Keys",
      content: (
        <div className="space-y-3 text-[13px]">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Agent API Key</span>
            <div className="flex items-center gap-2">
              <code className="bg-secondary px-2 py-0.5 rounded text-[11px] font-mono">
                {showApiKey ? "sk-agent-xxxx-xxxx-xxxx" : "sk-agent-****-****-****"}
              </code>
              <button
                onClick={() => setShowApiKey(!showApiKey)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "budget",
      title: "Budget & Spending Limits",
      content: (
        <div className="space-y-3 text-[13px]">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Monthly Limit</span>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">$</span>
              <input
                type="text"
                value={monthlyLimit}
                readOnly
                title="Coming soon"
                className="w-20 bg-secondary rounded px-2 py-1 text-[12px] text-foreground focus:outline-none cursor-default"
              />
            </div>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Spent This Month</span>
            <span className="font-medium text-foreground">{formatCents(agent.spentMonthlyCents)}</span>
          </div>
        </div>
      ),
    },
    {
      id: "permissions",
      title: "Permissions",
      content: (
        <div className="space-y-3 text-[13px]">
          {(
            [
              { key: "canCreateAgents" as const, label: "Can create agents" },
              { key: "canAssignTasks" as const, label: "Can assign tasks" },
              { key: "canAccessInternet" as const, label: "Can access internet" },
              { key: "canSendEmails" as const, label: "Can send emails" },
            ] as const
          ).map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-muted-foreground">{label}</span>
              <span className="cursor-not-allowed opacity-60" title="Coming soon">
                {permissions[key] ? (
                  <ToggleRight className="h-6 w-6 text-[#224ae8]" />
                ) : (
                  <ToggleLeft className="h-6 w-6 text-muted-foreground" />
                )}
              </span>
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {sections.map((section) => {
        const isExpanded = expandedSections.has(section.id);
        return (
          <div key={section.id} className="raava-card bg-white dark:bg-card overflow-hidden">
            <button
              onClick={() => toggleSection(section.id)}
              className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-accent/30 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-medium text-foreground">{section.title}</span>
                {"badge" in section && section.badge && (
                  <span className="rounded-full bg-[rgba(34,74,232,0.1)] px-2 py-0.5 text-[10px] font-medium text-[#224ae8]">
                    {section.badge}
                  </span>
                )}
              </div>
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            {isExpanded && (
              <div className="px-5 pb-4 border-t border-border pt-3">
                {section.content}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function RaavaTeamMemberDetail() {
  const { companyPrefix, agentId, tab: urlTab, runId: urlRunId } = useParams<{
    companyPrefix?: string;
    agentId: string;
    tab?: string;
    runId?: string;
  }>();
  const { companies, selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  // Resolve the active tab — honour URL param when present
  const validTabs: TabId[] = ["overview", "tasks", "work-history", "personality", "chat", "settings"];
  const initialTab: TabId = urlTab && validTabs.includes(urlTab as TabId) ? (urlTab as TabId) : "overview";
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);

  const routeAgentRef = agentId ?? "";

  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((c) => c.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);

  // If a company prefix was provided in the route, only use the resolved company
  // — do NOT fall back to selectedCompanyId to avoid cross-tenant fetches.
  const lookupCompanyId = companyPrefix ? routeCompanyId ?? undefined : selectedCompanyId ?? undefined;
  const canFetchAgent = routeAgentRef.length > 0 && (isUuidLike(routeAgentRef) || Boolean(lookupCompanyId));

  // ---- Data Queries ----

  const { data: agent, isLoading, error } = useQuery<AgentDetailRecord>({
    queryKey: [...queryKeys.agents.detail(routeAgentRef), lookupCompanyId ?? null],
    queryFn: () => agentsApi.get(routeAgentRef, lookupCompanyId),
    enabled: canFetchAgent,
  });

  const resolvedCompanyId = agent?.companyId ?? selectedCompanyId;
  const canonicalAgentRef = agent ? agentRouteRef(agent) : routeAgentRef;
  const resolvedAgentId = agent?.id ?? null;

  const { data: allIssues } = useQuery({
    queryKey: [...queryKeys.issues.list(resolvedCompanyId!), "participant-agent", resolvedAgentId ?? "__none__"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { participantAgentId: resolvedAgentId! }),
    enabled: !!resolvedCompanyId && !!resolvedAgentId,
  });

  const issues = useMemo(
    () =>
      (allIssues ?? []).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [allIssues],
  );

  // ---- Agent Actions ----

  const agentAction = useMutation({
    mutationFn: async (action: "pause" | "resume" | "terminate") => {
      if (!agent) return Promise.reject(new Error("No agent"));
      const ref = agent.id ?? routeAgentRef;
      switch (action) {
        case "pause":
          return agentsApi.pause(ref, resolvedCompanyId ?? undefined);
        case "resume":
          return agentsApi.resume(ref, resolvedCompanyId ?? undefined);
        case "terminate":
          return agentsApi.terminate(ref, resolvedCompanyId ?? undefined);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
    onError: (err) => {
      pushToast({
        title: "Action failed",
        body: err instanceof Error ? err.message : "Could not complete agent action.",
        tone: "error",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
    },
  });

  // ---- Breadcrumbs ----

  useEffect(() => {
    const name = agent?.name ?? routeAgentRef ?? "Team Member";
    setBreadcrumbs([
      { label: "My Team", href: "/agents" },
      { label: name },
    ]);
  }, [setBreadcrumbs, agent, routeAgentRef]);

  // ---- Render ----

  if (isLoading) return <PageSkeleton variant="detail" />;

  if (error) {
    return (
      <div className="raava-card bg-destructive/5 p-6 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-destructive mb-2" />
        <p className="text-sm font-medium text-destructive">
          Failed to load team member
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {error instanceof Error ? error.message : "An unexpected error occurred."}
        </p>
      </div>
    );
  }

  if (!agent) return null;

  return (
    <div className="space-y-6">
      {/* Breadcrumb (visual — framework breadcrumbs set above) */}
      <div className="flex items-center gap-1.5 text-[13px]">
        <Link
          to="/agents"
          className="text-[#224ae8] hover:underline no-underline font-medium"
        >
          My Team
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-foreground font-medium">{agent.name}</span>
      </div>

      {/* Profile Header */}
      <ProfileHeader
        agent={agent}
        onAssignTask={() => openNewIssue({ assigneeAgentId: agent.id })}
        onPause={() =>
          agentAction.mutate(agent.status === "paused" ? "resume" : "pause")
        }
        onRemove={() => agentAction.mutate("terminate")}
        isActionPending={agentAction.isPending}
      />

      {/* Tab Bar */}
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Tab Content */}
      <div>
        {activeTab === "overview" && (
          <OverviewTab agent={agent} issues={issues} />
        )}
        {activeTab === "tasks" && <TasksTab issues={issues} />}
        {activeTab === "work-history" && <WorkHistoryTab />}
        {activeTab === "personality" && <PersonalityTab />}
        {activeTab === "chat" && <ChatTab agentName={agent.name} />}
        {activeTab === "settings" && <SettingsTab agent={agent} />}
      </div>
    </div>
  );
}
