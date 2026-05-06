import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginJobContext,
  type PluginWebhookInput,
  type ScopeKey,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import type { Agent, Goal, Issue, Project } from "@paperclipai/shared";
import {
  ACTION_KEYS,
  DATA_KEYS,
  DEFAULT_CONFIG,
  DOCUMENT_KEYS,
  EMAIL_TONES,
  JOB_KEYS,
  PLUGIN_ID,
  STATE_KEYS,
  TOOL_KEYS,
  WEBHOOK_KEYS,
} from "./constants.js";
import {
  buildContentCampaignMarkdown,
  buildDailyBriefMarkdown,
  buildEmailReplyMarkdown,
  buildFocusPlanMarkdown,
  buildLeadPipelineMarkdown,
  buildMissionControlMarkdown,
  buildProposalMarkdown,
  buildWatchdogMarkdown,
  extractActionItems,
  normalizePlatforms,
  normalizeStage,
  summarizeTranscript,
  type FocusBlock,
  type LeadPipelineEntry,
  type WorkflowRecord,
} from "./domain.js";

type PluginConfig = {
  defaultProjectId?: string;
  autoCreateMeetingTasks?: boolean;
  autoAttachProposalDraft?: boolean;
  autoCreateCalendarTasks?: boolean;
  autoCreateLeadFollowUps?: boolean;
  defaultEmailTone?: string;
  contentPlatforms?: string[];
  missionControlLanes?: string[];
  maxStoredRecords?: number;
  dailyBriefIssueLimit?: number;
  focusBlockMinutes?: number;
  watchdogStaleIssueHours?: number;
};

type MarkdownPayload = {
  createdAt: string;
  markdown: string;
};

type ProposalPayload = MarkdownPayload & { title: string };
type EmailReplyPayload = MarkdownPayload & { subject: string };
type FocusPlanPayload = MarkdownPayload & { date: string };
type MissionControlPayload = MarkdownPayload & { objective: string };
type ContentCampaignPayload = MarkdownPayload & { title: string };

type AgentSummary = Pick<Agent, "id" | "name" | "status" | "role">;

type WorkflowOverview = {
  companyId: string;
  companyName: string;
  projects: Pick<Project, "id" | "name">[];
  agents: AgentSummary[];
  leadPipeline: LeadPipelineEntry[];
  recentRecords: WorkflowRecord[];
  latestDailyBrief: MarkdownPayload | null;
  latestProposalDraft: ProposalPayload | null;
  latestEmailReply: EmailReplyPayload | null;
  latestFocusPlan: FocusPlanPayload | null;
  latestMissionControlPlan: MissionControlPayload | null;
  latestContentCampaign: ContentCampaignPayload | null;
  latestWatchdogReport: MarkdownPayload | null;
  openIssues: Pick<Issue, "id" | "title" | "status">[];
  activeGoals: Pick<Goal, "id" | "title" | "status">[];
  counts: {
    records: number;
    openIssues: number;
    activeGoals: number;
    projects: number;
    agents: number;
    leadPipeline: number;
    followUpsDue: number;
  };
};

let currentContext: PluginContext | null = null;
let jobsRun = 0;
let actionsRun = 0;
let webhooksHandled = 0;

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === "string") {
    const normalized = value.split(",").map((item) => item.trim()).filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }
  return undefined;
}

function companyScope(companyId: string, stateKey: string): ScopeKey {
  return { scopeKind: "company", scopeId: companyId, stateKey };
}

function normalizeLaneNames(input: string[] | undefined, fallback: readonly string[]): string[] {
  const raw = input && input.length > 0 ? input : [...fallback];
  return [...new Set(raw.map((item) => item.trim()).filter(Boolean).map((item) => item.replace(/\s+/g, " ").replace(/^./, (char) => char.toUpperCase())))];
}

function toTimeValue(value: Date | string | null | undefined): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function leadIssueTitle(leadName: string, organization?: string): string {
  return `Lead: ${leadName}${organization ? ` @ ${organization}` : ""}`;
}

function parseLeadNameFromTitle(title: string): string {
  const match = title.match(/^Lead:\s*(.+?)(?:\s+@\s+.+)?$/i);
  return match ? match[1]!.trim() : title;
}

function scoreLeadStage(stage: LeadPipelineEntry["stage"]): number {
  switch (stage) {
    case "new":
      return 25;
    case "nurture":
      return 35;
    case "qualified":
      return 60;
    case "proposal":
      return 75;
    case "negotiation":
      return 90;
    case "won":
      return 100;
    case "lost":
      return 0;
  }
}

function mapLeadStageToIssueStatus(stage: LeadPipelineEntry["stage"]): Issue["status"] {
  switch (stage) {
    case "new":
      return "backlog";
    case "nurture":
      return "todo";
    case "qualified":
      return "todo";
    case "proposal":
      return "in_progress";
    case "negotiation":
      return "in_review";
    case "won":
      return "done";
    case "lost":
      return "cancelled";
  }
}

function isOpenIssue(issue: Pick<Issue, "status">): boolean {
  return issue.status !== "done" && issue.status !== "cancelled";
}

function isActiveGoal(goal: Pick<Goal, "status">): boolean {
  return goal.status === "active";
}

function isFollowUpDue(entry: LeadPipelineEntry): boolean {
  if (!entry.nextFollowUp || entry.stage === "won" || entry.stage === "lost") return false;
  return toTimeValue(entry.nextFollowUp) <= Date.now();
}

function toRecord(kind: WorkflowRecord["kind"], title: string, summary?: string, partial?: Partial<WorkflowRecord>): WorkflowRecord {
  return {
    id: randomUUID(),
    kind,
    title,
    createdAt: new Date().toISOString(),
    summary,
    ...partial,
  };
}

function priorityWeight(priority: Issue["priority"]): number {
  switch (priority) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

function statusWeight(status: Issue["status"]): number {
  switch (status) {
    case "in_progress":
      return 5;
    case "todo":
      return 4;
    case "backlog":
      return 3;
    case "in_review":
      return 2;
    case "blocked":
      return 1;
    case "done":
    case "cancelled":
      return 0;
  }
}

function sortIssuesForFocus(issues: Issue[]): Issue[] {
  return [...issues].sort((left, right) => {
    const statusDelta = statusWeight(right.status) - statusWeight(left.status);
    if (statusDelta !== 0) return statusDelta;
    const priorityDelta = priorityWeight(right.priority) - priorityWeight(left.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return toTimeValue(left.updatedAt) - toTimeValue(right.updatedAt);
  });
}

function parseClock(value: string | undefined, fallback = "09:00"): number {
  const candidate = value?.trim() || fallback;
  const match = candidate.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 9 * 60;
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  return hours * 60 + minutes;
}

function formatClock(totalMinutes: number): string {
  const normalized = ((Math.round(totalMinutes) % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hours = String(Math.floor(normalized / 60)).padStart(2, "0");
  const minutes = String(normalized % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function buildFocusBlocks(issues: Issue[], goals: Goal[], preferredStart: string | undefined, blockMinutes: number, hours: number): FocusBlock[] {
  const availableMinutes = Math.max(30, Math.round(hours * 60));
  const duration = Math.max(30, Math.round(blockMinutes));
  const items = [
    ...sortIssuesForFocus(issues.filter(isOpenIssue)).map((issue) => ({
      label: issue.title,
      reason: `${issue.priority} priority ${issue.status.replace(/_/g, " ")}`,
    })),
    ...goals.filter(isActiveGoal).map((goal) => ({
      label: goal.title,
      reason: "active goal",
    })),
  ];

  if (items.length === 0) {
    items.push({
      label: "Deep work / cleanup",
      reason: "no active items were detected",
    });
  }

  const blocks: FocusBlock[] = [];
  let cursor = parseClock(preferredStart);
  let consumed = 0;

  for (const item of items) {
    if (consumed >= availableMinutes) break;
    const nextDuration = Math.min(duration, availableMinutes - consumed);
    blocks.push({
      start: formatClock(cursor),
      end: formatClock(cursor + nextDuration),
      label: item.label,
      reason: item.reason,
    });
    cursor += nextDuration + 15;
    consumed += nextDuration;
  }

  return blocks;
}

function laneFocusForObjective(lane: string, objective: string): string {
  switch (lane.trim().toLowerCase()) {
    case "revenue":
      return `Unblock pipeline movement, lead follow-ups, and deal momentum tied to ${objective}.`;
    case "content":
      return `Ship the content outputs, repurposing tasks, and campaign assets needed for ${objective}.`;
    case "operations":
      return `Keep daily ops, calendar follow-ups, and reporting tightly aligned to ${objective}.`;
    case "product":
      return `Coordinate product, engineering, and delivery work that moves ${objective}.`;
    default:
      return `Drive the ${lane} lane forward with the clearest next step for ${objective}.`;
  }
}

function buildMissionControlPrompt(objective: string, lane: string, focus: string): string {
  return [
    `You are assigned to the ${lane} lane for objective: ${objective}.`,
    `Focus: ${focus}`,
    "Reply with the immediate next steps, likely blockers, and the first deliverable you would produce.",
  ].join("\n");
}

async function getConfig(ctx: PluginContext): Promise<Required<PluginConfig>> {
  const config = await ctx.config.get() as PluginConfig;
  return {
    defaultProjectId: config.defaultProjectId ?? DEFAULT_CONFIG.defaultProjectId,
    autoCreateMeetingTasks: config.autoCreateMeetingTasks ?? DEFAULT_CONFIG.autoCreateMeetingTasks,
    autoAttachProposalDraft: config.autoAttachProposalDraft ?? DEFAULT_CONFIG.autoAttachProposalDraft,
    autoCreateCalendarTasks: config.autoCreateCalendarTasks ?? DEFAULT_CONFIG.autoCreateCalendarTasks,
    autoCreateLeadFollowUps: config.autoCreateLeadFollowUps ?? DEFAULT_CONFIG.autoCreateLeadFollowUps,
    defaultEmailTone: config.defaultEmailTone ?? DEFAULT_CONFIG.defaultEmailTone,
    contentPlatforms: config.contentPlatforms ?? [...DEFAULT_CONFIG.contentPlatforms],
    missionControlLanes: config.missionControlLanes ?? [...DEFAULT_CONFIG.missionControlLanes],
    maxStoredRecords: config.maxStoredRecords ?? DEFAULT_CONFIG.maxStoredRecords,
    dailyBriefIssueLimit: config.dailyBriefIssueLimit ?? DEFAULT_CONFIG.dailyBriefIssueLimit,
    focusBlockMinutes: config.focusBlockMinutes ?? DEFAULT_CONFIG.focusBlockMinutes,
    watchdogStaleIssueHours: config.watchdogStaleIssueHours ?? DEFAULT_CONFIG.watchdogStaleIssueHours,
  };
}

async function readCompanyRecords(ctx: PluginContext, companyId: string): Promise<WorkflowRecord[]> {
  return await ctx.state.get(companyScope(companyId, STATE_KEYS.records)) as WorkflowRecord[] | null ?? [];
}

async function writeCompanyRecords(ctx: PluginContext, companyId: string, records: WorkflowRecord[]): Promise<void> {
  await ctx.state.set(companyScope(companyId, STATE_KEYS.records), records);
}

async function appendCompanyRecord(ctx: PluginContext, companyId: string, record: WorkflowRecord): Promise<void> {
  const config = await getConfig(ctx);
  const current = await readCompanyRecords(ctx, companyId);
  const next = [record, ...current].slice(0, Math.max(1, config.maxStoredRecords));
  await writeCompanyRecords(ctx, companyId, next);
}

async function readLeadPipeline(ctx: PluginContext, companyId: string): Promise<LeadPipelineEntry[]> {
  return await ctx.state.get(companyScope(companyId, STATE_KEYS.leadPipeline)) as LeadPipelineEntry[] | null ?? [];
}

async function writeLeadPipeline(ctx: PluginContext, companyId: string, records: LeadPipelineEntry[]): Promise<void> {
  await ctx.state.set(companyScope(companyId, STATE_KEYS.leadPipeline), records);
}

async function upsertLeadPipelineEntry(ctx: PluginContext, companyId: string, entry: LeadPipelineEntry): Promise<void> {
  const current = await readLeadPipeline(ctx, companyId);
  const entryKey = entry.issueId
    ? `issue:${entry.issueId}`
    : `${entry.leadName.toLowerCase()}|${(entry.organization ?? "").toLowerCase()}`;
  const next = current.filter((candidate) => {
    const candidateKey = candidate.issueId
      ? `issue:${candidate.issueId}`
      : `${candidate.leadName.toLowerCase()}|${(candidate.organization ?? "").toLowerCase()}`;
    return candidateKey !== entryKey;
  });
  next.unshift(entry);
  next.sort((left, right) => toTimeValue(right.updatedAt) - toTimeValue(left.updatedAt));
  await writeLeadPipeline(ctx, companyId, next.slice(0, 100));
}

async function createActionItemChildren(
  ctx: PluginContext,
  input: { companyId: string; projectId?: string; parentIssueId: string; actionItems: ReturnType<typeof extractActionItems> },
): Promise<string[]> {
  const childIssueIds: string[] = [];
  for (const item of input.actionItems) {
    const descriptionParts = [
      item.raw,
      item.owner ? `Owner: ${item.owner}` : null,
      item.due ? `Due: ${item.due}` : null,
    ].filter((part): part is string => Boolean(part));

    const child = await ctx.issues.create({
      companyId: input.companyId,
      projectId: input.projectId,
      parentId: input.parentIssueId,
      title: item.title,
      description: descriptionParts.join("\n"),
    });
    childIssueIds.push(child.id);
  }
  return childIssueIds;
}

async function findLeadIssue(
  ctx: PluginContext,
  companyId: string,
  leadName: string,
): Promise<Issue | null> {
  const issues = await ctx.issues.list({ companyId, limit: 200, offset: 0 });
  const target = leadName.trim().toLowerCase();
  return issues.find((issue) => issue.title.toLowerCase().startsWith(`lead: ${target}`)) ?? null;
}

async function ensureLeadFollowUpIssue(
  ctx: PluginContext,
  input: { companyId: string; projectId?: string; parentIssueId: string; leadName: string; nextStep: string; nextFollowUp?: string | null },
): Promise<string | null> {
  const currentIssues = await ctx.issues.list({ companyId: input.companyId, limit: 200, offset: 0 });
  const existing = currentIssues.find((issue) => issue.parentId === input.parentIssueId && issue.title.startsWith(`Lead follow-up: ${input.leadName}`) && isOpenIssue(issue));
  if (existing) return existing.id;

  const followUp = await ctx.issues.create({
    companyId: input.companyId,
    projectId: input.projectId,
    parentId: input.parentIssueId,
    title: `Lead follow-up: ${input.leadName}`,
    description: [
      input.nextStep,
      input.nextFollowUp ? `Target follow-up date: ${input.nextFollowUp}` : null,
    ].filter((part): part is string => Boolean(part)).join("\n"),
  });

  return followUp.id;
}

async function buildOverview(ctx: PluginContext, companyId: string): Promise<WorkflowOverview> {
  const company = await ctx.companies.get(companyId);
  const projects = await ctx.projects.list({ companyId, limit: 100, offset: 0 });
  const issues = await ctx.issues.list({ companyId, limit: 100, offset: 0 });
  const goals = await ctx.goals.list({ companyId, limit: 50, offset: 0 });
  const agents = await ctx.agents.list({ companyId, limit: 50, offset: 0 });
  const recentRecords = await readCompanyRecords(ctx, companyId);
  const leadPipeline = await readLeadPipeline(ctx, companyId);
  const latestDailyBrief = await ctx.state.get(companyScope(companyId, STATE_KEYS.latestDailyBrief)) as WorkflowOverview["latestDailyBrief"];
  const latestProposalDraft = await ctx.state.get(companyScope(companyId, STATE_KEYS.latestProposalDraft)) as WorkflowOverview["latestProposalDraft"];
  const latestEmailReply = await ctx.state.get(companyScope(companyId, STATE_KEYS.latestEmailReply)) as WorkflowOverview["latestEmailReply"];
  const latestFocusPlan = await ctx.state.get(companyScope(companyId, STATE_KEYS.latestFocusPlan)) as WorkflowOverview["latestFocusPlan"];
  const latestMissionControlPlan = await ctx.state.get(companyScope(companyId, STATE_KEYS.latestMissionControlPlan)) as WorkflowOverview["latestMissionControlPlan"];
  const latestContentCampaign = await ctx.state.get(companyScope(companyId, STATE_KEYS.latestContentCampaign)) as WorkflowOverview["latestContentCampaign"];
  const latestWatchdogReport = await ctx.state.get(companyScope(companyId, STATE_KEYS.latestWatchdogReport)) as WorkflowOverview["latestWatchdogReport"];
  const openIssues = issues.filter(isOpenIssue).slice(0, 8).map((issue) => ({ id: issue.id, title: issue.title, status: issue.status }));
  const activeGoals = goals.filter(isActiveGoal).slice(0, 5).map((goal) => ({ id: goal.id, title: goal.title, status: goal.status }));

  return {
    companyId,
    companyName: company?.name ?? companyId,
    projects: projects.map((project) => ({ id: project.id, name: project.name })),
    agents: agents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status, role: agent.role })),
    leadPipeline,
    recentRecords,
    latestDailyBrief,
    latestProposalDraft,
    latestEmailReply,
    latestFocusPlan,
    latestMissionControlPlan,
    latestContentCampaign,
    latestWatchdogReport,
    openIssues,
    activeGoals,
    counts: {
      records: recentRecords.length,
      openIssues: issues.filter(isOpenIssue).length,
      activeGoals: goals.filter(isActiveGoal).length,
      projects: projects.length,
      agents: agents.length,
      leadPipeline: leadPipeline.length,
      followUpsDue: leadPipeline.filter(isFollowUpDue).length,
    },
  };
}

async function generateDailyBrief(ctx: PluginContext, companyId: string): Promise<MarkdownPayload> {
  const config = await getConfig(ctx);
  const company = await ctx.companies.get(companyId);
  const issues = await ctx.issues.list({ companyId, limit: config.dailyBriefIssueLimit, offset: 0 });
  const goals = await ctx.goals.list({ companyId, limit: 20, offset: 0 });
  const recentRecords = await readCompanyRecords(ctx, companyId);
  const markdown = buildDailyBriefMarkdown({
    companyName: company?.name ?? companyId,
    openIssueTitles: issues.filter(isOpenIssue).map((issue) => issue.title),
    activeGoalTitles: goals.filter(isActiveGoal).map((goal) => goal.title),
    recentRecords,
  });
  const payload = { createdAt: new Date().toISOString(), markdown };
  await ctx.state.set(companyScope(companyId, STATE_KEYS.latestDailyBrief), payload);
  await appendCompanyRecord(ctx, companyId, toRecord("daily_brief", `Daily brief for ${company?.name ?? companyId}`, "Generated company daily brief"));
  await ctx.activity.log({
    companyId,
    message: "Business Workflows generated a daily brief",
    metadata: { plugin: PLUGIN_ID },
  });
  await ctx.metrics.write("daily_brief.generated", 1, { companyId });
  return payload;
}

async function generateProposalDraft(
  ctx: PluginContext,
  input: { companyId: string; title: string; notes: string; issueId?: string },
): Promise<ProposalPayload> {
  const markdown = buildProposalMarkdown({ title: input.title, notes: input.notes });
  const payload = { createdAt: new Date().toISOString(), markdown, title: input.title };
  if (input.issueId) {
    await ctx.issues.documents.upsert({
      companyId: input.companyId,
      issueId: input.issueId,
      key: DOCUMENT_KEYS.proposalDraft,
      title: `${input.title} Proposal Draft`,
      format: "markdown",
      body: markdown,
      changeSummary: "Generated proposal draft from notes",
    });
  }
  await ctx.state.set(companyScope(input.companyId, STATE_KEYS.latestProposalDraft), payload);
  await appendCompanyRecord(ctx, input.companyId, toRecord("proposal_draft", `Proposal draft: ${input.title}`, summarizeTranscript(input.notes)));
  await ctx.metrics.write("proposal.generated", 1, { companyId: input.companyId });
  return payload;
}

async function generateEmailReply(
  ctx: PluginContext,
  input: { companyId: string; subject: string; thread: string; senderName?: string; desiredOutcome?: string; issueId?: string },
): Promise<EmailReplyPayload> {
  const config = await getConfig(ctx);
  const company = await ctx.companies.get(input.companyId);
  const markdown = buildEmailReplyMarkdown({
    subject: input.subject,
    senderName: input.senderName,
    thread: input.thread,
    desiredOutcome: input.desiredOutcome,
    tone: config.defaultEmailTone,
    companyName: company?.name,
  });
  const payload = { createdAt: new Date().toISOString(), markdown, subject: input.subject };
  if (input.issueId) {
    await ctx.issues.documents.upsert({
      companyId: input.companyId,
      issueId: input.issueId,
      key: DOCUMENT_KEYS.emailReply,
      title: `${input.subject} Email Reply`,
      format: "markdown",
      body: markdown,
      changeSummary: "Generated email reply draft",
    });
  }
  await ctx.state.set(companyScope(input.companyId, STATE_KEYS.latestEmailReply), payload);
  await appendCompanyRecord(ctx, input.companyId, toRecord("email_reply", `Email reply: ${input.subject}`, summarizeTranscript(input.thread)));
  await ctx.metrics.write("email.reply.generated", 1, { companyId: input.companyId });
  return payload;
}

async function ingestMeetingTranscript(ctx: PluginContext, params: Record<string, unknown>) {
  const companyId = requireString(params, "companyId");
  const config = await getConfig(ctx);
  const title = optionalString(params.title) ?? "Meeting Follow-up";
  const transcript = requireString(params, "transcript");
  const projectId = optionalString(params.projectId) || config.defaultProjectId || undefined;
  const summary = summarizeTranscript(transcript);
  const actionItems = extractActionItems(transcript);

  const parentIssue = await ctx.issues.create({
    companyId,
    projectId,
    title: `Meeting: ${title}`,
    description: summary || "Meeting transcript ingested by Business Workflows.",
  });

  await ctx.issues.documents.upsert({
    companyId,
    issueId: parentIssue.id,
    key: DOCUMENT_KEYS.meetingTranscript,
    title: `${title} Transcript`,
    format: "markdown",
    body: transcript,
    changeSummary: "Initial meeting transcript import",
  });

  const proposal = await generateProposalDraft(ctx, {
    companyId,
    title,
    notes: transcript,
    issueId: config.autoAttachProposalDraft ? parentIssue.id : undefined,
  });

  const childIssueIds = config.autoCreateMeetingTasks
    ? await createActionItemChildren(ctx, { companyId, projectId, parentIssueId: parentIssue.id, actionItems })
    : [];

  await appendCompanyRecord(ctx, companyId, toRecord("meeting_transcript", `Meeting: ${title}`, summary, {
    issueId: parentIssue.id,
    childIssueIds,
    details: {
      actionItemCount: actionItems.length,
      proposalGeneratedAt: proposal.createdAt,
    },
  }));
  await ctx.activity.log({
    companyId,
    entityType: "issue",
    entityId: parentIssue.id,
    message: `Business Workflows ingested meeting transcript "${title}"`,
    metadata: { plugin: PLUGIN_ID, childIssueCount: childIssueIds.length },
  });
  await ctx.metrics.write("meeting_transcript.ingested", 1, {
    companyId,
    tasks: String(childIssueIds.length),
  });

  return {
    parentIssueId: parentIssue.id,
    actionItemCount: actionItems.length,
    createdTaskCount: childIssueIds.length,
    proposalMarkdown: proposal.markdown,
  };
}

async function ingestEmailThread(ctx: PluginContext, params: Record<string, unknown>) {
  const companyId = requireString(params, "companyId");
  const config = await getConfig(ctx);
  const subject = requireString(params, "subject");
  const thread = requireString(params, "thread");
  const projectId = optionalString(params.projectId) || config.defaultProjectId || undefined;
  const fromName = optionalString(params.fromName);
  const fromEmail = optionalString(params.fromEmail);
  const desiredOutcome = optionalString(params.desiredOutcome);
  const summary = summarizeTranscript(thread);
  const actionItems = extractActionItems(thread);

  const issue = await ctx.issues.create({
    companyId,
    projectId,
    title: `Email: ${subject}`,
    description: [
      fromName ? `From: ${fromName}` : null,
      fromEmail ? `Email: ${fromEmail}` : null,
      summary,
    ].filter((part): part is string => Boolean(part)).join("\n\n"),
  });

  await ctx.issues.documents.upsert({
    companyId,
    issueId: issue.id,
    key: DOCUMENT_KEYS.emailThread,
    title: `${subject} Email Thread`,
    format: "markdown",
    body: [
      `# Email Thread — ${subject}`,
      "",
      fromName ? `From: ${fromName}` : null,
      fromEmail ? `From Email: ${fromEmail}` : null,
      desiredOutcome ? `Desired Outcome: ${desiredOutcome}` : null,
      "",
      "## Thread",
      thread,
    ].filter((line): line is string => Boolean(line)).join("\n"),
    changeSummary: "Imported email thread for triage",
  });

  const reply = await generateEmailReply(ctx, {
    companyId,
    subject,
    thread,
    senderName: fromName ?? fromEmail,
    desiredOutcome,
    issueId: issue.id,
  });

  const childIssueIds = actionItems.length > 0
    ? await createActionItemChildren(ctx, { companyId, projectId, parentIssueId: issue.id, actionItems })
    : [];

  await appendCompanyRecord(ctx, companyId, toRecord("email_triage", `Email: ${subject}`, summary, {
    issueId: issue.id,
    childIssueIds,
    details: {
      desiredOutcome,
      from: fromName ?? fromEmail ?? null,
    },
  }));
  await ctx.activity.log({
    companyId,
    entityType: "issue",
    entityId: issue.id,
    message: `Business Workflows ingested email thread "${subject}"`,
    metadata: { plugin: PLUGIN_ID, childIssueCount: childIssueIds.length },
  });
  await ctx.metrics.write("email.triage.ingested", 1, { companyId, tasks: String(childIssueIds.length) });

  return {
    issueId: issue.id,
    createdTaskCount: childIssueIds.length,
    replyMarkdown: reply.markdown,
  };
}

async function ingestCalendarEvent(ctx: PluginContext, params: Record<string, unknown>) {
  const companyId = requireString(params, "companyId");
  const config = await getConfig(ctx);
  const title = requireString(params, "title");
  const notes = optionalString(params.notes) ?? "";
  const startsAt = optionalString(params.startsAt);
  const attendees = optionalStringArray(params.attendees) ?? [];
  const projectId = optionalString(params.projectId) || config.defaultProjectId || undefined;
  const actionItems = notes ? extractActionItems(notes) : [];
  const summary = notes ? summarizeTranscript(notes) : `${title}${startsAt ? ` starts at ${startsAt}` : ""}`;

  const issue = await ctx.issues.create({
    companyId,
    projectId,
    title: `Calendar: ${title}`,
    description: [
      startsAt ? `Starts: ${startsAt}` : null,
      attendees.length > 0 ? `Attendees: ${attendees.join(", ")}` : null,
      summary,
    ].filter((part): part is string => Boolean(part)).join("\n\n"),
  });

  await ctx.issues.documents.upsert({
    companyId,
    issueId: issue.id,
    key: DOCUMENT_KEYS.calendarEvent,
    title: `${title} Calendar Event`,
    format: "markdown",
    body: [
      `# Calendar Event — ${title}`,
      "",
      startsAt ? `Starts: ${startsAt}` : null,
      attendees.length > 0 ? `Attendees: ${attendees.join(", ")}` : null,
      "",
      "## Notes",
      notes || "No notes provided.",
    ].filter((line): line is string => Boolean(line)).join("\n"),
    changeSummary: "Imported calendar event notes",
  });

  const childIssueIds = config.autoCreateCalendarTasks
    ? await createActionItemChildren(ctx, { companyId, projectId, parentIssueId: issue.id, actionItems })
    : [];

  await appendCompanyRecord(ctx, companyId, toRecord("calendar_event", `Calendar: ${title}`, summary, {
    issueId: issue.id,
    childIssueIds,
    details: {
      startsAt,
      attendees,
    },
  }));
  await ctx.activity.log({
    companyId,
    entityType: "issue",
    entityId: issue.id,
    message: `Business Workflows ingested calendar event "${title}"`,
    metadata: { plugin: PLUGIN_ID, childIssueCount: childIssueIds.length },
  });
  await ctx.metrics.write("calendar.ingested", 1, { companyId, tasks: String(childIssueIds.length) });

  return {
    issueId: issue.id,
    createdTaskCount: childIssueIds.length,
  };
}

async function planFocusBlocks(ctx: PluginContext, params: Record<string, unknown>): Promise<FocusPlanPayload> {
  const companyId = requireString(params, "companyId");
  const config = await getConfig(ctx);
  const company = await ctx.companies.get(companyId);
  const date = optionalString(params.date) ?? new Date().toISOString().slice(0, 10);
  const hours = optionalNumber(params.hours) ?? 4;
  const preferredStart = optionalString(params.preferredStart) ?? "09:00";
  const issues = await ctx.issues.list({ companyId, limit: 100, offset: 0 });
  const goals = await ctx.goals.list({ companyId, limit: 20, offset: 0 });
  const blocks = buildFocusBlocks(issues, goals, preferredStart, config.focusBlockMinutes, hours);
  const markdown = buildFocusPlanMarkdown({
    companyName: company?.name ?? companyId,
    date,
    blocks,
    openIssueTitles: sortIssuesForFocus(issues.filter(isOpenIssue)).map((issue) => issue.title),
    activeGoalTitles: goals.filter(isActiveGoal).map((goal) => goal.title),
  });
  const payload = { createdAt: new Date().toISOString(), markdown, date };
  await ctx.state.set(companyScope(companyId, STATE_KEYS.latestFocusPlan), payload);
  await appendCompanyRecord(ctx, companyId, toRecord("focus_plan", `Focus plan for ${date}`, `Generated ${blocks.length} focus blocks`));
  await ctx.metrics.write("focus.plan.generated", 1, { companyId, blocks: String(blocks.length) });
  return payload;
}

async function ingestLead(ctx: PluginContext, params: Record<string, unknown>) {
  const companyId = requireString(params, "companyId");
  const config = await getConfig(ctx);
  const leadName = requireString(params, "leadName");
  const organization = optionalString(params.organization);
  const need = optionalString(params.need) ?? "";
  const notes = optionalString(params.notes) ?? "";
  const source = optionalString(params.source) ?? "manual";
  const projectId = optionalString(params.projectId) || config.defaultProjectId || undefined;

  const issue = await ctx.issues.create({
    companyId,
    projectId,
    title: leadIssueTitle(leadName, organization),
    description: [
      need ? `Need: ${need}` : null,
      `Source: ${source}`,
      notes || null,
    ].filter((part): part is string => Boolean(part)).join("\n\n"),
  });

  if (notes) {
    await ctx.issues.documents.upsert({
      companyId,
      issueId: issue.id,
      key: DOCUMENT_KEYS.leadNotes,
      title: `${leadName} Lead Notes`,
      format: "markdown",
      body: notes,
      changeSummary: "Lead intake notes saved",
    });
  }

  const pipelineEntry: LeadPipelineEntry = {
    issueId: issue.id,
    leadName,
    organization,
    stage: "new",
    score: scoreLeadStage("new"),
    nextStep: need || undefined,
    nextFollowUp: null,
    updatedAt: new Date().toISOString(),
    summary: need || notes || undefined,
    source,
  };

  await upsertLeadPipelineEntry(ctx, companyId, pipelineEntry);
  await ctx.issues.documents.upsert({
    companyId,
    issueId: issue.id,
    key: DOCUMENT_KEYS.leadPipeline,
    title: `${leadName} Pipeline State`,
    format: "markdown",
    body: buildLeadPipelineMarkdown(pipelineEntry),
    changeSummary: "Initialized lead pipeline record",
  });

  await appendCompanyRecord(ctx, companyId, toRecord("lead", `Lead: ${leadName}`, need || notes, { issueId: issue.id }));
  await ctx.activity.log({
    companyId,
    entityType: "issue",
    entityId: issue.id,
    message: `Business Workflows created a lead issue for ${leadName}`,
    metadata: { plugin: PLUGIN_ID, source },
  });
  await ctx.metrics.write("lead.ingested", 1, { companyId, source });

  return { issueId: issue.id };
}

async function updateLeadPipeline(ctx: PluginContext, params: Record<string, unknown>) {
  const companyId = requireString(params, "companyId");
  const config = await getConfig(ctx);
  const projectId = optionalString(params.projectId) || config.defaultProjectId || undefined;
  const explicitIssueId = optionalString(params.issueId);
  const requestedLeadName = optionalString(params.leadName);
  const organization = optionalString(params.organization);
  const stage = normalizeStage(optionalString(params.stage), "qualified");
  const nextStep = optionalString(params.nextStep);
  const nextFollowUp = optionalString(params.nextFollowUp) ?? null;
  const notes = optionalString(params.notes);
  const source = optionalString(params.source) ?? "pipeline";

  let issue = explicitIssueId ? await ctx.issues.get(explicitIssueId, companyId) : null;
  if (!issue && requestedLeadName) {
    issue = await findLeadIssue(ctx, companyId, requestedLeadName);
  }

  if (!issue) {
    if (!requestedLeadName) {
      throw new Error("leadName or issueId is required to update the lead pipeline");
    }
    const created = await ingestLead(ctx, {
      companyId,
      projectId,
      leadName: requestedLeadName,
      organization,
      need: nextStep ?? notes ?? "Lead pipeline created from stage update",
      notes: notes ?? "",
      source,
    });
    issue = await ctx.issues.get(created.issueId, companyId);
  }

  if (!issue) {
    throw new Error("Lead issue could not be resolved");
  }

  const leadName = requestedLeadName ?? parseLeadNameFromTitle(issue.title);
  const score = optionalNumber(params.score) ?? scoreLeadStage(stage);
  const updatedDescription = [
    issue.description,
    notes ? `Pipeline update: ${notes}` : null,
  ].filter((part): part is string => Boolean(part)).join("\n\n") || issue.description || null;

  const updatedIssue = await ctx.issues.update(issue.id, {
    title: leadIssueTitle(leadName, organization),
    status: mapLeadStageToIssueStatus(stage),
    description: updatedDescription,
  }, companyId);

  let followUpIssueId: string | null = null;
  if (config.autoCreateLeadFollowUps && nextStep && stage !== "won" && stage !== "lost") {
    followUpIssueId = await ensureLeadFollowUpIssue(ctx, {
      companyId,
      projectId,
      parentIssueId: updatedIssue.id,
      leadName,
      nextStep,
      nextFollowUp,
    });
  }

  const pipelineEntry: LeadPipelineEntry = {
    issueId: updatedIssue.id,
    leadName,
    organization,
    stage,
    score,
    nextStep: nextStep ?? undefined,
    nextFollowUp,
    updatedAt: new Date().toISOString(),
    summary: notes ?? updatedIssue.description ?? undefined,
    source,
  };
  const markdown = buildLeadPipelineMarkdown(pipelineEntry);

  await upsertLeadPipelineEntry(ctx, companyId, pipelineEntry);
  await ctx.issues.documents.upsert({
    companyId,
    issueId: updatedIssue.id,
    key: DOCUMENT_KEYS.leadPipeline,
    title: `${leadName} Pipeline State`,
    format: "markdown",
    body: markdown,
    changeSummary: "Updated lead pipeline state",
  });

  await appendCompanyRecord(ctx, companyId, toRecord("lead_pipeline", `Lead pipeline: ${leadName}`, notes ?? `Moved to ${stage}`, {
    issueId: updatedIssue.id,
    childIssueIds: followUpIssueId ? [followUpIssueId] : undefined,
    details: { stage, score, nextFollowUp },
  }));
  await ctx.activity.log({
    companyId,
    entityType: "issue",
    entityId: updatedIssue.id,
    message: `Business Workflows updated the lead pipeline for ${leadName} to ${stage}`,
    metadata: { plugin: PLUGIN_ID, score },
  });
  await ctx.metrics.write("lead.pipeline.updated", 1, { companyId, stage });

  return {
    issueId: updatedIssue.id,
    stage,
    score,
    followUpIssueId,
    markdown,
  };
}

async function queueContentRepurpose(ctx: PluginContext, params: Record<string, unknown>) {
  const companyId = requireString(params, "companyId");
  const config = await getConfig(ctx);
  const sourceTitle = requireString(params, "sourceTitle");
  const sourceSummary = optionalString(params.sourceSummary) ?? "";
  const projectId = optionalString(params.projectId) || config.defaultProjectId || undefined;
  const platforms = normalizePlatforms(optionalStringArray(params.platforms), config.contentPlatforms);

  const parentIssue = await ctx.issues.create({
    companyId,
    projectId,
    title: `Repurpose: ${sourceTitle}`,
    description: sourceSummary || "Repurpose source material across channels.",
  });

  const childIssueIds: string[] = [];
  for (const platform of platforms) {
    const child = await ctx.issues.create({
      companyId,
      projectId,
      parentId: parentIssue.id,
      title: `Repurpose for ${platform}`,
      description: `Create ${platform} output for "${sourceTitle}".`,
    });
    childIssueIds.push(child.id);
  }

  await appendCompanyRecord(ctx, companyId, toRecord("content_repurpose", `Repurpose: ${sourceTitle}`, sourceSummary, {
    issueId: parentIssue.id,
    childIssueIds,
    details: { platforms },
  }));
  await ctx.metrics.write("content_repurpose.queued", 1, { companyId, platformCount: String(platforms.length) });

  return { parentIssueId: parentIssue.id, childIssueIds, platforms };
}

async function generateContentCampaign(ctx: PluginContext, params: Record<string, unknown>) {
  const companyId = requireString(params, "companyId");
  const config = await getConfig(ctx);
  const campaignName = requireString(params, "campaignName");
  const sourceTitle = requireString(params, "sourceTitle");
  const sourceSummary = requireString(params, "sourceSummary");
  const angle = optionalString(params.angle);
  const callToAction = optionalString(params.callToAction);
  const projectId = optionalString(params.projectId) || config.defaultProjectId || undefined;
  const platforms = normalizePlatforms(optionalStringArray(params.platforms), config.contentPlatforms);

  const parentIssue = await ctx.issues.create({
    companyId,
    projectId,
    title: `Campaign: ${campaignName}`,
    description: `${sourceTitle}\n\n${sourceSummary}`,
  });

  const childIssueIds: string[] = [];
  for (const platform of platforms) {
    const child = await ctx.issues.create({
      companyId,
      projectId,
      parentId: parentIssue.id,
      title: `Campaign / ${platform}: ${campaignName}`,
      description: `Draft the ${platform} asset for ${campaignName}.`,
    });
    childIssueIds.push(child.id);
  }

  const markdown = buildContentCampaignMarkdown({
    campaignName,
    sourceTitle,
    sourceSummary,
    platforms,
    angle,
    callToAction,
  });
  const payload = { createdAt: new Date().toISOString(), markdown, title: campaignName };

  await ctx.issues.documents.upsert({
    companyId,
    issueId: parentIssue.id,
    key: DOCUMENT_KEYS.contentCampaign,
    title: `${campaignName} Campaign Pack`,
    format: "markdown",
    body: markdown,
    changeSummary: "Generated multi-platform campaign pack",
  });
  await ctx.state.set(companyScope(companyId, STATE_KEYS.latestContentCampaign), payload);
  await appendCompanyRecord(ctx, companyId, toRecord("content_campaign", `Campaign: ${campaignName}`, summarizeTranscript(sourceSummary), {
    issueId: parentIssue.id,
    childIssueIds,
    details: { platforms, sourceTitle },
  }));
  await ctx.activity.log({
    companyId,
    entityType: "issue",
    entityId: parentIssue.id,
    message: `Business Workflows generated a content campaign for ${campaignName}`,
    metadata: { plugin: PLUGIN_ID, platformCount: platforms.length },
  });
  await ctx.metrics.write("content_campaign.generated", 1, { companyId, platformCount: String(platforms.length) });

  return {
    parentIssueId: parentIssue.id,
    childIssueIds,
    platforms,
    markdown,
  };
}

async function launchMissionControl(ctx: PluginContext, params: Record<string, unknown>) {
  const companyId = requireString(params, "companyId");
  const config = await getConfig(ctx);
  const company = await ctx.companies.get(companyId);
  const objective = requireString(params, "objective");
  const projectId = optionalString(params.projectId) || config.defaultProjectId || undefined;
  const lanes = normalizeLaneNames(optionalStringArray(params.lanes), config.missionControlLanes);
  const requestedAgentIds = optionalStringArray(params.agentIds) ?? [];
  const invokeAgents = optionalBoolean(params.invokeAgents) ?? false;
  const allAgents = await ctx.agents.list({ companyId, limit: 100, offset: 0 });
  const selectedAgents = requestedAgentIds.length > 0
    ? allAgents.filter((agent) => requestedAgentIds.includes(agent.id))
    : allAgents.slice(0, lanes.length);
  const openIssues = await ctx.issues.list({ companyId, limit: 100, offset: 0 });
  const activeGoals = await ctx.goals.list({ companyId, limit: 20, offset: 0 });

  const goal = await ctx.goals.create({
    companyId,
    title: `Mission Control: ${objective}`,
    description: `Coordinate cross-functional execution for ${objective}.`,
    level: "team",
    status: "active",
  });

  const parentIssue = await ctx.issues.create({
    companyId,
    projectId,
    goalId: goal.id,
    title: `Mission Control: ${objective}`,
    description: `Coordinate ${lanes.length} execution lanes for ${objective}.`,
  });

  const lanePlans = lanes.map((lane, index) => ({
    lane,
    owner: selectedAgents.length > 0 ? selectedAgents[index % selectedAgents.length]?.name ?? null : null,
    focus: laneFocusForObjective(lane, objective),
  }));

  const childIssueIds: string[] = [];
  for (const lanePlan of lanePlans) {
    const child = await ctx.issues.create({
      companyId,
      projectId,
      parentId: parentIssue.id,
      goalId: goal.id,
      title: `Mission Control / ${lanePlan.lane}`,
      description: [
        lanePlan.focus,
        lanePlan.owner ? `Suggested owner agent: ${lanePlan.owner}` : null,
      ].filter((part): part is string => Boolean(part)).join("\n\n"),
    });
    childIssueIds.push(child.id);
  }

  const markdown = buildMissionControlMarkdown({
    companyName: company?.name ?? companyId,
    objective,
    lanePlans,
    openIssueTitles: openIssues.filter(isOpenIssue).map((issue) => issue.title),
    activeGoalTitles: activeGoals.filter(isActiveGoal).map((item) => item.title),
    riskTitles: openIssues.filter((issue) => issue.status === "blocked").map((issue) => issue.title),
  });
  const payload = { createdAt: new Date().toISOString(), markdown, objective };

  await ctx.issues.documents.upsert({
    companyId,
    issueId: parentIssue.id,
    key: DOCUMENT_KEYS.missionControlPlan,
    title: `${objective} Mission Control Plan`,
    format: "markdown",
    body: markdown,
    changeSummary: "Generated mission control plan",
  });
  await ctx.state.set(companyScope(companyId, STATE_KEYS.latestMissionControlPlan), payload);

  const invokedAgentIds: string[] = [];
  if (invokeAgents) {
    for (const [index, agent] of selectedAgents.entries()) {
      const lanePlan = lanePlans[index % lanePlans.length];
      await ctx.agents.invoke(agent.id, companyId, {
        prompt: buildMissionControlPrompt(objective, lanePlan.lane, lanePlan.focus),
        reason: "Business Workflows mission control launch",
      });
      invokedAgentIds.push(agent.id);
    }
  }

  await appendCompanyRecord(ctx, companyId, toRecord("mission_control", `Mission Control: ${objective}`, `Created ${lanePlans.length} execution lanes`, {
    issueId: parentIssue.id,
    childIssueIds,
    details: { goalId: goal.id, invokedAgentIds },
  }));
  await ctx.activity.log({
    companyId,
    entityType: "issue",
    entityId: parentIssue.id,
    message: `Business Workflows launched mission control for ${objective}`,
    metadata: { plugin: PLUGIN_ID, lanes: lanes.length, invokedAgents: invokedAgentIds.length },
  });
  await ctx.metrics.write("mission_control.launched", 1, { companyId, lanes: String(lanes.length) });

  return {
    goalId: goal.id,
    parentIssueId: parentIssue.id,
    childIssueIds,
    invokedAgentIds,
  };
}

async function runPipelineWatchdog(ctx: PluginContext, companyId: string): Promise<MarkdownPayload & { blockedIssueCount: number; staleIssueCount: number; followUpsDueCount: number }> {
  const config = await getConfig(ctx);
  const company = await ctx.companies.get(companyId);
  const issues = await ctx.issues.list({ companyId, limit: 200, offset: 0 });
  const recentRecords = await readCompanyRecords(ctx, companyId);
  const leadPipeline = await readLeadPipeline(ctx, companyId);
  const cutoff = Date.now() - (config.watchdogStaleIssueHours * 60 * 60 * 1000);
  const blockedIssues = issues.filter((issue) => issue.status === "blocked");
  const staleIssues = issues.filter((issue) => isOpenIssue(issue) && toTimeValue(issue.updatedAt) > 0 && toTimeValue(issue.updatedAt) < cutoff);
  const followUpsDue = leadPipeline.filter(isFollowUpDue);
  const markdown = buildWatchdogMarkdown({
    companyName: company?.name ?? companyId,
    blockedIssueTitles: blockedIssues.map((issue) => issue.title),
    staleIssueTitles: staleIssues.map((issue) => issue.title),
    followUpsDue: followUpsDue.map((entry) => `${entry.leadName}${entry.nextStep ? ` — ${entry.nextStep}` : ""}`),
    recentRecords,
  });
  const payload = {
    createdAt: new Date().toISOString(),
    markdown,
    blockedIssueCount: blockedIssues.length,
    staleIssueCount: staleIssues.length,
    followUpsDueCount: followUpsDue.length,
  };
  await ctx.state.set(companyScope(companyId, STATE_KEYS.latestWatchdogReport), { createdAt: payload.createdAt, markdown: payload.markdown });
  await appendCompanyRecord(ctx, companyId, toRecord("watchdog", `Watchdog report for ${company?.name ?? companyId}`, `Blocked: ${blockedIssues.length}, stale: ${staleIssues.length}, follow-ups due: ${followUpsDue.length}`));
  await ctx.activity.log({
    companyId,
    message: "Business Workflows generated a watchdog report",
    metadata: {
      plugin: PLUGIN_ID,
      blockedIssueCount: blockedIssues.length,
      staleIssueCount: staleIssues.length,
      followUpsDueCount: followUpsDue.length,
    },
  });
  await ctx.metrics.write("watchdog.generated", 1, {
    companyId,
    blocked: String(blockedIssues.length),
    stale: String(staleIssues.length),
    followUps: String(followUpsDue.length),
  });
  return payload;
}

async function registerDataHandlers(ctx: PluginContext): Promise<void> {
  ctx.data.register(DATA_KEYS.overview, async (params) => {
    const companyId = requireString(params, "companyId");
    return await buildOverview(ctx, companyId);
  });
}

async function registerActionHandlers(ctx: PluginContext): Promise<void> {
  ctx.actions.register(ACTION_KEYS.ingestMeetingTranscript, async (params) => {
    actionsRun += 1;
    return await ingestMeetingTranscript(ctx, params);
  });

  ctx.actions.register(ACTION_KEYS.generateProposalDraft, async (params) => {
    actionsRun += 1;
    return await generateProposalDraft(ctx, {
      companyId: requireString(params, "companyId"),
      title: requireString(params, "title"),
      notes: requireString(params, "notes"),
      issueId: optionalString(params.issueId),
    });
  });

  ctx.actions.register(ACTION_KEYS.ingestLead, async (params) => {
    actionsRun += 1;
    return await ingestLead(ctx, params);
  });

  ctx.actions.register(ACTION_KEYS.updateLeadPipeline, async (params) => {
    actionsRun += 1;
    return await updateLeadPipeline(ctx, params);
  });

  ctx.actions.register(ACTION_KEYS.queueContentRepurpose, async (params) => {
    actionsRun += 1;
    return await queueContentRepurpose(ctx, params);
  });

  ctx.actions.register(ACTION_KEYS.generateContentCampaign, async (params) => {
    actionsRun += 1;
    return await generateContentCampaign(ctx, params);
  });

  ctx.actions.register(ACTION_KEYS.generateDailyBrief, async (params) => {
    actionsRun += 1;
    return await generateDailyBrief(ctx, requireString(params, "companyId"));
  });

  ctx.actions.register(ACTION_KEYS.ingestEmailThread, async (params) => {
    actionsRun += 1;
    return await ingestEmailThread(ctx, params);
  });

  ctx.actions.register(ACTION_KEYS.generateEmailReply, async (params) => {
    actionsRun += 1;
    return await generateEmailReply(ctx, {
      companyId: requireString(params, "companyId"),
      subject: requireString(params, "subject"),
      thread: requireString(params, "thread"),
      senderName: optionalString(params.senderName),
      desiredOutcome: optionalString(params.desiredOutcome),
      issueId: optionalString(params.issueId),
    });
  });

  ctx.actions.register(ACTION_KEYS.ingestCalendarEvent, async (params) => {
    actionsRun += 1;
    return await ingestCalendarEvent(ctx, params);
  });

  ctx.actions.register(ACTION_KEYS.planFocusBlocks, async (params) => {
    actionsRun += 1;
    return await planFocusBlocks(ctx, params);
  });

  ctx.actions.register(ACTION_KEYS.launchMissionControl, async (params) => {
    actionsRun += 1;
    return await launchMissionControl(ctx, params);
  });

  ctx.actions.register(ACTION_KEYS.runPipelineWatchdog, async (params) => {
    actionsRun += 1;
    return await runPipelineWatchdog(ctx, requireString(params, "companyId"));
  });
}

async function registerToolHandlers(ctx: PluginContext): Promise<void> {
  ctx.tools.register(
    TOOL_KEYS.proposalDraftFromNotes,
    {
      displayName: "Proposal Draft From Notes",
      description: "Generate a markdown proposal draft from notes.",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          notes: { type: "string" },
        },
        required: ["title", "notes"],
      },
    },
    async (params): Promise<ToolResult> => {
      const payload = params as { title?: string; notes?: string };
      if (!payload.title || !payload.notes) {
        return { error: "title and notes are required" };
      }
      const markdown = buildProposalMarkdown({ title: payload.title, notes: payload.notes });
      return { content: markdown, data: { title: payload.title } };
    },
  );

  ctx.tools.register(
    TOOL_KEYS.dailyBriefSummary,
    {
      displayName: "Daily Brief Summary",
      description: "Generate a company daily brief for the current run context.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (_params, runCtx: ToolRunContext): Promise<ToolResult> => {
      const brief = await generateDailyBrief(ctx, runCtx.companyId);
      return { content: brief.markdown, data: brief };
    },
  );

  ctx.tools.register(
    TOOL_KEYS.emailReplyFromThread,
    {
      displayName: "Email Reply From Thread",
      description: "Generate an email reply draft from a thread.",
      parametersSchema: {
        type: "object",
        properties: {
          subject: { type: "string" },
          thread: { type: "string" },
          senderName: { type: "string" },
          desiredOutcome: { type: "string" },
        },
        required: ["subject", "thread"],
      },
    },
    async (params): Promise<ToolResult> => {
      const payload = params as { subject?: string; thread?: string; senderName?: string; desiredOutcome?: string };
      if (!payload.subject || !payload.thread) {
        return { error: "subject and thread are required" };
      }
      const markdown = buildEmailReplyMarkdown({
        subject: payload.subject,
        thread: payload.thread,
        senderName: payload.senderName,
        desiredOutcome: payload.desiredOutcome,
      });
      return { content: markdown, data: { subject: payload.subject } };
    },
  );

  ctx.tools.register(
    TOOL_KEYS.contentCampaignPack,
    {
      displayName: "Content Campaign Pack",
      description: "Generate a multi-platform campaign pack.",
      parametersSchema: {
        type: "object",
        properties: {
          campaignName: { type: "string" },
          sourceTitle: { type: "string" },
          sourceSummary: { type: "string" },
          angle: { type: "string" },
          callToAction: { type: "string" },
          platforms: { type: "array", items: { type: "string" } },
        },
        required: ["campaignName", "sourceTitle", "sourceSummary"],
      },
    },
    async (params): Promise<ToolResult> => {
      const payload = params as { campaignName?: string; sourceTitle?: string; sourceSummary?: string; angle?: string; callToAction?: string; platforms?: string[] };
      if (!payload.campaignName || !payload.sourceTitle || !payload.sourceSummary) {
        return { error: "campaignName, sourceTitle, and sourceSummary are required" };
      }
      const markdown = buildContentCampaignMarkdown({
        campaignName: payload.campaignName,
        sourceTitle: payload.sourceTitle,
        sourceSummary: payload.sourceSummary,
        angle: payload.angle,
        callToAction: payload.callToAction,
        platforms: normalizePlatforms(payload.platforms, DEFAULT_CONFIG.contentPlatforms),
      });
      return { content: markdown, data: { title: payload.campaignName } };
    },
  );

  ctx.tools.register(
    TOOL_KEYS.missionControlSnapshot,
    {
      displayName: "Mission Control Snapshot",
      description: "Return the latest mission-control plan or a company operating snapshot.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (_params, runCtx: ToolRunContext): Promise<ToolResult> => {
      const latest = await ctx.state.get(companyScope(runCtx.companyId, STATE_KEYS.latestMissionControlPlan)) as MissionControlPayload | null;
      if (latest) {
        return { content: latest.markdown, data: latest };
      }

      const overview = await buildOverview(ctx, runCtx.companyId);
      const markdown = buildMissionControlMarkdown({
        companyName: overview.companyName,
        objective: "Company operating snapshot",
        lanePlans: overview.agents.slice(0, 4).map((agent, index) => ({
          lane: `Lane ${index + 1}`,
          owner: agent.name,
          focus: `Coordinate execution through ${agent.name} (${agent.role}).`,
        })),
        openIssueTitles: overview.openIssues.map((issue) => issue.title),
        activeGoalTitles: overview.activeGoals.map((goal) => goal.title),
      });
      return { content: markdown, data: overview };
    },
  );
}

async function registerJobs(ctx: PluginContext): Promise<void> {
  ctx.jobs.register(JOB_KEYS.dailyBrief, async (_job: PluginJobContext) => {
    jobsRun += 1;
    const companies = await ctx.companies.list({ limit: 200, offset: 0 });
    for (const company of companies) {
      await generateDailyBrief(ctx, company.id);
    }
  });

  ctx.jobs.register(JOB_KEYS.pipelineWatchdog, async (_job: PluginJobContext) => {
    jobsRun += 1;
    const companies = await ctx.companies.list({ limit: 200, offset: 0 });
    for (const company of companies) {
      await runPipelineWatchdog(ctx, company.id);
    }
  });
}

async function handleWebhook(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  if (input.endpointKey !== WEBHOOK_KEYS.workflowIngest) {
    throw new Error(`Unsupported webhook endpoint: ${input.endpointKey}`);
  }
  webhooksHandled += 1;
  const payload = input.parsedBody && typeof input.parsedBody === "object"
    ? input.parsedBody as Record<string, unknown>
    : {};
  const kind = typeof payload.kind === "string" ? payload.kind : "";

  switch (kind) {
    case "meeting_transcript":
      await ingestMeetingTranscript(ctx, payload);
      return;
    case "email_thread":
      await ingestEmailThread(ctx, payload);
      return;
    case "calendar_event":
      await ingestCalendarEvent(ctx, payload);
      return;
    case "lead":
      await ingestLead(ctx, payload);
      return;
    case "lead_pipeline":
      await updateLeadPipeline(ctx, payload);
      return;
    case "content_repurpose":
      await queueContentRepurpose(ctx, payload);
      return;
    case "content_campaign":
      await generateContentCampaign(ctx, payload);
      return;
    case "mission_control":
      await launchMissionControl(ctx, payload);
      return;
    case "focus_plan":
      await planFocusBlocks(ctx, payload);
      return;
    case "watchdog":
      await runPipelineWatchdog(ctx, requireString(payload, "companyId"));
      return;
    default:
      throw new Error("Webhook payload kind must be one of meeting_transcript, email_thread, calendar_event, lead, lead_pipeline, content_repurpose, content_campaign, mission_control, focus_plan, or watchdog");
  }
}

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    await registerDataHandlers(ctx);
    await registerActionHandlers(ctx);
    await registerToolHandlers(ctx);
    await registerJobs(ctx);
    ctx.logger.info("Business Workflows plugin ready", { pluginId: PLUGIN_ID });
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return {
      status: "ok",
      message: "Business Workflows plugin ready",
      details: {
        jobsRun,
        actionsRun,
        webhooksHandled,
        hasContext: Boolean(currentContext),
      },
    };
  },

  async onWebhook(input) {
    const ctx = currentContext;
    if (!ctx) throw new Error("Plugin context unavailable");
    await handleWebhook(ctx, input);
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const typed = config as PluginConfig;

    if (typed.maxStoredRecords !== undefined && (!Number.isFinite(typed.maxStoredRecords) || typed.maxStoredRecords < 1)) {
      errors.push("maxStoredRecords must be a positive number");
    }
    if (typed.dailyBriefIssueLimit !== undefined && (!Number.isFinite(typed.dailyBriefIssueLimit) || typed.dailyBriefIssueLimit < 1)) {
      errors.push("dailyBriefIssueLimit must be a positive number");
    }
    if (typed.focusBlockMinutes !== undefined && (!Number.isFinite(typed.focusBlockMinutes) || typed.focusBlockMinutes < 15)) {
      errors.push("focusBlockMinutes must be at least 15 minutes");
    }
    if (typed.watchdogStaleIssueHours !== undefined && (!Number.isFinite(typed.watchdogStaleIssueHours) || typed.watchdogStaleIssueHours < 1)) {
      errors.push("watchdogStaleIssueHours must be a positive number");
    }
    if (typed.contentPlatforms && !Array.isArray(typed.contentPlatforms)) {
      errors.push("contentPlatforms must be an array");
    }
    if (typed.missionControlLanes && !Array.isArray(typed.missionControlLanes)) {
      errors.push("missionControlLanes must be an array");
    }
    if (typed.defaultEmailTone && !EMAIL_TONES.includes(typed.defaultEmailTone as (typeof EMAIL_TONES)[number])) {
      errors.push(`defaultEmailTone must be one of: ${EMAIL_TONES.join(", ")}`);
    }
    if (typed.defaultProjectId !== undefined && typed.defaultProjectId.trim().length === 0) {
      warnings.push("defaultProjectId is blank; operators will need to choose a project manually.");
    }
    if (typed.missionControlLanes && typed.missionControlLanes.length === 0) {
      warnings.push("missionControlLanes is empty; mission control plans will fall back to runtime lane defaults.");
    }

    return { ok: errors.length === 0, errors, warnings };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);