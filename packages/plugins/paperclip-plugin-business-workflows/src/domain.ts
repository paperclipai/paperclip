export type ActionItem = {
  title: string;
  owner: string | null;
  due: string | null;
  raw: string;
};

export type LeadStage = "new" | "qualified" | "nurture" | "proposal" | "negotiation" | "won" | "lost";

export type FocusBlock = {
  start: string;
  end: string;
  label: string;
  reason: string;
};

export type LeadPipelineEntry = {
  issueId?: string;
  leadName: string;
  organization?: string;
  stage: LeadStage;
  score: number;
  nextStep?: string;
  nextFollowUp?: string | null;
  updatedAt: string;
  summary?: string;
  source?: string;
};

export type WorkflowRecordKind =
  | "meeting_transcript"
  | "proposal_draft"
  | "lead"
  | "lead_pipeline"
  | "content_repurpose"
  | "content_campaign"
  | "daily_brief"
  | "email_triage"
  | "email_reply"
  | "calendar_event"
  | "focus_plan"
  | "mission_control"
  | "watchdog";

export type WorkflowRecord = {
  id: string;
  kind: WorkflowRecordKind;
  title: string;
  createdAt: string;
  summary?: string;
  issueId?: string;
  childIssueIds?: string[];
  details?: Record<string, unknown>;
};

const DAY_WORDS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const DUE_VALUE_PATTERN = `${DAY_WORDS}|\\d{4}-\\d{2}-\\d{2}|[A-Za-z]{3,9}\\s+\\d{1,2}`;

const CONTENT_PLATFORM_HINTS: Record<string, string> = {
  x: "Write one punchy insight, one contrarian observation, and one concrete CTA.",
  linkedin: "Turn the source into a narrative post with a lesson, proof point, and operator takeaway.",
  newsletter: "Expand the source into a concise email with context, insight, and a clear next action.",
  youtube: "Draft a hook, three beats, and a closing CTA that can drive watch time.",
  instagram: "Convert the core idea into a short visual-first narrative and caption structure.",
};

export function normalizeText(input: string): string {
  return input.replace(/\r\n?/g, "\n").trim();
}

export function summarizeTranscript(input: string, maxChars = 360): string {
  const normalized = normalizeText(input);
  const nonEmptyLines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const candidate = nonEmptyLines.slice(0, 4).join(" ");
  if (candidate.length <= maxChars) return candidate;
  return `${candidate.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

export function normalizeStage(input: string | undefined, fallback: LeadStage = "new"): LeadStage {
  const value = input?.trim().toLowerCase();
  switch (value) {
    case "new":
    case "qualified":
    case "nurture":
    case "proposal":
    case "negotiation":
    case "won":
    case "lost":
      return value;
    default:
      return fallback;
  }
}

function parseOwner(raw: string): string | null {
  const match = raw.match(/(?:owner|assignee)\s*:\s*([A-Za-z][A-Za-z\s'-]{1,40}?)(?=\s+(?:due|deadline|by)\b|$)/i);
  return match ? match[1]!.trim() : null;
}

function parseDue(raw: string): string | null {
  const match = raw.match(
    new RegExp(`(?:due|deadline|by)\\s*[:\\-]?\\s*(${DUE_VALUE_PATTERN})`, "i"),
  );
  return match ? match[1]!.trim() : null;
}

function cleanActionTitle(raw: string): string {
  return raw
    .replace(/^[-*]\s*(?:\[[ xX]\]\s*)?/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/^(?:action items?|todo|next steps?)\s*:?\s*/i, "")
    .replace(/^(?:owner|assignee)\s*:\s*[A-Za-z][A-Za-z\s'-]{1,40}?(?=\s+(?:due|deadline|by)\b|$)\s*/i, "")
    .replace(new RegExp(`^(?:due|deadline)\\s*:\\s*(?:${DUE_VALUE_PATTERN})\\s*`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractActionItems(input: string): ActionItem[] {
  const normalized = normalizeText(input);
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);

  const candidates = lines.filter((line) => {
    return /^[-*]\s+/.test(line)
      || /^\d+[.)]\s+/.test(line)
      || /^(?:action items?|todo|next steps?)\s*:?/i.test(line)
      || /(owner\s*:|assignee\s*:|deadline\s*:|due\s*:)/i.test(line);
  });

  const fallbackSentences = candidates.length > 0
    ? []
    : normalized
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => /\b(need to|follow up|send|review|schedule|draft|prepare|ship|publish)\b/i.test(sentence));

  return [...candidates, ...fallbackSentences]
    .map((raw) => ({
      title: cleanActionTitle(raw),
      owner: parseOwner(raw),
      due: parseDue(raw),
      raw,
    }))
    .filter((item) => item.title.length > 0)
    .slice(0, 12);
}

export function buildProposalMarkdown(input: {
  title: string;
  notes: string;
  summary?: string;
  actionItems?: ActionItem[];
}): string {
  const summary = input.summary?.trim() || summarizeTranscript(input.notes);
  const actionItems = input.actionItems && input.actionItems.length > 0
    ? input.actionItems
    : extractActionItems(input.notes);
  const deliverables = actionItems.length > 0
    ? actionItems.map((item) => `- ${item.title}${item.owner ? ` _(owner: ${item.owner})_` : ""}${item.due ? ` _(due: ${item.due})_` : ""}`).join("\n")
    : "- Define success criteria\n- Confirm deliverables\n- Agree on next steps";

  return [
    `# Proposal — ${input.title}`,
    "",
    "## Overview",
    summary || "Meeting or notes summary pending.",
    "",
    "## Proposed Scope",
    "This proposal is based on the provided notes and should be validated before external delivery.",
    "",
    "## Deliverables",
    deliverables,
    "",
    "## Assumptions",
    "- Access to the necessary people, systems, and source materials is available.",
    "- Final timing and pricing require operator confirmation.",
    "",
    "## Suggested Next Steps",
    "1. Review and edit this draft.",
    "2. Confirm scope, owners, and target dates.",
    "3. Send the finalized version to the stakeholder.",
  ].join("\n");
}

export function buildEmailReplyMarkdown(input: {
  subject: string;
  senderName?: string | null;
  thread: string;
  desiredOutcome?: string | null;
  tone?: string;
  companyName?: string | null;
}): string {
  const summary = summarizeTranscript(input.thread);
  const senderName = input.senderName?.trim();
  const greeting = senderName ? `Hi ${senderName},` : "Hi there,";
  const tone = input.tone?.trim().toLowerCase() ?? "helpful";
  const acknowledgement = tone === "direct"
    ? "Thanks for the note."
    : tone === "warm"
      ? "Thanks so much for the thoughtful note."
      : "Thanks for the detailed note.";
  const outcome = input.desiredOutcome?.trim()
    ? `The clearest next step from this thread is to ${input.desiredOutcome.trim().replace(/\.$/, "")}.`
    : "The clearest next step from this thread is to confirm scope, ownership, and timing in one reply.";

  return [
    `# Email Reply Draft — ${input.subject}`,
    "",
    "## Thread Summary",
    summary || "No thread summary available.",
    "",
    "## Draft",
    greeting,
    "",
    acknowledgement,
    outcome,
    "",
    "Based on the thread, here’s the reply path that keeps momentum:",
    "- Acknowledge the request or constraint clearly.",
    "- Confirm the most important next step and owner.",
    "- Offer a concrete follow-up or decision point.",
    "",
    "Best,",
    input.companyName?.trim() ? `${input.companyName.trim()} Team` : "Team",
  ].join("\n");
}

export function buildLeadPipelineMarkdown(input: {
  leadName: string;
  organization?: string;
  stage: LeadStage;
  score: number;
  nextStep?: string;
  nextFollowUp?: string | null;
  summary?: string;
  source?: string;
}): string {
  return [
    `# Lead Pipeline — ${input.leadName}${input.organization ? ` @ ${input.organization}` : ""}`,
    "",
    `Stage: ${input.stage}`,
    `Score: ${input.score}`,
    input.source ? `Source: ${input.source}` : null,
    input.nextFollowUp ? `Next follow-up: ${input.nextFollowUp}` : null,
    "",
    "## Summary",
    input.summary?.trim() || "No lead summary captured yet.",
    "",
    "## Next Step",
    input.nextStep?.trim() || "Define the next owner, milestone, or outbound touch.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function buildContentCampaignMarkdown(input: {
  campaignName: string;
  sourceTitle: string;
  sourceSummary: string;
  platforms: string[];
  angle?: string;
  callToAction?: string;
}): string {
  const platforms = normalizePlatforms(input.platforms, ["x", "linkedin", "newsletter"]);
  const platformSections = platforms.map((platform) => [
    `### ${platform}`,
    `- Angle: ${input.angle?.trim() || `Frame ${input.sourceTitle} around the most operator-relevant lesson.`}`,
    `- Draft direction: ${CONTENT_PLATFORM_HINTS[platform] ?? "Turn the source into one tight hook, one proof point, and one CTA."}`,
    `- CTA: ${input.callToAction?.trim() || "Prompt the audience to reply, book, or request the next asset."}`,
  ].join("\n")).join("\n\n");

  return [
    `# Content Campaign — ${input.campaignName}`,
    "",
    `Source: ${input.sourceTitle}`,
    "",
    "## Core Story",
    input.sourceSummary.trim() || "Add the core campaign narrative.",
    "",
    "## Campaign Angle",
    input.angle?.trim() || "Lead with the clearest transformation, proof, or pain point from the source material.",
    "",
    "## Platform Packs",
    platformSections,
  ].join("\n");
}

export function buildFocusPlanMarkdown(input: {
  companyName: string;
  date: string;
  blocks: FocusBlock[];
  openIssueTitles: string[];
  activeGoalTitles: string[];
}): string {
  return [
    `# Focus Plan — ${input.companyName}`,
    "",
    `Date: ${input.date}`,
    "",
    "## Scheduled Blocks",
    input.blocks.length > 0
      ? input.blocks.map((block) => `- ${block.start}–${block.end} — ${block.label} _(reason: ${block.reason})_`).join("\n")
      : "- No focus blocks generated.",
    "",
    "## Top Open Issues",
    input.openIssueTitles.length > 0
      ? input.openIssueTitles.slice(0, 6).map((title) => `- ${title}`).join("\n")
      : "- No open issues captured.",
    "",
    "## Active Goals",
    input.activeGoalTitles.length > 0
      ? input.activeGoalTitles.slice(0, 4).map((title) => `- ${title}`).join("\n")
      : "- No active goals captured.",
  ].join("\n");
}

export function buildMissionControlMarkdown(input: {
  companyName: string;
  objective: string;
  lanePlans: Array<{ lane: string; owner?: string | null; focus: string }>;
  openIssueTitles: string[];
  activeGoalTitles: string[];
  riskTitles?: string[];
}): string {
  return [
    `# Mission Control — ${input.objective}`,
    "",
    `Company: ${input.companyName}`,
    "",
    "## Lanes",
    input.lanePlans.length > 0
      ? input.lanePlans.map((lane) => `- ${lane.lane}: ${lane.focus}${lane.owner ? ` _(suggested owner: ${lane.owner})_` : ""}`).join("\n")
      : "- No lanes defined.",
    "",
    "## Open Issues Snapshot",
    input.openIssueTitles.length > 0
      ? input.openIssueTitles.slice(0, 8).map((title) => `- ${title}`).join("\n")
      : "- No open issues captured.",
    "",
    "## Active Goals Snapshot",
    input.activeGoalTitles.length > 0
      ? input.activeGoalTitles.slice(0, 5).map((title) => `- ${title}`).join("\n")
      : "- No active goals captured.",
    "",
    "## Risks",
    input.riskTitles && input.riskTitles.length > 0
      ? input.riskTitles.map((title) => `- ${title}`).join("\n")
      : "- No explicit risks captured yet.",
  ].join("\n");
}

export function buildWatchdogMarkdown(input: {
  companyName: string;
  blockedIssueTitles: string[];
  staleIssueTitles: string[];
  followUpsDue: string[];
  recentRecords: WorkflowRecord[];
}): string {
  return [
    `# Watchdog Report — ${input.companyName}`,
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Blocked Issues",
    input.blockedIssueTitles.length > 0
      ? input.blockedIssueTitles.map((title) => `- ${title}`).join("\n")
      : "- No blocked issues.",
    "",
    "## Stale Issues",
    input.staleIssueTitles.length > 0
      ? input.staleIssueTitles.map((title) => `- ${title}`).join("\n")
      : "- No stale issues found.",
    "",
    "## Follow-Ups Due",
    input.followUpsDue.length > 0
      ? input.followUpsDue.map((title) => `- ${title}`).join("\n")
      : "- No due follow-ups.",
    "",
    "## Recent Workflow Activity",
    input.recentRecords.length > 0
      ? input.recentRecords.slice(0, 5).map((record) => `- [${record.kind}] ${record.title}`).join("\n")
      : "- No recent workflow activity recorded yet.",
  ].join("\n");
}

export function buildDailyBriefMarkdown(input: {
  companyName: string;
  openIssueTitles: string[];
  activeGoalTitles: string[];
  recentRecords: WorkflowRecord[];
}): string {
  const recent = input.recentRecords.slice(0, 5);
  return [
    `# Daily Brief — ${input.companyName}`,
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Open items",
    input.openIssueTitles.length > 0
      ? input.openIssueTitles.slice(0, 8).map((title) => `- ${title}`).join("\n")
      : "- No open issues captured.",
    "",
    "## Active goals",
    input.activeGoalTitles.length > 0
      ? input.activeGoalTitles.slice(0, 5).map((title) => `- ${title}`).join("\n")
      : "- No active goals captured.",
    "",
    "## Recent workflow activity",
    recent.length > 0
      ? recent.map((record) => `- [${record.kind}] ${record.title}`).join("\n")
      : "- No workflow activity recorded yet.",
  ].join("\n");
}

export function normalizePlatforms(input: string[] | undefined, fallback: readonly string[]): string[] {
  const raw = input && input.length > 0 ? input : [...fallback];
  return [...new Set(raw.map((item) => item.trim().toLowerCase()).filter(Boolean))];
}