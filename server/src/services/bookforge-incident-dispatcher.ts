type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";
type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";

type Severity = "low" | "medium" | "high" | "critical";

export type BookforgeIncidentKind =
  | "code_regression"
  | "code_improvement"
  | "debugging"
  | "new_code"
  | "prompt_regression"
  | "editorial_quality"
  | "canon_continuity"
  | "publishing_export"
  | "marketing_growth"
  | "cost_spike"
  | "model_routing"
  | "bookforge_worker_unapproved_running"
  | "bookforge_wrong_book_target_mismatch"
  | "bookforge_runtime_restart"
  | "bookforge_generation_resume"
  | "bookforge_server_down"
  | "queue_state"
  | "recovery_loop"
  | "general";

export interface BookforgeRepairAcceptanceEvidence {
  liveStateChecked?: boolean;
  noGenerationStarted?: boolean;
  promotedPriorChapterRead?: boolean;
  promotedCurrentChapterRead?: boolean;
  continuityObligationsListed?: boolean;
  objectCustodyVerified?: boolean;
  emotionalConsequenceVerified?: boolean;
  sceneEngineVerified?: boolean;
  hookSpecificityVerified?: boolean;
  draftPromotedAlignmentVerified?: boolean;
  localQualityChecksPassed?: boolean;
  canonMemoryRebuilt?: boolean;
  testsOrDetectorsUpdated?: boolean;
  learningArtifactWritten?: boolean;
  relevantQualityAgentApproval?: boolean;
  runtimeGovernorClearance?: boolean;
  stewardFinalApproval?: boolean;
}

export interface BookforgeRepairAcceptanceGate {
  gateVersion: "bookforge-repair-acceptance-v1-2026-05-05";
  mode: "audit_then_repair_then_verify";
  hardRule: string;
  requiredEvidence: Array<keyof BookforgeRepairAcceptanceEvidence>;
  orderedWorkflow: string[];
  finalChapterExternalReviewWorkflow: string[];
  holdClearanceWorkflow: string[];
  roleHandoffs: Array<{ role: string; responsibility: string }>;
  mistakeLearning: {
    required: true;
    lessonFormat: string;
    durableTargets: string[];
    forbiddenShortcut: string;
  };
}

export interface BookforgeDispatchAgent {
  id: string;
  name: string;
  status?: string | null;
}

export interface BookforgeIncidentDispatchInput {
  agents: BookforgeDispatchAgent[];
  sourceAgentId?: string | null;
  sourceAgentName?: string | null;
  issueId?: string | null;
  incidentKind: BookforgeIncidentKind | string;
  severity?: Severity | string | null;
  summary?: string | null;
  allowNonWatchmanSource?: boolean;
  maxFanout?: number;
}

export interface BookforgeIncidentDispatchTarget {
  agentId: string;
  agentName: string;
  source: WakeupSource;
  triggerDetail: WakeupTriggerDetail;
  reason: "bookforge_incident_dispatch";
  idempotencyKey: string;
  payload: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
}

export interface BookforgeIncidentDispatchPlan {
  allowed: boolean;
  blockReason: string | null;
  targets: BookforgeIncidentDispatchTarget[];
  incidentKind: string;
  severity: string;
  fanoutLimit: number;
  repairAcceptanceGate: BookforgeRepairAcceptanceGate | null;
}

export interface BookforgeRepairIssueDraft {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  status: "todo";
  assigneeAgentId: string;
  assigneeAgentName: string;
  originKind: "bookforge_incident";
  originId: string;
}

export interface BookforgeIncidentDispatchResult extends BookforgeIncidentDispatchPlan {
  wakeResults: Array<{
    agentId: string;
    agentName: string;
    ok: boolean;
    result?: unknown;
    error?: { message: string; status?: unknown; details?: unknown };
  }>;
}

export type BookforgeIncidentWakeup = (
  agentId: string,
  opts: {
    source?: WakeupSource;
    triggerDetail?: WakeupTriggerDetail;
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown>;

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function normalizeAgentName(value: string) {
  return normalize(value).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function findAgent(agents: BookforgeDispatchAgent[], name: string) {
  const wanted = normalizeAgentName(name);
  return agents.find((agent) => normalizeAgentName(agent.name) === wanted && agent.status !== "terminated") ?? null;
}

function looksLikeRecoveryStorm(input: BookforgeIncidentDispatchInput) {
  const text = `${input.incidentKind} ${input.summary ?? ""}`.toLowerCase();
  return text.includes("recover stalled issue") || text.includes("recovery_loop") || text.includes("recovery loop");
}

function isWatchmanSource(input: BookforgeIncidentDispatchInput) {
  const sourceName = normalize(input.sourceAgentName);
  if (sourceName.includes("watchman")) return true;
  if (!input.sourceAgentId) return false;
  return input.agents.some(
    (agent) => agent.id === input.sourceAgentId && normalize(agent.name).includes("watchman"),
  );
}

function isChapterRepairIncident(incidentKind: string, summary?: string | null) {
  const text = `${incidentKind} ${summary ?? ""}`.toLowerCase();
  return (
    text.includes("chapter") &&
    (text.includes("repair") ||
      text.includes("fix") ||
      text.includes("quality") ||
      text.includes("canon") ||
      text.includes("continuity") ||
      text.includes("custody") ||
      text.includes("prose") ||
      text.includes("story"))
  );
}

export function buildBookforgeRepairAcceptanceGate(
  incidentKind: string,
  summary?: string | null,
): BookforgeRepairAcceptanceGate | null {
  if (!isChapterRepairIncident(incidentKind, summary)) return null;

  return {
    gateVersion: "bookforge-repair-acceptance-v1-2026-05-05",
    mode: "audit_then_repair_then_verify",
    hardRule:
      "No Bookforge chapter repair may be marked done, promoted, or used as a foundation for resumed generation until every required evidence item is proven against promoted files and local checks.",
    requiredEvidence: [
      "liveStateChecked",
      "noGenerationStarted",
      "promotedPriorChapterRead",
      "promotedCurrentChapterRead",
      "continuityObligationsListed",
      "objectCustodyVerified",
      "emotionalConsequenceVerified",
      "sceneEngineVerified",
      "hookSpecificityVerified",
      "draftPromotedAlignmentVerified",
      "localQualityChecksPassed",
      "canonMemoryRebuilt",
      "testsOrDetectorsUpdated",
      "learningArtifactWritten",
      "relevantQualityAgentApproval",
      "runtimeGovernorClearance",
    ],
    orderedWorkflow: [
      "Watchman verifies Bookforge worker/queue/spend state before any repair work.",
      "Scribe audits the current chapter against the previous promoted chapter and lists exact story obligations.",
      "Continuity Auditor verifies location bridge, timeline, POV, and scene-engine obligations.",
      "Archivist verifies evidence/object custody and Canon Memory impact against promoted files, not summaries.",
      "Scribe or Forgewright patches only verified defects; broad rewrite is forbidden unless explicitly approved.",
      "Inspector runs local checks/tests and confirms draft/promoted alignment.",
      "Archivist rebuilds Canon Memory when promoted text changed and proves it is not stale.",
      "The relevant quality owner approves the repair for the blocker type: Scribe for prose/editorial quality, Continuity Auditor for timeline/POV/scene bridge, Archivist for canon/evidence custody, Inspector for tests/export/readiness, Story Doctor for serious story logic.",
      "Runtime Governor verifies the live hold still matches the repaired item, Bookforge is not actively spending, backups exist, and clearing the hold will not erase manuscript work.",
      "If the relevant quality owner approves and Runtime Governor clearance passes, Runtime Governor may clear the matching quality hold. Resuming paid generation is separate and requires either prior user-approved unattended generation or fresh explicit approval.",
      "The team writes a durable learning artifact naming the mistake, root cause, new detector/prompt/test, and future prevention rule.",
    ],
    finalChapterExternalReviewWorkflow: [
      "Back up the promoted chapter, queue state, phase state, manuscript, and any related generated work before edits.",
      "Tighten surgically from the external review notes; do not broad-rewrite a working final chapter unless explicitly approved.",
      "Remove repeated slogans, catchphrases, or duplicated final-line logic across all promoted chapters, not just the flagged chapter.",
      "Preserve locked continuity, evidence custody, object splits, injury reminders, and open-ending logic while compressing over-explained props or mechanisms.",
      "Reassemble the full manuscript after promoted chapter edits and verify chapter count, manuscript word count, missing chapters, and local detectors.",
      "Clear only the exact matching quality hold after relevant quality-agent approval plus Runtime Governor clearance; do not clear unrelated holds just because the external-review repair passed.",
      "Do not resume Bookforge generation or token-spending work unless the user already approved unattended generation for this exact queue item or gives fresh approval.",
      "Record verification evidence and a durable learning artifact before any downstream unblock decision.",
    ],
    holdClearanceWorkflow: [
      "Repair agent posts evidence for every required gate item, including changed files, checks run, Canon Memory status, and learning artifact path.",
      "Relevant quality owner reviews the evidence against the blocker category and records approve/reject with a short reason.",
      "If rejected, the repair issue returns to the repair agent with the specific missing evidence or failed quality item; do not start paid generation.",
      "If approved, Runtime Governor checks live /api/worker and /api/queue, confirms the hold still targets the same project/chapter/scope, confirms no active token-spending worker, and confirms backups exist.",
      "Runtime Governor clears/reconciles only the matching Bookforge hold/state needed to unblock the approved repair, then verifies /api/queue no longer shows that hold.",
      "If unattended generation for this exact queue item was already approved, Runtime Governor may start/resume Bookforge and hand monitoring to Watchman; otherwise Bookforge stays idle with the hold cleared and no spending.",
      "Watchman monitors the next run and stops loudly on a new hold, failure, stale worker, or cost anomaly instead of looping blindly.",
    ],
    roleHandoffs: [
      { role: "Bookforge Watchman", responsibility: "spend and worker/queue safety" },
      { role: "Bookforge Scribe", responsibility: "fiction quality, emotional logic, prose repair" },
      { role: "Bookforge Continuity Auditor", responsibility: "chapter bridge, timeline, POV, scene continuity" },
      { role: "Bookforge Archivist", responsibility: "promoted-file truth, evidence custody, Canon Memory freshness" },
      { role: "Bookforge Inspector", responsibility: "tests, validation, acceptance evidence" },
      { role: "Bookforge Story Doctor", responsibility: "deeper story logic and motivation plausibility" },
      { role: "Bookforge Runtime Governor", responsibility: "clear only matching approved holds, then safe stop/restart/resume only under approved conditions" },
      { role: "Bookforge Treasurer", responsibility: "model/cost safety and token-spend protection" },
      { role: "Bookforge Steward CEO", responsibility: "policy escalation and tie-breaker when quality owners disagree or resume approval is missing" },
    ],
    mistakeLearning: {
      required: true,
      lessonFormat:
        "mistake -> root cause -> exact file/chapter evidence -> repair made -> detector/prompt/test added -> validation proof -> future prevention rule",
      durableTargets: [
        "Bookforge regression tests or deterministic detector when practical",
        "Bookforge live prompt/agent prompt when model behavior contributed",
        "Hermes skill reference under bookforge-publicationforge/references when workflow knowledge matters",
        "model scorecard or learning ledger entry when a model/lane caused repeat failure",
      ],
      forbiddenShortcut:
        "Do not write 'fixed' or 'looks good' without evidence. Smooth prose is not acceptance; continuity/custody/canon validation is acceptance.",
    },
  };
}

export function validateBookforgeRepairAcceptance(
  evidence: BookforgeRepairAcceptanceEvidence,
  gate: BookforgeRepairAcceptanceGate = buildBookforgeRepairAcceptanceGate("chapter_repair", "chapter repair")!,
) {
  const missing = gate.requiredEvidence.filter((key) => evidence[key] !== true);
  return {
    accepted: missing.length === 0,
    missing,
    gateVersion: gate.gateVersion,
    message:
      missing.length === 0
        ? "Bookforge chapter repair acceptance gate passed. Relevant quality agent plus Runtime Governor may clear the matching hold; paid resume remains separate unless already approved."
        : `Bookforge chapter repair acceptance gate failed: ${missing.join(", ")}`,
  };
}

function isWrongBookTargetIncident(incidentKind: string, summary?: string | null) {
  const kind = normalize(incidentKind);
  return (
    kind.includes("wrong_book") ||
    kind.includes("target_mismatch") ||
    (kind.includes("worker") && kind.includes("unapproved") && normalize(summary).includes("wrong-book"))
  );
}

function targetNamesForIncident(incidentKind: string, severity: string, summary?: string | null) {
  const kind = normalize(incidentKind);

  if (isWrongBookTargetIncident(incidentKind, summary)) {
    return [
      "Bookforge Steward CEO",
      "Bookforge Publisher",
      "Bookforge Forgewright",
      "Bookforge Runtime Governor",
      "Bookforge Watchman",
    ];
  }

  if (kind.includes("worker") || kind.includes("queue") || kind.includes("state") || kind.includes("incident") || kind.includes("runtime") || kind.includes("server") || kind.includes("generation")) {
    return ["Bookforge Runtime Governor", "Bookforge Incident Coordinator", "Bookforge Treasurer"];
  }

  if (isChapterRepairIncident(kind, summary)) {
    return [
      "Bookforge Scribe",
      "Bookforge Continuity Auditor",
      "Bookforge Archivist",
      "Bookforge Inspector",
      "Bookforge Story Doctor",
    ];
  }
  if (kind.includes("cost") || kind.includes("model")) {
    return ["Bookforge Treasurer", "Bookforge Model Scorekeeper", "Bookforge Incident Coordinator"];
  }
  if (kind.includes("editorial") || kind.includes("canon") || kind.includes("story") || kind.includes("prose")) {
    return ["Bookforge Scribe", "Bookforge Story Doctor", "Bookforge Continuity Auditor"];
  }
  if (kind.includes("publishing") || kind.includes("export") || kind.includes("kindle") || kind.includes("metadata")) {
    return ["Bookforge Publisher", "Bookforge Export QA", "Bookforge Kindle Formatter"];
  }
  if (kind.includes("marketing") || kind.includes("growth") || kind.includes("author") || kind.includes("launch")) {
    return ["Bookforge Growth Director", "Bookforge Market Researcher", "Bookforge Launch Copywriter"];
  }
  if (kind.includes("prompt")) {
    return ["Bookforge Forgewright", "Bookforge Prompt Engineer", "Bookforge Inspector"];
  }
  if (kind.includes("debug")) {
    return ["Bookforge Forgewright", "Bookforge Debugger", "Bookforge Inspector"];
  }
  if (kind.includes("new_code") || kind.includes("feature")) {
    return ["Bookforge Forgewright", "Bookforge Feature Builder", "Bookforge Inspector"];
  }
  if (kind.includes("code") || kind.includes("regression")) {
    return ["Bookforge Forgewright", "Bookforge Inspector", "Bookforge Debugger"];
  }

  return severity === "critical"
    ? ["Bookforge Incident Coordinator", "Bookforge Steward CEO", "Bookforge Strategist"]
    : ["Bookforge Incident Coordinator", "Bookforge Strategist"];
}

function issueKey(input: BookforgeIncidentDispatchInput) {
  const raw = input.issueId || `${input.incidentKind}:${input.summary ?? "no-summary"}`;
  return raw.replace(/[^a-zA-Z0-9:_-]+/g, "-").slice(0, 120) || "unknown";
}

function priorityForSeverity(severity: string): BookforgeRepairIssueDraft["priority"] {
  if (severity === "critical") return "critical";
  if (severity === "high") return "high";
  if (severity === "low") return "low";
  return "medium";
}

function compactTitle(summary?: string | null) {
  const text = (summary ?? "").split("\n").find((line) => line.trim().length > 0)?.trim() ?? "Bookforge quality hold";
  return text.replace(/\s+/g, " ").slice(0, 140);
}

export function buildBookforgeRepairIssueDraft(input: {
  plan: BookforgeIncidentDispatchPlan;
  source: BookforgeIncidentDispatchInput;
}): BookforgeRepairIssueDraft | null {
  if (!input.plan.allowed || !input.plan.repairAcceptanceGate) return null;
  const primary = input.plan.targets[0];
  if (!primary) return null;
  const key = issueKey(input.source);
  const summary = input.source.summary ?? "No incident summary provided.";
  const gate = input.plan.repairAcceptanceGate;
  return {
    title: `Bookforge repair gate — ${compactTitle(input.source.summary)}`,
    description: [
      "This issue was created automatically from a Bookforge incident. It is the visible repair task Paperclip agents must act on; do not leave the incident as wake-only activity.",
      "",
      "Required action:",
      "1. Verify live Bookforge worker/queue/spending state before any repair.",
      "2. Inspect promoted prior chapter and current chapter/draft artifacts directly.",
      "3. Repair only the verified blocker or produce a no-repair evidence report.",
      "4. Run local quality checks and rebuild Canon Memory if promoted text changes.",
      "5. Write the learning artifact, get the relevant quality-agent approval, then let Runtime Governor clear only the matching hold after live safety checks.",
      "",
      "Incident:",
      summary,
      "",
      "Acceptance gate:",
      gate.hardRule,
      "",
      `Required evidence: ${gate.requiredEvidence.join(", ")}`,
      "",
      "Final-chapter external-review workflow:",
      ...gate.finalChapterExternalReviewWorkflow.map((step, index) => `${index + 1}. ${step}`),
      "",
      "Role handoffs:",
      ...gate.roleHandoffs.map((handoff) => `- ${handoff.role}: ${handoff.responsibility}`),
    ].join("\n"),
    priority: priorityForSeverity(input.plan.severity),
    status: "todo",
    assigneeAgentId: primary.agentId,
    assigneeAgentName: primary.agentName,
    originKind: "bookforge_incident",
    originId: key,
  };
}

export function planBookforgeIncidentDispatch(input: BookforgeIncidentDispatchInput): BookforgeIncidentDispatchPlan {
  const severity = normalize(input.severity) || "medium";
  const incidentKind = normalize(input.incidentKind) || "general";
  const repairAcceptanceGate = buildBookforgeRepairAcceptanceGate(incidentKind, input.summary);
  const defaultFanout = repairAcceptanceGate ? 5 : isWrongBookTargetIncident(incidentKind, input.summary) ? 5 : 3;
  const fanoutLimit = Math.max(1, Math.min(Math.floor(input.maxFanout ?? defaultFanout), 5));

  if (looksLikeRecoveryStorm(input)) {
    return { allowed: false, blockReason: "recovery_loop_suppressed", targets: [], incidentKind, severity, fanoutLimit, repairAcceptanceGate };
  }
  if (!input.allowNonWatchmanSource && !isWatchmanSource(input)) {
    return { allowed: false, blockReason: "source_not_watchman", targets: [], incidentKind, severity, fanoutLimit, repairAcceptanceGate };
  }

  const key = issueKey(input);
  const targetNames = targetNamesForIncident(incidentKind, severity, input.summary);
  const targets: BookforgeIncidentDispatchTarget[] = [];
  const seen = new Set<string>();

  for (const name of targetNames) {
    if (targets.length >= fanoutLimit) break;
    const agent = findAgent(input.agents, name);
    if (!agent || seen.has(agent.id) || agent.id === input.sourceAgentId) continue;
    seen.add(agent.id);
    targets.push({
      agentId: agent.id,
      agentName: agent.name,
      source: "automation",
      triggerDetail: "system",
      reason: "bookforge_incident_dispatch",
      idempotencyKey: `bookforge-incident:${key}:${agent.id}`,
      payload: {
        issueId: input.issueId ?? null,
        incidentKind,
        severity,
        summary: input.summary ?? null,
        sourceAgentId: input.sourceAgentId ?? null,
        sourceAgentName: input.sourceAgentName ?? null,
        repairAcceptanceGate,
      },
      contextSnapshot: {
        forceFreshSession: true,
        source: "bookforge.watchman.dispatcher",
        issueId: input.issueId ?? null,
        incidentKind,
        severity,
        summary: input.summary ?? null,
        wakeReason: "bookforge_incident_dispatch",
        sourceAgentId: input.sourceAgentId ?? null,
        sourceAgentName: input.sourceAgentName ?? null,
        fanoutLimit,
        repairAcceptanceGate,
      },
    });
  }

  return { allowed: true, blockReason: null, targets, incidentKind, severity, fanoutLimit, repairAcceptanceGate };
}

export async function dispatchBookforgeIncident(
  input: BookforgeIncidentDispatchInput & { wakeup: BookforgeIncidentWakeup },
): Promise<BookforgeIncidentDispatchResult> {
  const plan = planBookforgeIncidentDispatch(input);
  const wakeResults: BookforgeIncidentDispatchResult["wakeResults"] = [];

  if (!plan.allowed) {
    return { ...plan, wakeResults };
  }

  for (const target of plan.targets) {
    try {
      const result = await input.wakeup(target.agentId, {
        source: target.source,
        triggerDetail: target.triggerDetail,
        reason: target.reason,
        payload: target.payload,
        idempotencyKey: target.idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: input.sourceAgentId ?? null,
        contextSnapshot: target.contextSnapshot,
      });
      wakeResults.push({ agentId: target.agentId, agentName: target.agentName, ok: true, result });
    } catch (error) {
      const maybeError = error as { message?: string; status?: unknown; details?: unknown };
      wakeResults.push({
        agentId: target.agentId,
        agentName: target.agentName,
        ok: false,
        error: {
          message: typeof maybeError.message === "string" ? maybeError.message : String(error),
          status: maybeError.status,
          details: maybeError.details,
        },
      });
    }
  }

  return { ...plan, wakeResults };
}
