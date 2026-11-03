import type { AttentionViewCounts } from "@paperclipai/shared";
import type { LabAttentionRecord, LabHistoryRecord, LabReceipt, LandingData, CardData, PanelData } from "./kit";

export const COMPANY = registryCompany();
export const TASKS = registryTasks();
export const LAB_NOW = new Date("2026-09-28T18:00:00");

function registryCompany() {
  return { id: "company-acmehats", name: "acmehats", issuePrefix: "ACM" };
}
function registryTasks() {
  return [
    { identifier: "NEE-39", title: "Develop acmehats brand strategy and designer brief" },
    { identifier: "NEE-41", title: "Create visual directions and first acmehats brand deck" },
    { identifier: "NEE-7", title: "Autonomous ad-copy generation for the spring catalog" },
  ];
}

export const VIEW_COUNTS: AttentionViewCounts = { mine: 11, unassigned: 4, company: 8, archived: 5, all: 32 };

const PLAN: LabAttentionRecord = {
  id: "plan-brand",
  kind: "plan",
  decideHere: true,
  source: "issue_thread_interaction",
  task: "NEE-39",
  taskTitle: "Develop acmehats brand strategy and designer brief",
  agent: "Dottabot",
  ageLabel: "2d",
  severity: "high",
  ask: "Approve the Q4 brand-strategy plan?",
  context:
    "Three positioning pillars, a six-week production timeline, and $18k for an external photographer. Dottabot recommends approving so the brand deck can start Monday.",
  reason: "you requested this",
  primary: "Approve",
  secondary: ["Reject", "Revise…"],
  target: { kind: "plan", label: "Brand strategy plan · rev 4" },
};

const QUESTION: LabAttentionRecord = {
  id: "question-deck",
  kind: "question",
  decideHere: true,
  source: "issue_thread_interaction",
  task: "NEE-41",
  taskTitle: "Create visual directions and first acmehats brand deck",
  agent: "Pixelbot",
  ageLabel: "5h",
  severity: "medium",
  ask: "Which visual direction should the first brand deck lead with?",
  context: "Three directions explored. Pixelbot recommends Direction B for the strongest contrast at retail sizes.",
  reason: "you are the reviewer on this task",
  primary: "Submit",
  questions: [
    {
      prompt: "Lead visual direction for the deck",
      mode: "single",
      options: ["A — Heritage serif", "B — Bold geometric", "C — Soft editorial"],
      recommended: "B — Bold geometric",
      help: "This sets the cover and the first ten slides.",
    },
    {
      prompt: "Which secondary palettes should we keep in reserve?",
      mode: "multi",
      options: ["Forest + cobalt", "Clay + cream", "Monochrome"],
    },
    { prompt: "Anything the photographer must avoid?", mode: "text" },
  ],
};

const SUGGESTED: LabAttentionRecord = {
  id: "suggest-drop",
  kind: "suggested_tasks",
  decideHere: true,
  source: "issue_thread_interaction",
  task: "NEE-44",
  taskTitle: "Launch plan for the spring cap drop",
  agent: "Scout",
  ageLabel: "1d",
  severity: "medium",
  ask: "Accept the four tasks Scout drafted for the spring drop?",
  context: "Scout broke the launch into four owned tasks with billing and projects already set.",
  reason: "you own this goal",
  primary: "Accept drafts",
  secondary: ["Reject"],
  suggested: [
    "Shoot the lookbook (Pixelbot · Brand)",
    "Write the three launch emails (Copybot · Growth)",
    "Build the landing page (Webbot · Site)",
    "Schedule paid social (Growthbot · Growth)",
  ],
};

const DECISION: LabAttentionRecord = {
  id: "decision-reassign",
  kind: "decision",
  decideHere: true,
  source: "decision",
  task: "NEE-18",
  taskTitle: "Fix the broken size-chart on product pages",
  agent: "Routerbot",
  ageLabel: "1d",
  severity: "medium",
  ask: "Reassign the stalled size-chart fix?",
  context: "The current owner has been unavailable for 2 days. Routerbot proposes moving it to Webbot while running NEE-18.",
  reason: "you are the escalation owner",
  primary: "Decide",
  options: ["Reassign to Webbot", "Leave unchanged"],
};

const BUDGET: LabAttentionRecord = {
  id: "budget-adcopy",
  kind: "budget",
  decideHere: true,
  source: "budget_alert",
  task: "NEE-7",
  taskTitle: "Autonomous ad-copy generation for the spring catalog",
  agent: "Adbot",
  ageLabel: "3h",
  severity: "critical",
  ask: "Adbot hit its budget — work is paused.",
  context: "Spent $512 of a $500 limit (102%). Raising the limit resumes the run; keeping it paused leaves the task where it stopped.",
  reason: "you are the budget owner",
  primary: "Raise limit & resume",
  secondary: ["Keep paused"],
  spend: { spent: "$512", limit: "$500", percent: 102 },
};

const FAILED: LabAttentionRecord = {
  id: "failed-sync",
  kind: "failed_run",
  decideHere: true,
  source: "failed_run",
  task: "NEE-23",
  taskTitle: "Nightly catalog sync to the storefront",
  agent: "Syncbot",
  ageLabel: "20m",
  severity: "high",
  ask: "Nightly catalog sync failed.",
  context: "Error: upstream returned 503 after 3 retries. The last good sync was 14 hours ago.",
  reason: "this blocks a task you own",
  primary: "Retry",
  secondary: ["Open run"],
  error: "UpstreamError: 503 Service Unavailable (3 retries) at syncCatalog()",
};

const APPROVAL: LabAttentionRecord = {
  id: "approval-paidsearch",
  kind: "approval",
  decideHere: false,
  source: "approval",
  task: "NEE-55",
  taskTitle: "Pilot paid search for the spring drop",
  agent: "Growthbot",
  ageLabel: "4h",
  severity: "high",
  ask: "Approve a $4,200 paid-search pilot?",
  context: "Two-week pilot on brand + category terms. Growthbot projects a 2.1x ROAS from last season's data.",
  reason: "spend over $1,000 needs you",
  primary: "Review",
  secondary: ["Reject", "Approve"],
  target: { kind: "approval", label: "Spend approval · $4,200" },
};

const REVIEW: LabAttentionRecord = {
  id: "review-hero",
  kind: "review",
  decideHere: false,
  source: "review",
  task: "NEE-12",
  taskTitle: "Rewrite the homepage hero copy",
  agent: "Copybot",
  ageLabel: "6h",
  severity: "medium",
  ask: "Homepage hero copy is ready for review.",
  context: "Copybot finished three variants and marked the task for review four hours ago.",
  reason: "you are the reviewer",
  primary: "Review",
  stale: "aged",
};

const BLOCKER: LabAttentionRecord = {
  id: "blocker-checkout",
  kind: "blocker",
  decideHere: false,
  source: "blocker_attention",
  task: "NEE-30",
  taskTitle: "Ship the checkout redesign",
  agent: "Webbot",
  ageLabel: "8h",
  severity: "high",
  ask: "Checkout redesign is blocked.",
  context: "Waiting on the payments migration before the redesign can merge.",
  reason: "you own the blocked task",
  primary: "Review",
  blockingTask: { identifier: "NEE-29", title: "Migrate to the new payments SDK" },
};

const RECOVERY: LabAttentionRecord = {
  id: "recovery-deploy",
  kind: "recovery",
  decideHere: false,
  source: "recovery_action",
  task: "NEE-9",
  taskTitle: "Recover the interrupted storefront deploy",
  agent: "Opsbot",
  ageLabel: "35m",
  severity: "high",
  ask: "A deploy was interrupted and needs a recovery decision.",
  context: "The deploy stopped halfway. Opsbot can roll back or resume; it needs a person to choose.",
  reason: "you are the escalation owner",
  primary: "Open recovery",
};

const JOIN: LabAttentionRecord = {
  id: "join-riley",
  kind: "join_request",
  decideHere: false,
  source: "join_request",
  task: "NEE-61",
  taskTitle: "Access request",
  agent: "Access",
  ageLabel: "2h",
  severity: "medium",
  ask: "riley@acmehats.example asked to join acmehats.",
  context: "Requested member access. Approving adds them to the company; rejecting declines the request.",
  reason: "you are a board member",
  primary: "Approve",
  secondary: ["Reject"],
};

const AGENT_ERROR: LabAttentionRecord = {
  id: "agent-error-pixel",
  kind: "agent_error",
  decideHere: false,
  source: "agent_error_alert",
  task: "NEE-41",
  taskTitle: "Create visual directions and first acmehats brand deck",
  agent: "Pixelbot",
  ageLabel: "1h",
  severity: "high",
  ask: "Pixelbot hit an unexpected error.",
  context: "The adapter crashed while rendering slide 7. Pixelbot stopped and is waiting to be inspected.",
  reason: "you manage this agent",
  primary: "Inspect",
  error: "RenderError: cannot read property 'frame' of undefined (slide 7)",
};

const FOR_DOTTA: LabAttentionRecord = {
  ...APPROVAL,
  id: "approval-for-dotta",
  task: "NEE-57",
  taskTitle: "Order the spring photoshoot props",
  ask: "Approve $820 for photoshoot props?",
  context: "A short prop list for the lookbook shoot. Dotta requested this while running the shoot plan.",
  reason: "Dotta requested this",
  forUser: "Dotta",
  spend: undefined,
  target: { kind: "approval", label: "Spend approval · $820" },
};

const STALE_REVIEW: LabAttentionRecord = { ...REVIEW, id: "review-hero-stale", stale: "issue_closed", reason: "the task was closed while this waited" };

export const LANDING_RECORDS: LabAttentionRecord[] = [BUDGET, PLAN, QUESTION, FAILED, SUGGESTED, DECISION, APPROVAL, REVIEW, BLOCKER, RECOVERY, JOIN];

export const CARD_RECORDS: LabAttentionRecord[] = [PLAN, QUESTION, STALE_REVIEW, FOR_DOTTA, FAILED, APPROVAL, AGENT_ERROR, BLOCKER];

export const RECEIPTS: LabReceipt[] = [
  { id: "r1", line: "Approved by @Dotta for you", title: "Approve $820 for photoshoot props", task: "NEE-57", ageLabel: "1h" },
  { id: "r2", line: "Withdrawn by @Riley", title: "Confirm the vendor shortlist", task: "NEE-48", ageLabel: "yesterday" },
  { id: "r3", line: "Answered by @Dotta for you", title: "Which paper stock for the hangtags?", task: "NEE-50", ageLabel: "yesterday" },
];

export const HISTORY: LabHistoryRecord[] = [
  { id: "h1", line: "Approved by @Scott", title: "Approve the September ad budget", task: "NEE-2", ageLabel: "2d", outcome: "approved" },
  { id: "h2", line: "Answered by @Dotta for you", title: "Pick the hangtag paper stock", task: "NEE-50", ageLabel: "2d", outcome: "answered" },
  { id: "h3", line: "Withdrawn by @Riley", title: "Confirm the vendor shortlist", task: "NEE-48", ageLabel: "3d", outcome: "withdrawn" },
  { id: "h4", line: "Expired", title: "Approve the late-summer reorder", task: "NEE-31", ageLabel: "4d", outcome: "expired" },
  { id: "h5", line: "Rejected by @Scott", title: "Launch the clearance banner", task: "NEE-19", ageLabel: "5d", outcome: "rejected" },
];

export const LANDING: LandingData = { records: LANDING_RECORDS, receipts: RECEIPTS, counts: VIEW_COUNTS };
export const CARD: CardData = { records: CARD_RECORDS };
export const PANEL: PanelData = { record: PLAN, history: HISTORY };
