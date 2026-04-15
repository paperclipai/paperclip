import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { approvalsApi } from "../api/approvals";
import { activityApi } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { usePanel } from "../context/PanelContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { assigneeValueFromSelection, suggestedCommentAssigneeValue } from "../lib/assignees";
import { queryKeys } from "../lib/queryKeys";
import { readIssueDetailBreadcrumb } from "../lib/issueDetailBreadcrumb";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { relativeTime, cn, formatTokens, visibleRunCostUsd } from "../lib/utils";
import { InlineEditor } from "../components/InlineEditor";
import { CommentThread } from "../components/CommentThread";
import { IssueDocumentsSection } from "../components/IssueDocumentsSection";
import { IssueProperties } from "../components/IssueProperties";
import { LiveRunWidget } from "../components/LiveRunWidget";
import type { MentionOption } from "../components/MarkdownEditor";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity as ActivityIcon,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  EyeOff,
  Hexagon,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Repeat,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type { ActivityEvent } from "@paperclipai/shared";
import type { Agent, IssueAttachment, IssueWorkProduct } from "@paperclipai/shared";

type CommentReassignment = {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.comment_added": "added a comment",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.document_created": "created a document",
  "issue.document_updated": "updated a document",
  "issue.document_deleted": "deleted a document",
  "issue.deleted": "deleted the issue",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function isMarkdownFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    file.type === "text/markdown"
  );
}

function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

type LaunchChecklistState = {
  copyFinal: boolean;
  linksValid: boolean;
  scheduledTime: string;
  proofLine: string;
  sentLedgerEntry: string;
  proofUrlOrPostId: string;
  proofTimestamp: string;
  proofPlatformChannel: string;
};

type BlockerEscalationState = {
  owner: string;
  dueAt: string;
  terminalState: string;
  notes: string;
};

type KatyaAutonomyState = {
  lane: string;
  contentType: string;
  dependencies: string;
  dueWindowStart: string;
  dueWindowEnd: string;
  dueWindowTimezone: string;
  weeklyTarget: string;
  weeklyCompleted: string;
  weeklyWeekStartsOn: string;
  outreachThursdayQuota: string;
  outreachFridayQuota: string;
  prospectMatchPath: string;
  approvalQueueStatus: string;
};

const defaultLaunchChecklist: LaunchChecklistState = {
  copyFinal: false,
  linksValid: false,
  scheduledTime: "",
  proofLine: "",
  sentLedgerEntry: "",
  proofUrlOrPostId: "",
  proofTimestamp: "",
  proofPlatformChannel: "",
};

const defaultBlockerEscalation: BlockerEscalationState = {
  owner: "",
  dueAt: "",
  terminalState: "",
  notes: "",
};

const defaultKatyaAutonomy: KatyaAutonomyState = {
  lane: "",
  contentType: "",
  dependencies: "",
  dueWindowStart: "",
  dueWindowEnd: "",
  dueWindowTimezone: "",
  weeklyTarget: "",
  weeklyCompleted: "",
  weeklyWeekStartsOn: "",
  outreachThursdayQuota: "",
  outreachFridayQuota: "",
  prospectMatchPath: "",
  approvalQueueStatus: "",
};

function launchChecklistFromProduct(product: IssueWorkProduct | null | undefined): LaunchChecklistState {
  const metadata = (product?.metadata ?? {}) as Record<string, unknown>;
  const proof = (metadata.proof ?? {}) as Record<string, unknown>;
  return {
    copyFinal: metadata.copyFinal === true,
    linksValid: metadata.linksValid === true,
    scheduledTime: typeof metadata.scheduledTime === "string" ? metadata.scheduledTime : "",
    proofLine: typeof metadata.proofLine === "string" ? metadata.proofLine : "",
    sentLedgerEntry: typeof metadata.sentLedgerEntry === "string" ? metadata.sentLedgerEntry : "",
    proofUrlOrPostId: typeof proof.urlOrPostId === "string" ? proof.urlOrPostId : "",
    proofTimestamp: typeof proof.timestamp === "string" ? proof.timestamp : "",
    proofPlatformChannel: typeof proof.platformChannel === "string" ? proof.platformChannel : "",
  };
}

function blockerEscalationFromProduct(product: IssueWorkProduct | null | undefined): BlockerEscalationState {
  const metadata = (product?.metadata ?? {}) as Record<string, unknown>;
  const owner = (metadata.owner ?? {}) as Record<string, unknown>;
  return {
    owner:
      typeof owner.displayName === "string"
        ? owner.displayName
        : typeof owner.userId === "string"
          ? owner.userId
          : typeof owner.agentId === "string"
            ? owner.agentId
            : "",
    dueAt: typeof metadata.dueAt === "string" ? metadata.dueAt : "",
    terminalState: typeof metadata.terminalState === "string" ? metadata.terminalState : "",
    notes: typeof metadata.notes === "string" ? metadata.notes : "",
  };
}

function katyaAutonomyFromProduct(product: IssueWorkProduct | null | undefined): KatyaAutonomyState {
  const metadata = (product?.metadata ?? {}) as Record<string, unknown>;
  const dueWindow = (metadata.dueWindow ?? {}) as Record<string, unknown>;
  const weeklyCounter = (metadata.weeklyCounter ?? {}) as Record<string, unknown>;
  const outreach = (metadata.outreachHardening ?? {}) as Record<string, unknown>;
  const quotas = (outreach.quotas ?? {}) as Record<string, unknown>;
  return {
    lane: typeof metadata.lane === "string" ? metadata.lane : "",
    contentType: typeof metadata.contentType === "string" ? metadata.contentType : "",
    dependencies: Array.isArray(metadata.dependencies)
      ? metadata.dependencies.map((dep) => String(dep)).join("\n")
      : "",
    dueWindowStart: typeof dueWindow.startAt === "string" ? dueWindow.startAt : "",
    dueWindowEnd: typeof dueWindow.endAt === "string" ? dueWindow.endAt : "",
    dueWindowTimezone: typeof dueWindow.timezone === "string" ? dueWindow.timezone : "",
    weeklyTarget: typeof weeklyCounter.target === "number" ? String(weeklyCounter.target) : "",
    weeklyCompleted: typeof weeklyCounter.completed === "number" ? String(weeklyCounter.completed) : "",
    weeklyWeekStartsOn:
      typeof weeklyCounter.weekStartsOn === "number" ? String(weeklyCounter.weekStartsOn) : "",
    outreachThursdayQuota:
      typeof quotas.thursday === "number" ? String(quotas.thursday) : "",
    outreachFridayQuota:
      typeof quotas.friday === "number" ? String(quotas.friday) : "",
    prospectMatchPath: Array.isArray(outreach.prospectMatchPath)
      ? outreach.prospectMatchPath.map((step) => String(step)).join("\n")
      : "",
    approvalQueueStatus:
      typeof outreach.approvalQueueStatus === "string" ? outreach.approvalQueueStatus : "",
  };
}

function formatAction(action: string, details?: Record<string, unknown> | null): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    if (details.status !== undefined) {
      const from = previous.status;
      parts.push(
        from
          ? `changed the status from ${humanizeValue(from)} to ${humanizeValue(details.status)}`
          : `changed the status to ${humanizeValue(details.status)}`
      );
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      parts.push(
        from
          ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
          : `changed the priority to ${humanizeValue(details.priority)}`
      );
    }
    if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
      parts.push(
        details.assigneeAgentId || details.assigneeUserId
          ? "assigned the issue"
          : "unassigned the issue",
      );
    }
    if (details.title !== undefined) parts.push("updated the title");
    if (details.description !== undefined) parts.push("updated the description");

    if (parts.length > 0) return parts.join(", ");
  }
  if (
    (action === "issue.document_created" || action === "issue.document_updated" || action === "issue.document_deleted") &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ACTION_LABELS[action] ?? action} ${key}${title}`;
  }
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

function ActorIdentity({ evt, agentMap }: { evt: ActivityEvent; agentMap: Map<string, Agent> }) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <Identity name={agent?.name ?? id.slice(0, 8)} size="sm" />;
  }
  if (evt.actorType === "system") return <Identity name="System" size="sm" />;
  if (evt.actorType === "user") return <Identity name="Board" size="sm" />;
  return <Identity name={id || "Unknown"} size="sm" />;
}

export function IssueDetail() {
  const { issueId } = useParams<{ issueId: string }>();
  const { selectedCompanyId } = useCompany();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToast();
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("comments");
  const [secondaryOpen, setSecondaryOpen] = useState({
    approvals: false,
  });
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [launchChecklist, setLaunchChecklist] = useState<LaunchChecklistState>(defaultLaunchChecklist);
  const [blockerEscalation, setBlockerEscalation] = useState<BlockerEscalationState>(defaultBlockerEscalation);
  const [katyaAutonomy, setKatyaAutonomy] = useState<KatyaAutonomyState>(defaultKatyaAutonomy);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastMarkedReadIssueIdRef = useRef<string | null>(null);

  const { data: issue, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
  });
  const resolvedCompanyId = issue?.companyId ?? selectedCompanyId;

  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!issueId,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.issues.activity(issueId!),
    queryFn: () => activityApi.forIssue(issueId!),
    enabled: !!issueId,
  });

  const { data: linkedRuns } = useQuery({
    queryKey: queryKeys.issues.runs(issueId!),
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 5000,
  });

  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.issues.approvals(issueId!),
    queryFn: () => issuesApi.listApprovals(issueId!),
    enabled: !!issueId,
  });

  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId!),
    queryFn: () => issuesApi.listAttachments(issueId!),
    enabled: !!issueId,
  });

  const { data: workProducts } = useQuery({
    queryKey: ["issues", issueId, "work-products"],
    queryFn: () => issuesApi.listWorkProducts(issueId!),
    enabled: !!issueId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId!),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId!),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const hasLiveRuns = (liveRuns ?? []).length > 0 || !!activeRun;
  const launchChecklistProduct = useMemo(
    () => (workProducts ?? []).find((product) => product.externalId === "launch_checklist_v1") ?? null,
    [workProducts],
  );
  const blockerEscalationProduct = useMemo(
    () => (workProducts ?? []).find((product) => product.externalId === "blocker_escalation_v1") ?? null,
    [workProducts],
  );
  const katyaAutonomyProduct = useMemo(
    () => (workProducts ?? []).find((product) => product.externalId === "katya_metadata_v1") ?? null,
    [workProducts],
  );
  const pendingLinkedApproval = useMemo(
    () => (linkedApprovals ?? []).find((approval) => approval.status === "pending") ?? null,
    [linkedApprovals],
  );
  const isLaunchIssue = useMemo(() => {
    const haystack = `${issue?.title ?? ""} ${issue?.description ?? ""}`.toLowerCase();
    return ["launch", "publish", "go live", "campaign", "scheduled", "post"].some((token) => haystack.includes(token)) || Boolean(launchChecklistProduct);
  }, [issue?.title, issue?.description, launchChecklistProduct]);
  const isScheduledWorkflowStage =
    issue?.status === "in_review" &&
    (linkedApprovals ?? []).some((approval) => approval.status === "approved");
  const showBlockerEscalation = issue?.status === "blocked" || Boolean(blockerEscalationProduct);
  const showKatyaAutonomy = issue?.status !== "done" && issue?.status !== "cancelled";

  const sourceBreadcrumb = useMemo(
    () => readIssueDetailBreadcrumb(location.state) ?? { label: "Issues", href: "/issues" },
    [location.state],
  );

  // Filter out runs already shown by the live widget to avoid duplication
  const timelineRuns = useMemo(() => {
    const liveIds = new Set<string>();
    for (const r of liveRuns ?? []) liveIds.add(r.id);
    if (activeRun) liveIds.add(activeRun.id);
    if (liveIds.size === 0) return linkedRuns ?? [];
    return (linkedRuns ?? []).filter((r) => !liveIds.has(r.runId));
  }, [linkedRuns, liveRuns, activeRun]);

  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const { slots: issuePluginDetailSlots } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "issue",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const issuePluginTabItems = useMemo(
    () => issuePluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}`,
      label: slot.displayName,
      slot,
    })),
    [issuePluginDetailSlots],
  );
  const activePluginTab = issuePluginTabItems.find((item) => item.value === detailTab) ?? null;

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

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
      });
    }
    for (const project of orderedProjects) {
      options.push({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project",
        projectId: project.id,
        projectColor: project.color,
      });
    }
    return options;
  }, [agents, orderedProjects]);

  const childIssues = useMemo(() => {
    if (!allIssues || !issue) return [];
    return allIssues
      .filter((i) => i.parentId === issue.id)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [allIssues, issue]);

  const commentReassignOptions = useMemo(() => {
    const options: Array<{ id: string; label: string; searchText?: string }> = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({ id: `agent:${agent.id}`, label: agent.name });
    }
    if (currentUserId) {
      options.push({ id: `user:${currentUserId}`, label: "Me" });
    }
    return options;
  }, [agents, currentUserId]);

  const actualAssigneeValue = useMemo(
    () => assigneeValueFromSelection(issue ?? {}),
    [issue],
  );

  const suggestedAssigneeValue = useMemo(
    () => suggestedCommentAssigneeValue(issue ?? {}, comments, currentUserId),
    [issue, comments, currentUserId],
  );

  const commentsWithRunMeta = useMemo(() => {
    const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null }>();
    const agentIdByRunId = new Map<string, string>();
    for (const run of linkedRuns ?? []) {
      agentIdByRunId.set(run.runId, run.agentId);
    }
    for (const evt of activity ?? []) {
      if (evt.action !== "issue.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
      });
    }
    return (comments ?? []).map((comment) => {
      const meta = runMetaByCommentId.get(comment.id);
      return meta ? { ...comment, ...meta } : comment;
    });
  }, [activity, comments, linkedRuns]);

  const issueCostSummary = useMemo(() => {
    let input = 0;
    let output = 0;
    let cached = 0;
    let cost = 0;
    let hasCost = false;
    let hasTokens = false;

    for (const run of linkedRuns ?? []) {
      const usage = asRecord(run.usageJson);
      const result = asRecord(run.resultJson);
      const runInput = usageNumber(usage, "inputTokens", "input_tokens");
      const runOutput = usageNumber(usage, "outputTokens", "output_tokens");
      const runCached = usageNumber(
        usage,
        "cachedInputTokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
      );
      const runCost = visibleRunCostUsd(usage, result);
      if (runCost > 0) hasCost = true;
      if (runInput + runOutput + runCached > 0) hasTokens = true;
      input += runInput;
      output += runOutput;
      cached += runCached;
      cost += runCost;
    }

    return {
      input,
      output,
      cached,
      cost,
      totalTokens: input + output,
      hasCost,
      hasTokens,
    };
  }, [linkedRuns]);

  const invalidateIssue = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issueId!) });
    queryClient.invalidateQueries({ queryKey: ["issues", issueId, "work-products"] });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId!) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
    }
  };

  const markIssueRead = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
      }
    },
  });

  const updateIssue = useMutation({
    mutationFn: (data: Record<string, unknown>) => issuesApi.update(issueId!, data),
    onSuccess: () => {
      invalidateIssue();
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Issue update failed", tone: "error" });
    },
  });

  const approveAndMove = useMutation({
    mutationFn: async () => {
      if (!pendingLinkedApproval) throw new Error("No pending linked approval");
      return approvalsApi.approve(pendingLinkedApproval.id, "Approved from issue flow");
    },
    onSuccess: () => {
      invalidateIssue();
      pushToast({ title: "Approved", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Failed to approve", tone: "error" });
    },
  });

  const parseNumberInput = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const splitLines = (value: string) =>
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

  const saveLaunchChecklist = useMutation({
    mutationFn: async () => {
      const payload = {
        type: "document",
        provider: "custom",
        externalId: "launch_checklist_v1",
        title: "Launch checklist",
        status: "active",
        reviewState: "none",
        metadata: {
          copyFinal: launchChecklist.copyFinal,
          linksValid: launchChecklist.linksValid,
          scheduledTime: launchChecklist.scheduledTime || null,
          proofLine: launchChecklist.proofLine || null,
          sentLedgerEntry: launchChecklist.sentLedgerEntry || null,
          proof: {
            urlOrPostId: launchChecklist.proofUrlOrPostId || null,
            timestamp: launchChecklist.proofTimestamp || null,
            platformChannel: launchChecklist.proofPlatformChannel || null,
          },
        },
      };
      if (launchChecklistProduct) {
        return issuesApi.updateWorkProduct(launchChecklistProduct.id, payload);
      }
      return issuesApi.createWorkProduct(issueId!, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issues", issueId, "work-products"] });
      invalidateIssue();
      pushToast({ title: "Launch checklist saved", tone: "success" });
    },
  });

  const saveBlockerEscalation = useMutation({
    mutationFn: async () => {
      const payload = {
        type: "document",
        provider: "custom",
        externalId: "blocker_escalation_v1",
        title: "Blocker escalation",
        status: "active",
        reviewState: "none",
        metadata: {
          owner: blockerEscalation.owner
            ? { displayName: blockerEscalation.owner }
            : null,
          dueAt: blockerEscalation.dueAt || null,
          terminalState: blockerEscalation.terminalState || null,
          notes: blockerEscalation.notes || null,
        },
      };
      if (blockerEscalationProduct) {
        return issuesApi.updateWorkProduct(blockerEscalationProduct.id, payload);
      }
      return issuesApi.createWorkProduct(issueId!, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issues", issueId, "work-products"] });
      invalidateIssue();
      pushToast({ title: "Blocker escalation saved", tone: "success" });
    },
  });

  const saveKatyaAutonomy = useMutation({
    mutationFn: async () => {
      const weeklyTarget = parseNumberInput(katyaAutonomy.weeklyTarget);
      const weeklyCompleted = parseNumberInput(katyaAutonomy.weeklyCompleted);
      const weeklyWeekStartsOn = parseNumberInput(katyaAutonomy.weeklyWeekStartsOn);
      const weeklyWeekStartsOnNormalized =
        weeklyWeekStartsOn !== null
        && Number.isInteger(weeklyWeekStartsOn)
        && weeklyWeekStartsOn >= 0
        && weeklyWeekStartsOn <= 6
          ? (weeklyWeekStartsOn as 0 | 1 | 2 | 3 | 4 | 5 | 6)
          : null;
      const weeklyCounter =
        weeklyTarget === null && weeklyCompleted === null && weeklyWeekStartsOnNormalized === null
          ? null
          : {
            target: weeklyTarget ?? 0,
            completed: weeklyCompleted ?? 0,
            ...(weeklyWeekStartsOnNormalized !== null
              ? { weekStartsOn: weeklyWeekStartsOnNormalized }
              : {}),
          };
      const outreachThursday = parseNumberInput(katyaAutonomy.outreachThursdayQuota);
      const outreachFriday = parseNumberInput(katyaAutonomy.outreachFridayQuota);
      const dependencies = splitLines(katyaAutonomy.dependencies);
      const prospectMatchPath = splitLines(katyaAutonomy.prospectMatchPath);
      const existingMetadata = (katyaAutonomyProduct?.metadata ?? {}) as Record<string, unknown>;
      const payload = {
        type: "document",
        provider: "custom",
        externalId: "katya_metadata_v1",
        title: "Katya autonomy",
        status: "active",
        reviewState: "none",
        metadata: {
          lane: katyaAutonomy.lane || null,
          contentType: katyaAutonomy.contentType || null,
          dependencies,
          dueWindow: {
            startAt: katyaAutonomy.dueWindowStart || null,
            endAt: katyaAutonomy.dueWindowEnd || null,
            timezone: katyaAutonomy.dueWindowTimezone || null,
          },
          owner: existingMetadata.owner ?? null,
          proof: existingMetadata.proof ?? null,
          weeklyCounter,
          outreachHardening: {
            quotas: {
              thursday: outreachThursday,
              friday: outreachFriday,
            },
            prospectMatchPath,
            approvalQueueStatus: katyaAutonomy.approvalQueueStatus || null,
          },
        },
      };
      if (katyaAutonomyProduct) {
        return issuesApi.updateWorkProduct(katyaAutonomyProduct.id, payload);
      }
      return issuesApi.createWorkProduct(issueId!, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issues", issueId, "work-products"] });
      invalidateIssue();
      pushToast({ title: "Katya autonomy saved", tone: "success" });
    },
  });

  const addComment = useMutation({
    mutationFn: ({ body, reopen }: { body: string; reopen?: boolean }) =>
      issuesApi.addComment(issueId!, body, reopen),
    onSuccess: () => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
    },
  });

  const addCommentAndReassign = useMutation({
    mutationFn: ({
      body,
      reopen,
      reassignment,
    }: {
      body: string;
      reopen?: boolean;
      reassignment: CommentReassignment;
    }) =>
      issuesApi.update(issueId!, {
        comment: body,
        assigneeAgentId: reassignment.assigneeAgentId,
        assigneeUserId: reassignment.assigneeUserId,
        ...(reopen ? { status: "todo" } : {}),
      }),
    onSuccess: () => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return issuesApi.uploadAttachment(selectedCompanyId, issueId!, file);
    },
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const importMarkdownDocument = useMutation({
    mutationFn: async (file: File) => {
      const baseName = fileBaseName(file.name);
      const key = slugifyDocumentKey(baseName);
      const existing = (issue?.documentSummaries ?? []).find((doc) => doc.key === key) ?? null;
      const body = await file.text();
      const inferredTitle = titleizeFilename(baseName);
      const nextTitle = existing?.title ?? inferredTitle ?? null;
      return issuesApi.upsertDocument(issueId!, key, {
        title: key === "plan" ? null : nextTitle,
        format: "markdown",
        body,
        baseRevisionId: existing?.latestRevisionId ?? null,
      });
    },
    onSuccess: () => {
      setAttachmentError(null);
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Document import failed");
    },
  });

  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) => issuesApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  useEffect(() => {
    const titleLabel = issue?.title ?? issueId ?? "Issue";
    setBreadcrumbs([
      sourceBreadcrumb,
      { label: hasLiveRuns ? `🔵 ${titleLabel}` : titleLabel },
    ]);
  }, [setBreadcrumbs, sourceBreadcrumb, issue, issueId, hasLiveRuns]);

  // Redirect to identifier-based URL if navigated via UUID
  useEffect(() => {
    if (issue?.identifier && issueId !== issue.identifier) {
      navigate(`/issues/${issue.identifier}`, { replace: true, state: location.state });
    }
  }, [issue, issueId, navigate, location.state]);

  useEffect(() => {
    if (!issue?.id) return;
    if (lastMarkedReadIssueIdRef.current === issue.id) return;
    lastMarkedReadIssueIdRef.current = issue.id;
    markIssueRead.mutate(issue.id);
  }, [issue?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (issue) {
      openPanel(
        <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} />
      );
    }
    return () => closePanel();
  }, [issue]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLaunchChecklist(launchChecklistFromProduct(launchChecklistProduct));
  }, [launchChecklistProduct]);

  useEffect(() => {
    setBlockerEscalation(blockerEscalationFromProduct(blockerEscalationProduct));
  }, [blockerEscalationProduct]);

  useEffect(() => {
    setKatyaAutonomy(katyaAutonomyFromProduct(katyaAutonomyProduct));
  }, [katyaAutonomyProduct]);

  const copyIssueToClipboard = async () => {
    if (!issue) return;
    const decodeEntities = (text: string) => {
      const el = document.createElement("textarea");
      el.innerHTML = text;
      return el.value;
    };
    const title = decodeEntities(issue.title);
    const body = decodeEntities(issue.description ?? "");
    const md = `# ${issue.identifier}: ${title}\n\n${body}`.trimEnd();
    await navigator.clipboard.writeText(md);
    setCopied(true);
    pushToast({ title: "Copied to clipboard", tone: "success" });
    setTimeout(() => setCopied(false), 2000);
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!issue) return null;

  // Ancestors are returned oldest-first from the server (root at end, immediate parent at start)
  const ancestors = issue.ancestors ?? [];
  const handleFilePicked = async (evt: ChangeEvent<HTMLInputElement>) => {
    const files = evt.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleAttachmentDrop = async (evt: DragEvent<HTMLDivElement>) => {
    evt.preventDefault();
    setAttachmentDragActive(false);
    const files = evt.dataTransfer.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
  };

  const isImageAttachment = (attachment: IssueAttachment) => attachment.contentType.startsWith("image/");
  const attachmentList = attachments ?? [];
  const hasAttachments = attachmentList.length > 0;
  const attachmentUploadButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown"
        className="hidden"
        onChange={handleFilePicked}
        multiple
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploadAttachment.isPending || importMarkdownDocument.isPending}
        className={cn(
          "shadow-none",
          attachmentDragActive && "border-primary bg-primary/5",
        )}
      >
        <Paperclip className="h-3.5 w-3.5 mr-1.5" />
        {uploadAttachment.isPending || importMarkdownDocument.isPending ? "Uploading..." : "Upload attachment"}
      </Button>
    </>
  );

  return (
    <div className="max-w-2xl space-y-6">
      {/* Parent chain breadcrumb */}
      {ancestors.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
          {[...ancestors].reverse().map((ancestor, i) => (
            <span key={ancestor.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
              <Link
                to={`/issues/${ancestor.identifier ?? ancestor.id}`}
                state={location.state}
                className="hover:text-foreground transition-colors truncate max-w-[200px]"
                title={ancestor.title}
              >
                {ancestor.title}
              </Link>
            </span>
          ))}
          <ChevronRight className="h-3 w-3 shrink-0" />
          <span className="text-foreground/60 truncate max-w-[200px]">{issue.title}</span>
        </nav>
      )}

      {issue.hiddenAt && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <EyeOff className="h-4 w-4 shrink-0" />
          This issue is hidden
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <StatusIcon
            status={issue.status}
            onChange={(status) => updateIssue.mutate({ status })}
          />
          <PriorityIcon
            priority={issue.priority}
            onChange={(priority) => updateIssue.mutate({ priority })}
          />
          <span className="text-sm font-mono text-muted-foreground shrink-0">{issue.identifier ?? issue.id.slice(0, 8)}</span>

          {isScheduledWorkflowStage && (
            <span className="inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-600 dark:text-indigo-300 shrink-0">
              Scheduled
            </span>
          )}

          {hasLiveRuns && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400 shrink-0">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400" />
              </span>
              Live
            </span>
          )}

          {pendingLinkedApproval ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                onClick={() => approveAndMove.mutate()}
                disabled={approveAndMove.isPending}
              >
                {approveAndMove.isPending ? "Approving..." : "Approve + Move"}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                PEL-1 quick action: this approves the linked request and moves status to in_review. {" "}
                <Link className="underline" to={`/approvals/${pendingLinkedApproval.id}`}>
                  Open pending approval
                </Link>
              </span>
            </>
          ) : (linkedApprovals?.length ?? 0) > 0 ? (
            <span className="text-[11px] text-muted-foreground">
              No pending approval on this issue right now — open Linked Approvals below.
            </span>
          ) : null}

          {issue.originKind === "routine_execution" && issue.originId && (
            <Link
              to={`/routines/${issue.originId}`}
              className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400 shrink-0 hover:bg-violet-500/20 transition-colors"
            >
              <Repeat className="h-3 w-3" />
              Routine
            </Link>
          )}

          {issue.projectId ? (
            <Link
              to={`/projects/${issue.projectId}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0"
            >
              <Hexagon className="h-3 w-3 shrink-0" />
              <span className="truncate">{(projects ?? []).find((p) => p.id === issue.projectId)?.name ?? issue.projectId.slice(0, 8)}</span>
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
              <Hexagon className="h-3 w-3 shrink-0" />
              No project
            </span>
          )}

          {(issue.labels ?? []).length > 0 && (
            <div className="hidden sm:flex items-center gap-1">
              {(issue.labels ?? []).slice(0, 4).map((label) => (
                <span
                  key={label.id}
                  className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    borderColor: label.color,
                    color: label.color,
                    backgroundColor: `${label.color}1f`,
                  }}
                >
                  {label.name}
                </span>
              ))}
              {(issue.labels ?? []).length > 4 && (
                <span className="text-[10px] text-muted-foreground">+{(issue.labels ?? []).length - 4}</span>
              )}
            </div>
          )}

          <div className="ml-auto flex items-center gap-0.5 md:hidden shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy issue as markdown"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setMobilePropsOpen(true)}
              title="Properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>

          <div className="hidden md:flex items-center md:ml-auto shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy issue as markdown"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "shrink-0 transition-opacity duration-200",
                panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
              )}
              onClick={() => setPanelVisible(true)}
              title="Show properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>

            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="shrink-0">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="end">
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                onClick={() => {
                  updateIssue.mutate(
                    { hiddenAt: new Date().toISOString() },
                    { onSuccess: () => navigate("/issues/all") },
                  );
                  setMoreOpen(false);
                }}
              >
                <EyeOff className="h-3 w-3" />
                Hide this Issue
              </button>
            </PopoverContent>
            </Popover>
          </div>
        </div>

        <InlineEditor
          value={issue.title}
          onSave={(title) => updateIssue.mutateAsync({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={issue.description ?? ""}
          onSave={(description) => updateIssue.mutateAsync({ description })}
          as="p"
          className="text-[15px] leading-7 text-foreground"
          placeholder="Add a description..."
          multiline
          mentions={mentionOptions}
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync(file);
            return attachment.contentPath;
          }}
        />
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <PluginSlotOutlet
        slotTypes={["taskDetailView"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="space-y-3"
        itemClassName="rounded-lg border border-border p-3"
        missingBehavior="placeholder"
      />

      <IssueDocumentsSection
        issue={issue}
        canDeleteDocuments={Boolean(session?.user?.id)}
        mentions={mentionOptions}
        imageUploadHandler={async (file) => {
          const attachment = await uploadAttachment.mutateAsync(file);
          return attachment.contentPath;
        }}
        extraActions={!hasAttachments ? attachmentUploadButton : undefined}
      />

      {hasAttachments ? (
        <div
        className={cn(
          "space-y-3 rounded-lg transition-colors",
        )}
        onDragEnter={(evt) => {
          evt.preventDefault();
          setAttachmentDragActive(true);
        }}
        onDragOver={(evt) => {
          evt.preventDefault();
          setAttachmentDragActive(true);
        }}
        onDragLeave={(evt) => {
          if (evt.currentTarget.contains(evt.relatedTarget as Node | null)) return;
          setAttachmentDragActive(false);
        }}
        onDrop={(evt) => void handleAttachmentDrop(evt)}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">Attachments</h3>
          {attachmentUploadButton}
        </div>

        {attachmentError && (
          <p className="text-xs text-destructive">{attachmentError}</p>
        )}

        <div className="space-y-2">
          {attachmentList.map((attachment) => (
            <div key={attachment.id} className="border border-border rounded-md p-2">
              <div className="flex items-center justify-between gap-2">
                <a
                  href={attachment.contentPath}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs hover:underline truncate"
                  title={attachment.originalFilename ?? attachment.id}
                >
                  {attachment.originalFilename ?? attachment.id}
                </a>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => deleteAttachment.mutate(attachment.id)}
                  disabled={deleteAttachment.isPending}
                  title="Delete attachment"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {attachment.contentType} · {(attachment.byteSize / 1024).toFixed(1)} KB
              </p>
              {isImageAttachment(attachment) && (
                <a href={attachment.contentPath} target="_blank" rel="noreferrer">
                  <img
                    src={attachment.contentPath}
                    alt={attachment.originalFilename ?? "attachment"}
                    className="mt-2 max-h-56 rounded border border-border object-contain bg-accent/10"
                    loading="lazy"
                  />
                </a>
              )}
            </div>
          ))}
        </div>
        </div>
      ) : null}

      {showBlockerEscalation ? (
        <section className="rounded-lg border bg-card p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Blocker escalation</h3>
            <Button size="sm" variant="outline" onClick={() => saveBlockerEscalation.mutate()} disabled={saveBlockerEscalation.isPending}>
              {saveBlockerEscalation.isPending ? "Saving..." : "Save escalation"}
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className="h-8 rounded-md border bg-background px-2 text-xs"
              placeholder="Owner (name/user/agent)"
              value={blockerEscalation.owner}
              onChange={(e) => setBlockerEscalation((prev) => ({ ...prev, owner: e.target.value }))}
            />
            <input
              className="h-8 rounded-md border bg-background px-2 text-xs"
              placeholder="Due at (ISO/local text)"
              value={blockerEscalation.dueAt}
              onChange={(e) => setBlockerEscalation((prev) => ({ ...prev, dueAt: e.target.value }))}
            />
            <input
              className="h-8 rounded-md border bg-background px-2 text-xs"
              placeholder="Terminal state (DONE | BLOCKED_WITH_NEW_TIME | NEEDS_REVIEW)"
              value={blockerEscalation.terminalState}
              onChange={(e) => setBlockerEscalation((prev) => ({ ...prev, terminalState: e.target.value }))}
            />
            <input
              className="h-8 rounded-md border bg-background px-2 text-xs"
              placeholder="Notes"
              value={blockerEscalation.notes}
              onChange={(e) => setBlockerEscalation((prev) => ({ ...prev, notes: e.target.value }))}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">Blocked status requires owner, due date, and terminal-state discipline.</p>
        </section>
      ) : null}

      {showKatyaAutonomy ? (
        <section className="rounded-lg border bg-card p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Katya autonomy metadata</h3>
            <Button size="sm" variant="outline" onClick={() => saveKatyaAutonomy.mutate()} disabled={saveKatyaAutonomy.isPending}>
              {saveKatyaAutonomy.isPending ? "Saving..." : "Save metadata"}
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Lane" value={katyaAutonomy.lane} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, lane: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Content type" value={katyaAutonomy.contentType} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, contentType: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Due window start (ISO/local text)" value={katyaAutonomy.dueWindowStart} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, dueWindowStart: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Due window end (ISO/local text)" value={katyaAutonomy.dueWindowEnd} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, dueWindowEnd: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Due window timezone" value={katyaAutonomy.dueWindowTimezone} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, dueWindowTimezone: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Weekly target" value={katyaAutonomy.weeklyTarget} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, weeklyTarget: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Weekly completed" value={katyaAutonomy.weeklyCompleted} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, weeklyCompleted: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Week starts on (0=Sun..6=Sat)" value={katyaAutonomy.weeklyWeekStartsOn} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, weeklyWeekStartsOn: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Thu outreach quota" value={katyaAutonomy.outreachThursdayQuota} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, outreachThursdayQuota: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Fri outreach quota" value={katyaAutonomy.outreachFridayQuota} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, outreachFridayQuota: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs sm:col-span-2" placeholder="Approval queue status" value={katyaAutonomy.approvalQueueStatus} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, approvalQueueStatus: e.target.value }))} />
          </div>
          <div className="grid gap-2">
            <textarea className="min-h-[64px] rounded-md border bg-background px-2 py-1 text-xs" placeholder="Dependencies (one per line)" value={katyaAutonomy.dependencies} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, dependencies: e.target.value }))} />
            <textarea className="min-h-[64px] rounded-md border bg-background px-2 py-1 text-xs" placeholder="Prospect match path (one step per line)" value={katyaAutonomy.prospectMatchPath} onChange={(e) => setKatyaAutonomy((prev) => ({ ...prev, prospectMatchPath: e.target.value }))} />
          </div>
          <p className="text-[11px] text-muted-foreground">Used in 10:00/15:00 self-management checks for behind-schedule detection.</p>
        </section>
      ) : null}

      {isLaunchIssue ? (
        <section className="rounded-lg border bg-card p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Launch checklist</h3>
            <Button size="sm" variant="outline" onClick={() => saveLaunchChecklist.mutate()} disabled={saveLaunchChecklist.isPending}>
              {saveLaunchChecklist.isPending ? "Saving..." : "Save checklist"}
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 text-xs">
            <label className="flex items-center gap-2"><input type="checkbox" checked={launchChecklist.copyFinal} onChange={(e) => setLaunchChecklist((prev) => ({ ...prev, copyFinal: e.target.checked }))} />Copy final</label>
            <label className="flex items-center gap-2 opacity-70"><input type="checkbox" checked={attachmentList.some((item) => item.contentType.startsWith("image/"))} readOnly />Image attached (auto)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={launchChecklist.linksValid} onChange={(e) => setLaunchChecklist((prev) => ({ ...prev, linksValid: e.target.checked }))} />Links valid</label>
            <label className="flex items-center gap-2 opacity-70"><input type="checkbox" checked={(linkedApprovals ?? []).some((approval) => approval.status === "approved")} readOnly />Approval received (auto)</label>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Scheduled time (ISO/local text)" value={launchChecklist.scheduledTime} onChange={(e) => setLaunchChecklist((prev) => ({ ...prev, scheduledTime: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Proof URL / Post ID" value={launchChecklist.proofUrlOrPostId} onChange={(e) => setLaunchChecklist((prev) => ({ ...prev, proofUrlOrPostId: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Proof timestamp" value={launchChecklist.proofTimestamp} onChange={(e) => setLaunchChecklist((prev) => ({ ...prev, proofTimestamp: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs" placeholder="Platform / channel" value={launchChecklist.proofPlatformChannel} onChange={(e) => setLaunchChecklist((prev) => ({ ...prev, proofPlatformChannel: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs sm:col-span-2" placeholder="Proof line (required)" value={launchChecklist.proofLine} onChange={(e) => setLaunchChecklist((prev) => ({ ...prev, proofLine: e.target.value }))} />
            <input className="h-8 rounded-md border bg-background px-2 text-xs sm:col-span-2" placeholder="Sent ledger entry (required)" value={launchChecklist.sentLedgerEntry} onChange={(e) => setLaunchChecklist((prev) => ({ ...prev, sentLedgerEntry: e.target.value }))} />
          </div>
          <p className="text-[11px] text-muted-foreground">Moving this issue to done is blocked until all checks are complete, proof is captured, and sent-ledger logging is recorded.</p>
        </section>
      ) : null}

      <Separator />

      <Tabs value={detailTab} onValueChange={setDetailTab} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="comments" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            Comments
          </TabsTrigger>
          <TabsTrigger value="subissues" className="gap-1.5">
            <ListTree className="h-3.5 w-3.5" />
            Sub-issues
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            Activity
          </TabsTrigger>
          {issuePluginTabItems.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="comments">
          <CommentThread
            comments={commentsWithRunMeta}
            linkedRuns={timelineRuns}
            companyId={issue.companyId}
            projectId={issue.projectId}
            issueStatus={issue.status}
            agentMap={agentMap}
            draftKey={`paperclip:issue-comment-draft:${issue.id}`}
            enableReassign
            reassignOptions={commentReassignOptions}
            currentAssigneeValue={actualAssigneeValue}
            suggestedAssigneeValue={suggestedAssigneeValue}
            mentions={mentionOptions}
            onAdd={async (body, reopen, reassignment) => {
              if (reassignment) {
                await addCommentAndReassign.mutateAsync({ body, reopen, reassignment });
                return;
              }
              await addComment.mutateAsync({ body, reopen });
            }}
            imageUploadHandler={async (file) => {
              const attachment = await uploadAttachment.mutateAsync(file);
              return attachment.contentPath;
            }}
            onAttachImage={async (file) => {
              await uploadAttachment.mutateAsync(file);
            }}
            liveRunSlot={<LiveRunWidget issueId={issueId!} companyId={issue.companyId} />}
          />
        </TabsContent>

        <TabsContent value="subissues">
          {childIssues.length === 0 ? (
            <p className="text-xs text-muted-foreground">No sub-issues.</p>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {childIssues.map((child) => (
                <Link
                  key={child.id}
                  to={`/issues/${child.identifier ?? child.id}`}
                  state={location.state}
                  className="flex items-center justify-between px-3 py-2 text-sm hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusIcon status={child.status} />
                    <PriorityIcon priority={child.priority} />
                    <span className="font-mono text-muted-foreground shrink-0">
                      {child.identifier ?? child.id.slice(0, 8)}
                    </span>
                    <span className="truncate">{child.title}</span>
                  </div>
                  {child.assigneeAgentId && (() => {
                    const name = agentMap.get(child.assigneeAgentId)?.name;
                    return name
                      ? <Identity name={name} size="sm" />
                      : <span className="text-muted-foreground font-mono">{child.assigneeAgentId.slice(0, 8)}</span>;
                  })()}
                </Link>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="activity">
          {linkedRuns && linkedRuns.length > 0 && (
            <div className="mb-3 px-3 py-2 rounded-lg border border-border">
              <div className="text-sm font-medium text-muted-foreground mb-1">Cost Summary</div>
              {!issueCostSummary.hasCost && !issueCostSummary.hasTokens ? (
                <div className="text-xs text-muted-foreground">No cost data yet.</div>
              ) : (
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground tabular-nums">
                  {issueCostSummary.hasCost && (
                    <span className="font-medium text-foreground">
                      ${issueCostSummary.cost.toFixed(4)}
                    </span>
                  )}
                  {issueCostSummary.hasTokens && (
                    <span>
                      Tokens {formatTokens(issueCostSummary.totalTokens)}
                      {issueCostSummary.cached > 0
                        ? ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)}, cached ${formatTokens(issueCostSummary.cached)})`
                        : ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)})`}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          {!activity || activity.length === 0 ? (
            <p className="text-xs text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="space-y-1.5">
              {activity.slice(0, 20).map((evt) => (
                <div key={evt.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ActorIdentity evt={evt} agentMap={agentMap} />
                  <span>{formatAction(evt.action, evt.details)}</span>
                  <span className="ml-auto shrink-0">{relativeTime(evt.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {activePluginTab && (
          <TabsContent value={activePluginTab.value}>
            <PluginSlotMount
              slot={activePluginTab.slot}
              context={{
                companyId: issue.companyId,
                projectId: issue.projectId ?? null,
                entityId: issue.id,
                entityType: "issue",
              }}
              missingBehavior="placeholder"
            />
          </TabsContent>
        )}
      </Tabs>

      {linkedApprovals && linkedApprovals.length > 0 && (
        <Collapsible
          open={secondaryOpen.approvals}
          onOpenChange={(open) => setSecondaryOpen((prev) => ({ ...prev, approvals: open }))}
          className="rounded-lg border border-border"
        >
          <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left">
            <span className="text-sm font-medium text-muted-foreground">
              Linked Approvals ({linkedApprovals.length})
            </span>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", secondaryOpen.approvals && "rotate-180")}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border divide-y divide-border">
              {linkedApprovals.map((approval) => (
                <Link
                  key={approval.id}
                  to={`/approvals/${approval.id}`}
                  className="flex items-center justify-between px-3 py-2 text-xs hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <StatusBadge status={approval.status} />
                    <span className="font-medium">
                      {approval.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
                    <span className="font-mono text-muted-foreground">{approval.id.slice(0, 8)}</span>
                  </div>
                  <span className="text-muted-foreground">{relativeTime(approval.createdAt)}</span>
                </Link>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}


      {/* Mobile properties drawer */}
      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} inline />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <ScrollToBottom />
    </div>
  );
}
