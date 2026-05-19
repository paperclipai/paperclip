import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type {
  CarSessionTriggerEvaluationRequest,
  CarSessionTriggerSpec,
  PaperclipSessionActor,
  PaperclipSessionDocument,
  PaperclipSessionReceiptRedactionRequest,
  PaperclipSessionState,
  PaperclipSessionTaskRouteRequest,
  PaperclipSessionTransitionReceiptDocument,
  PaperclipSessionTransitionRequest,
  PaperclipSessionResponseRequest,
  PaperclipTaskRouteReceipt,
} from "@paperclipai/shared";
import {
  PAPERCLIP_SESSION_DOCUMENT_KEY,
  PAPERCLIP_SESSION_RECEIPT_DOCUMENT_KEY_PREFIX,
  paperclipSessionDocumentSchema,
  paperclipSessionTransitionReceiptDocumentSchema,
} from "@paperclipai/shared";
import {
  activityLog,
  agents,
  documentRevisions as documentRevisionTable,
  documents as documentTable,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  routines,
  standupParticipants,
  standupPolicies,
  standupSessions,
} from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { documentService } from "./documents.js";
import type { Db } from "@paperclipai/db";
import { issueService } from "./issues.js";

type IssueDocumentRow = {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title: string | null;
  format: string;
  body?: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type IssueDocumentStore = {
  getIssueDocumentByKey(issueId: string, key: string): Promise<IssueDocumentRow | null>;
  upsertIssueDocument(input: {
    issueId: string;
    key: string;
    title?: string | null;
    format: string;
    body: string;
    changeSummary?: string | null;
    baseRevisionId?: string | null;
    createdByAgentId?: string | null;
    createdByUserId?: string | null;
    allowReservedSessionDocumentKey?: boolean;
    expectedCompanyId?: string | null;
  }): Promise<{ created: boolean; document: IssueDocumentRow & { body: string } }>;
};

export type SessionStateReadinessInput = {
  inspectReliable: boolean;
  healthScanReliable: boolean;
  redactedReceiptLookupReliable: boolean;
  staleStateDetectionReliable: boolean;
  eodBacklogEnrollmentReliable: boolean;
};

export type SessionStateReadinessDecision = {
  decision: "document_backed" | "pivot_to_ledger";
  blockers: string[];
};

export function parseSessionDocumentBody(body: string): PaperclipSessionDocument {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    throw unprocessable("Session document body must be valid JSON");
  }

  const parsed = paperclipSessionDocumentSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw unprocessable("Session document body does not match session schema", parsed.error.issues);
  }
  return parsed.data;
}

export function parseSessionTransitionReceiptBody(body: string): PaperclipSessionTransitionReceiptDocument {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    throw unprocessable("Session transition receipt body must be valid JSON");
  }

  const parsed = paperclipSessionTransitionReceiptDocumentSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw unprocessable("Session transition receipt body does not match receipt schema", parsed.error.issues);
  }
  return parsed.data;
}

function serializeSessionDocument(document: PaperclipSessionDocument) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function serializeSessionTransitionReceipt(receipt: PaperclipSessionTransitionReceiptDocument) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function sessionTransitionReceiptDocumentKey(transitionId: string) {
  return `${PAPERCLIP_SESSION_RECEIPT_DOCUMENT_KEY_PREFIX}${transitionId}`;
}

function assertSessionStateMatchesDocumentEnvelope(document: IssueDocumentRow, state: PaperclipSessionDocument) {
  const mismatches: Record<string, unknown> = {};
  if (document.key !== PAPERCLIP_SESSION_DOCUMENT_KEY) mismatches.key = document.key;
  if (state.issueId !== document.issueId) {
    mismatches.issueId = { document: document.issueId, state: state.issueId };
  }
  if (state.companyId !== document.companyId) {
    mismatches.companyId = { document: document.companyId, state: state.companyId };
  }
  if (state.lastTransition.afterState !== state.state) {
    mismatches.afterState = { transition: state.lastTransition.afterState, state: state.state };
  }
  if (Object.keys(mismatches).length > 0) {
    throw unprocessable("Session document does not match issue/document envelope", mismatches);
  }
}

function assertNextSessionScope(input: { issueId: string; companyId: string }, nextState: PaperclipSessionDocument) {
  const mismatches: Record<string, unknown> = {};
  if (nextState.issueId !== input.issueId) {
    mismatches.issueId = { input: input.issueId, state: nextState.issueId };
  }
  if (nextState.companyId !== input.companyId) {
    mismatches.companyId = { input: input.companyId, state: nextState.companyId };
  }
  if (nextState.lastTransition.afterState !== nextState.state) {
    mismatches.afterState = { transition: nextState.lastTransition.afterState, state: nextState.state };
  }
  if (Object.keys(mismatches).length > 0) {
    throw unprocessable("Session next state does not match requested scope", mismatches);
  }
}

function assertTransitionReceiptMatchesSession(
  sessionDocument: IssueDocumentRow,
  sessionState: PaperclipSessionDocument,
  receiptDocument: IssueDocumentRow,
  receipt: PaperclipSessionTransitionReceiptDocument,
) {
  const mismatches: Record<string, unknown> = {};
  const latestRevisionId = sessionDocument.latestRevisionId;
  if (!latestRevisionId) mismatches.sessionRevisionId = { document: null, receipt: receipt.sessionRevisionId };
  if (receiptDocument.key !== sessionTransitionReceiptDocumentKey(sessionState.lastTransition.transitionId)) {
    mismatches.receiptKey = receiptDocument.key;
  }
  if (receipt.companyId !== sessionDocument.companyId || receipt.companyId !== sessionState.companyId) {
    mismatches.companyId = {
      document: sessionDocument.companyId,
      state: sessionState.companyId,
      receipt: receipt.companyId,
    };
  }
  if (receipt.issueId !== sessionDocument.issueId || receipt.issueId !== sessionState.issueId) {
    mismatches.issueId = {
      document: sessionDocument.issueId,
      state: sessionState.issueId,
      receipt: receipt.issueId,
    };
  }
  if (receipt.policyKey !== sessionState.policyKey) {
    mismatches.policyKey = { state: sessionState.policyKey, receipt: receipt.policyKey };
  }
  if (receipt.policyVersion !== sessionState.policyVersion) {
    mismatches.policyVersion = { state: sessionState.policyVersion, receipt: receipt.policyVersion };
  }
  if (receipt.sessionType !== sessionState.sessionType) {
    mismatches.sessionType = { state: sessionState.sessionType, receipt: receipt.sessionType };
  }
  if (receipt.sessionDocumentId !== sessionDocument.id) {
    mismatches.sessionDocumentId = { document: sessionDocument.id, receipt: receipt.sessionDocumentId };
  }
  if (latestRevisionId && receipt.sessionRevisionId !== latestRevisionId) {
    mismatches.sessionRevisionId = { document: latestRevisionId, receipt: receipt.sessionRevisionId };
  }
  if (receipt.stateRevision !== sessionState.stateRevision) {
    mismatches.stateRevision = { state: sessionState.stateRevision, receipt: receipt.stateRevision };
  }
  if (receipt.idempotencyKey !== sessionState.idempotencyKey) {
    mismatches.idempotencyKey = { state: sessionState.idempotencyKey, receipt: receipt.idempotencyKey };
  }
  if (receipt.transitionId !== sessionState.lastTransition.transitionId) {
    mismatches.transitionId = { state: sessionState.lastTransition.transitionId, receipt: receipt.transitionId };
  }
  if (receipt.transition !== sessionState.lastTransition.transition) {
    mismatches.transition = { state: sessionState.lastTransition.transition, receipt: receipt.transition };
  }
  if (receipt.beforeState !== sessionState.lastTransition.beforeState) {
    mismatches.beforeState = { state: sessionState.lastTransition.beforeState, receipt: receipt.beforeState };
  }
  if (receipt.afterState !== sessionState.lastTransition.afterState || receipt.afterState !== sessionState.state) {
    mismatches.afterState = {
      state: sessionState.state,
      transition: sessionState.lastTransition.afterState,
      receipt: receipt.afterState,
    };
  }
  if (JSON.stringify(receipt.actor) !== JSON.stringify(sessionState.lastTransition.actor)) {
    mismatches.actor = { state: sessionState.lastTransition.actor, receipt: receipt.actor };
  }
  if (Object.keys(mismatches).length > 0) {
    throw unprocessable("Session transition receipt does not match session document", mismatches);
  }
}

function buildTransitionReceipt(
  sessionDocument: IssueDocumentRow,
  sessionState: PaperclipSessionDocument,
): PaperclipSessionTransitionReceiptDocument {
  if (!sessionDocument.latestRevisionId) {
    throw unprocessable("Session transition receipt requires a session revision id");
  }
  return {
    schemaVersion: sessionState.schemaVersion,
    receiptType: "session_transition",
    recordedBy: "paperclip-session-service",
    companyId: sessionDocument.companyId,
    issueId: sessionDocument.issueId,
    policyKey: sessionState.policyKey,
    policyVersion: sessionState.policyVersion,
    sessionType: sessionState.sessionType,
    sessionDocumentId: sessionDocument.id,
    sessionRevisionId: sessionDocument.latestRevisionId,
    stateRevision: sessionState.stateRevision,
    idempotencyKey: sessionState.idempotencyKey,
    transitionId: sessionState.lastTransition.transitionId,
    transition: sessionState.lastTransition.transition,
    actor: sessionState.lastTransition.actor,
    beforeState: sessionState.lastTransition.beforeState,
    afterState: sessionState.lastTransition.afterState,
    createdAt: sessionState.lastTransition.at,
  };
}

async function readTrustedSessionDocument(documents: IssueDocumentStore, issueId: string) {
  const document = await documents.getIssueDocumentByKey(issueId, PAPERCLIP_SESSION_DOCUMENT_KEY);
  if (!document) return null;
  if (typeof document.body !== "string") {
    throw unprocessable("Session document read requires body");
  }
  const state = parseSessionDocumentBody(document.body);
  assertSessionStateMatchesDocumentEnvelope(document, state);

  const receiptKey = sessionTransitionReceiptDocumentKey(state.lastTransition.transitionId);
  const transitionReceiptDocument = await documents.getIssueDocumentByKey(issueId, receiptKey);
  if (!transitionReceiptDocument) {
    throw unprocessable("Session document is missing its server transition receipt", {
      transitionId: state.lastTransition.transitionId,
      receiptKey,
    });
  }
  if (typeof transitionReceiptDocument.body !== "string") {
    throw unprocessable("Session transition receipt read requires body");
  }
  const transitionReceipt = parseSessionTransitionReceiptBody(transitionReceiptDocument.body);
  assertTransitionReceiptMatchesSession(document, state, transitionReceiptDocument, transitionReceipt);

  return {
    document,
    state,
    transitionReceipt,
    transitionReceiptDocument,
  };
}

export function evaluateSessionStateModelReadiness(input: SessionStateReadinessInput): SessionStateReadinessDecision {
  const blockers: string[] = [];
  if (!input.inspectReliable) blockers.push("inspect");
  if (!input.healthScanReliable) blockers.push("health");
  if (!input.redactedReceiptLookupReliable) blockers.push("redacted_receipt_lookup");
  if (!input.staleStateDetectionReliable) blockers.push("stale_state_detection");
  if (!input.eodBacklogEnrollmentReliable) blockers.push("eod_backlog_enrollment");

  return {
    decision: blockers.length === 0 ? "document_backed" : "pivot_to_ledger",
    blockers,
  };
}

export function createSessionStateAdapter(documents: IssueDocumentStore) {
  return {
    read: async (issueId: string) => {
      return readTrustedSessionDocument(documents, issueId);
    },

    write: async (input: {
      issueId: string;
      companyId: string;
      expectedRevisionId?: string | null;
      expectedState?: PaperclipSessionState | null;
      nextState: PaperclipSessionDocument;
      actorAgentId?: string | null;
      actorUserId?: string | null;
      changeSummary?: string | null;
    }) => {
      const current = await documents.getIssueDocumentByKey(input.issueId, PAPERCLIP_SESSION_DOCUMENT_KEY);
      let before: PaperclipSessionDocument | null = null;
      let baseRevisionId: string | null = null;

      if (current) {
        if (current.companyId !== input.companyId) {
          throw unprocessable("Session document does not match requested company", {
            document: current.companyId,
            input: input.companyId,
          });
        }
        if (!input.expectedRevisionId) {
          throw conflict("Session update requires expectedRevisionId", {
            currentRevisionId: current.latestRevisionId,
          });
        }
        if (input.expectedRevisionId !== current.latestRevisionId) {
          throw conflict("Session state was updated by someone else", {
            currentRevisionId: current.latestRevisionId,
          });
        }
        const trustedCurrent = await readTrustedSessionDocument(documents, input.issueId);
        if (!trustedCurrent) {
          throw conflict("Session document does not exist yet");
        }
        before = trustedCurrent.state;
        if (!input.expectedState) {
          throw conflict("Session update requires expectedState", {
            currentState: before.state,
          });
        }
        if (input.expectedState !== before.state) {
          throw conflict("Session expectedState mismatch", {
            currentState: before.state,
          });
        }
        baseRevisionId = input.expectedRevisionId;
      } else if (input.expectedRevisionId || input.expectedState) {
        throw conflict("Session document does not exist yet", {
          expectedRevisionId: input.expectedRevisionId ?? null,
          expectedState: input.expectedState ?? null,
        });
      }

      const parsedNext = paperclipSessionDocumentSchema.parse(input.nextState);
      assertNextSessionScope(input, parsedNext);
      if (parsedNext.lastTransition.beforeState !== (before?.state ?? null)) {
        throw unprocessable("Session transition beforeState does not match current state", {
          currentState: before?.state ?? null,
          beforeState: parsedNext.lastTransition.beforeState,
        });
      }
      const receiptKey = sessionTransitionReceiptDocumentKey(parsedNext.lastTransition.transitionId);
      const existingReceipt = await documents.getIssueDocumentByKey(input.issueId, receiptKey);
      if (existingReceipt) {
        throw conflict("Session transition receipt already exists", {
          receiptKey,
          transitionId: parsedNext.lastTransition.transitionId,
        });
      }
      const result = await documents.upsertIssueDocument({
        issueId: input.issueId,
        key: PAPERCLIP_SESSION_DOCUMENT_KEY,
        title: `${parsedNext.sessionType} session`,
        format: "markdown",
        body: serializeSessionDocument(parsedNext),
        changeSummary: input.changeSummary ?? `${parsedNext.sessionType}:${parsedNext.state}`,
        baseRevisionId,
        createdByAgentId: input.actorAgentId ?? null,
        createdByUserId: input.actorUserId ?? null,
        allowReservedSessionDocumentKey: true,
        expectedCompanyId: input.companyId,
      });
      const transitionReceipt = buildTransitionReceipt(result.document, parsedNext);
      const transitionReceiptResult = await documents.upsertIssueDocument({
        issueId: input.issueId,
        key: receiptKey,
        title: `${parsedNext.sessionType} transition receipt`,
        format: "markdown",
        body: serializeSessionTransitionReceipt(transitionReceipt),
        changeSummary: `session-transition:${parsedNext.lastTransition.transition}`,
        createdByAgentId: input.actorAgentId ?? null,
        createdByUserId: input.actorUserId ?? null,
        allowReservedSessionDocumentKey: true,
        expectedCompanyId: input.companyId,
      });

      return {
        created: result.created,
        before,
        after: parsedNext,
        transitionReceipt,
        transitionReceiptDocument: transitionReceiptResult.document,
        beforeRevisionId: current?.latestRevisionId ?? null,
        afterRevisionId: result.document.latestRevisionId,
        document: result.document,
      };
    },
  };
}

export function sessionStateAdapter(db: Db) {
  return createSessionStateAdapter(documentService(db));
}

type SessionIssueRow = {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  priority: string;
  assigneeAgentId: string | null;
  identifier: string | null;
  title: string;
};

type CarSessionTriggerCandidate = ReturnType<typeof evaluateCarSessionAdHocTrigger> & {
  source: string;
  sourceId: string;
  evidence: Record<string, unknown>;
  action: "open_session" | "route_task" | "no_op";
};

type CarSessionTriggerDetectionInput = {
  companyId: string;
  policyKey: string;
  now?: Date;
  staleAfterMinutes?: number;
  openSessionCount?: number;
  openTaskCount?: number;
  sessionCap?: number;
  taskCap?: number;
};

type CarSessionTriggerDetectionResult = {
  detectorsRun: Array<CarSessionTriggerSpec["triggerClass"]>;
  sourceCounts: Record<string, number>;
  candidates: CarSessionTriggerCandidate[];
};

const SESSION_TERMINAL_STATES = new Set<PaperclipSessionState>(["completed", "cancelled", "rollback_disabled"]);

const CAR_SESSION_TRIGGER_FRAMEWORK: CarSessionTriggerSpec[] = [
  {
    triggerClass: "standup_nonresponse",
    detector: "standup participant due window expires without an authenticated response",
    source: "standup_sla",
    severityInputs: ["missed_count", "role_criticality", "minutes_overdue"],
    dedupeKeyFields: ["policy_key", "local_date", "participant_agent_id"],
    capRule: "cap open ad hoc sessions per policy sessionCap",
    overloadRule: "downgrade to owner-bound task when open sessions are at cap",
    correctionRule: "late response closes or downgrades the trigger",
    reopenRule: "new missed window after closure reopens by participant/date",
    noOpRule: "no-op when participant is excused or policy disabled",
    ownerRole: "OpsManager",
    persistentCompletionExpiry: null,
  },
  {
    triggerClass: "repeated_unanswered_directive",
    detector: "same actor directive is unanswered across the configured repeat window",
    source: "issue_comments_and_mentions",
    severityInputs: ["repeat_count", "age_minutes", "directive_priority"],
    dedupeKeyFields: ["directive_thread", "target_role"],
    capRule: "cap by directive owner and target role",
    overloadRule: "escalate prioritization receipt instead of opening another meeting",
    correctionRule: "answered directive resolves pending trigger",
    reopenRule: "new unanswered directive after answer opens a new dedupe key",
    noOpRule: "no-op when directive is informational or already accepted risk",
    ownerRole: "COO",
    persistentCompletionExpiry: null,
  },
  {
    triggerClass: "full_paper_work_halt",
    detector: "no material paper-work progress is observed inside the numeric progress window",
    source: "operator_progress_monitor",
    severityInputs: ["idle_minutes", "open_blockers", "strategy_pipeline_state"],
    dedupeKeyFields: ["company_id", "halt_window"],
    capRule: "one full-halt ad hoc session per halt window",
    overloadRule: "route to CEO review when repeated under cap pressure",
    correctionRule: "new material progress downgrades trigger",
    reopenRule: "subsequent halt window reopens",
    noOpRule: "no-op during approved planned pause",
    ownerRole: "CEO",
    persistentCompletionExpiry: null,
  },
  {
    triggerClass: "generator_nonproductive_state",
    detector: "generator state remains idle, incident, or nonproductive beyond policy window",
    source: "generator_runtime_state",
    severityInputs: ["state_age_minutes", "failed_attempts", "candidate_count"],
    dedupeKeyFields: ["generator_state", "runtime_lane"],
    capRule: "cap by runtime lane",
    overloadRule: "create owner-bound recovery task instead of extra ad hoc session",
    correctionRule: "productive generator state resolves trigger",
    reopenRule: "regression to nonproductive state reopens",
    noOpRule: "no-op when disabled by rollback receipt",
    ownerRole: "CRO",
    persistentCompletionExpiry: null,
  },
  {
    triggerClass: "failed_or_stalled_review",
    detector: "review issue has no qualified challenge or no downstream disposition by deadline",
    source: "session_review_inspect",
    severityInputs: ["review_age_minutes", "missing_challenge", "missing_disposition"],
    dedupeKeyFields: ["review_session_issue_id", "domain"],
    capRule: "one ad hoc session per stalled review",
    overloadRule: "route failed-router receipt to review owner",
    correctionRule: "qualified challenge and downstream disposition close the trigger",
    reopenRule: "redirected review missing owner reopens",
    noOpRule: "no-op when policy-valid non-applicability reason exists",
    ownerRole: "CTO",
    persistentCompletionExpiry: null,
  },
  {
    triggerClass: "runtime_risk",
    detector: "runtime health or execution errors cross configured severity",
    source: "paperclip_health_monitor",
    severityInputs: ["error_count", "affected_agents", "runtime_age_minutes"],
    dedupeKeyFields: ["runtime_surface", "failure_signature"],
    capRule: "cap by runtime surface",
    overloadRule: "open one incident task and append evidence to it",
    correctionRule: "healthy observation downgrades trigger",
    reopenRule: "new failure signature reopens",
    noOpRule: "no-op for stale resolved incidents",
    ownerRole: "OpsManager",
    persistentCompletionExpiry: null,
  },
  {
    triggerClass: "material_super_pass_event",
    detector: "strategy or research event crosses material SUPER-PASS threshold",
    source: "strategy_evaluator",
    severityInputs: ["score", "expected_return", "freshness_seconds"],
    dedupeKeyFields: ["strategy_id", "event_type"],
    capRule: "cap one ad hoc review per material strategy event",
    overloadRule: "route to CRO priority queue when cap exceeded",
    correctionRule: "event downgrade or stale source closes trigger",
    reopenRule: "fresh material event reopens",
    noOpRule: "no-op for live-capital authorization requests",
    ownerRole: "CRO",
    persistentCompletionExpiry: null,
  },
  {
    triggerClass: "eod_material_finding",
    detector: "EOD review records a material finding requiring follow-up",
    source: "session_eod_review",
    severityInputs: ["finding_priority", "blocked_roles", "age_minutes"],
    dedupeKeyFields: ["finding_id", "owner_role"],
    capRule: "cap by EOD session and owner role",
    overloadRule: "merge into existing owner-bound finding task",
    correctionRule: "disposition closes trigger",
    reopenRule: "rejected disposition with new evidence reopens",
    noOpRule: "no-op only with accepted-risk or no-op reason",
    ownerRole: "COO",
    persistentCompletionExpiry: null,
  },
  {
    triggerClass: "permission_or_task_router_blocker",
    detector: "task router cannot create owner-bound follow-up or permission boundary blocks paper work",
    source: "session_task_router",
    severityInputs: ["blocked_route_count", "authority_path", "minutes_blocked"],
    dedupeKeyFields: ["policy_key", "target_role", "blocked_reason"],
    capRule: "cap one blocker session per target role",
    overloadRule: "fall back to manager/audit issue receipt",
    correctionRule: "direct/service route success closes trigger",
    reopenRule: "revoked or failed service run reopens",
    noOpRule: "no-op for live-capital boundary because board approval is required",
    ownerRole: "CEO",
    persistentCompletionExpiry: null,
  },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nowIso(now: Date = new Date()) {
  return now.toISOString();
}

function cloneSessionDocument(state: PaperclipSessionDocument): PaperclipSessionDocument {
  return paperclipSessionDocumentSchema.parse(JSON.parse(JSON.stringify(state)));
}

function actorsEqual(a: PaperclipSessionActor, b: PaperclipSessionActor) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertSessionIssueScope(issue: SessionIssueRow | null, companyId: string) {
  if (!issue) throw notFound("Session issue not found");
  if (issue.companyId !== companyId) {
    throw forbidden("Session issue belongs to a different company");
  }
}

function normalizeReplayParticipants(
  requested: PaperclipSessionDocument,
  recorded: PaperclipSessionDocument,
) {
  const next = cloneSessionDocument(requested);
  next.participants = next.participants.map((participant, index) => {
    const recordedParticipant = recorded.participants[index];
    if (!recordedParticipant) return participant;
    if (participant.issueId && participant.issueId !== recordedParticipant.issueId) {
      throw conflict("Session idempotent replay participant issue does not match recorded transition", {
        role: participant.role,
      });
    }
    return {
      ...participant,
      issueId: recordedParticipant.issueId ?? participant.issueId ?? null,
    };
  });
  return next;
}

function assertIdempotentReplayMatchesRecorded(
  input: PaperclipSessionTransitionRequest,
  recorded: PaperclipSessionDocument,
) {
  if (input.idempotencyKey !== recorded.idempotencyKey) {
    throw conflict("Session idempotent replay key does not match recorded transition");
  }
  if (input.transition !== recorded.lastTransition.transition) {
    throw conflict("Session idempotent replay transition does not match recorded transition");
  }
  if (!actorsEqual(input.actor, recorded.lastTransition.actor)) {
    throw conflict("Session idempotent replay actor does not match recorded transition");
  }
  if (input.nextState.lastTransition.transition !== recorded.lastTransition.transition) {
    throw conflict("Session idempotent replay next state transition does not match recorded transition");
  }
  if (!actorsEqual(input.nextState.lastTransition.actor, recorded.lastTransition.actor)) {
    throw conflict("Session idempotent replay next state actor does not match recorded transition");
  }
  const requested = normalizeReplayParticipants(input.nextState, recorded);
  if (canonicalJson(requested) !== canonicalJson(recorded)) {
    throw conflict("Session idempotent replay next state does not match recorded transition");
  }
}

function assertSessionSourceImmutable(
  current: PaperclipSessionDocument | null,
  next: PaperclipSessionDocument,
) {
  if (!current) return;
  if (canonicalJson(current.source) !== canonicalJson(next.source)) {
    throw conflict("Session source cannot change after creation");
  }
}

function assertTransitionRequestMatchesNextState(
  input: PaperclipSessionTransitionRequest,
  current: PaperclipSessionDocument | null,
) {
  const next = input.nextState;
  if (next.idempotencyKey !== input.idempotencyKey) {
    throw unprocessable("Session transition idempotencyKey must match next state");
  }
  if (next.lastTransition.transition !== input.transition) {
    throw unprocessable("Session transition must match next state lastTransition");
  }
  if (!actorsEqual(next.lastTransition.actor, input.actor)) {
    throw unprocessable("Session actor must match next state lastTransition actor");
  }
  const expectedBefore = current?.state ?? null;
  if (next.lastTransition.beforeState !== expectedBefore) {
    throw conflict("Session transition beforeState does not match current state", {
      currentState: expectedBefore,
    });
  }
  const expectedRevision = current ? current.stateRevision + 1 : 0;
  if (next.stateRevision !== expectedRevision) {
    throw conflict("Session stateRevision must advance by one", {
      expectedRevision,
      actualRevision: next.stateRevision,
    });
  }
}

function assertAllowedTransition(
  before: PaperclipSessionState | null,
  transition: PaperclipSessionDocument["lastTransition"]["transition"],
  after: PaperclipSessionState,
) {
  if (before && SESSION_TERMINAL_STATES.has(before) && transition !== "rollback_disable") {
    throw conflict("Terminal sessions cannot transition except rollback_disable", { before, transition });
  }
  const ok =
    (transition === "create" && before == null && ["draft", "open", "waiting_response"].includes(after)) ||
    (transition === "open" && before === "draft" && after === "open") ||
    (transition === "request_response" && ["open", "draft"].includes(before ?? "") && after === "waiting_response") ||
    (transition === "respond" && ["open", "waiting_response"].includes(before ?? "") && ["waiting_response", "reviewing"].includes(after)) ||
    (transition === "mark_missed" && ["open", "waiting_response"].includes(before ?? "") && ["waiting_response", "blocked", "reviewing"].includes(after)) ||
    (transition === "challenge" && ["open", "waiting_response", "reviewing"].includes(before ?? "") && after === "reviewing") ||
    (["accept", "reject", "redirect"].includes(transition) && ["open", "waiting_response", "reviewing"].includes(before ?? "") &&
      ((transition === "accept" && after === "accepted") ||
        (transition === "reject" && after === "rejected") ||
        (transition === "redirect" && after === "redirected"))) ||
    (transition === "dispose_finding" && ["open", "waiting_response", "reviewing"].includes(before ?? "") && ["open", "reviewing"].includes(after)) ||
    (transition === "route_task" && before != null && after === before) ||
    (transition === "redact_receipt" && before != null && after === before) ||
    (transition === "reopen" && ["blocked", "rejected", "redirected", "cancelled"].includes(before ?? "") && after === "open") ||
    (transition === "complete" && ["open", "reviewing", "accepted", "rejected", "redirected"].includes(before ?? "") && after === "completed") ||
    (transition === "block" && before != null && after === "blocked") ||
    (transition === "rollback_disable" && after === "rollback_disabled") ||
    (transition === "cancel" && before != null && after === "cancelled");
  if (!ok) {
    throw conflict("Session transition is not allowed", { before, transition, after });
  }
}

const MAX_DECISION_SOURCE_FRESHNESS_SECONDS = 24 * 60 * 60;
const MAX_DECISION_SOURCE_FUTURE_SKEW_SECONDS = 5 * 60;

function decisionSourceFreshnessSeconds(state: PaperclipSessionDocument, observedAt: Date) {
  if (!state.source.collectedAt) return null;
  const collectedAtMs = Date.parse(state.source.collectedAt);
  const observedAtMs = observedAt.getTime();
  if (!Number.isFinite(collectedAtMs) || !Number.isFinite(observedAtMs)) return null;
  return Math.floor((observedAtMs - collectedAtMs) / 1000);
}

function assertDecisionSourceFreshness(state: PaperclipSessionDocument, observedAt: Date) {
  const reportedFreshnessSeconds = state.source.freshnessSeconds;
  if (
    typeof reportedFreshnessSeconds === "number" &&
    reportedFreshnessSeconds > MAX_DECISION_SOURCE_FRESHNESS_SECONDS
  ) {
    throw unprocessable("Session decision source evidence is stale", {
      freshnessSeconds: reportedFreshnessSeconds,
      maxFreshnessSeconds: MAX_DECISION_SOURCE_FRESHNESS_SECONDS,
    });
  }
  const freshnessSeconds = decisionSourceFreshnessSeconds(state, observedAt);
  if (freshnessSeconds === null) {
    throw unprocessable("Session decision source evidence requires collectedAt");
  }
  if (freshnessSeconds < -MAX_DECISION_SOURCE_FUTURE_SKEW_SECONDS) {
    throw unprocessable("Session decision source evidence cannot be collected in the future", {
      freshnessSeconds,
      maxFutureSkewSeconds: MAX_DECISION_SOURCE_FUTURE_SKEW_SECONDS,
    });
  }
  if (freshnessSeconds > MAX_DECISION_SOURCE_FRESHNESS_SECONDS) {
    throw unprocessable("Session decision source evidence is stale", {
      freshnessSeconds,
      maxFreshnessSeconds: MAX_DECISION_SOURCE_FRESHNESS_SECONDS,
    });
  }
}

function assertDecisionQuality(state: PaperclipSessionDocument, observedAt: Date = new Date()) {
  if (state.sessionType === "review" && ["accepted", "rejected", "redirected", "completed"].includes(state.state)) {
    assertDecisionSourceFreshness(state, observedAt);
    const review = state.reviews[0];
    if (!review) throw unprocessable("Review sessions require a review record before decision");
    const hasChallenge = typeof review.challenge === "string" && review.challenge.trim().length > 0;
    const hasNonApplicability =
      review.disposition === "not_applicable" &&
      typeof review.dispositionReason === "string" &&
      review.dispositionReason.trim().length > 0;
    if (!hasChallenge && !hasNonApplicability) {
      throw unprocessable("Review decision requires a qualified challenge or policy-valid non-applicability reason");
    }
    if (["accepted", "rejected", "redirected"].includes(state.state) && !review.downstreamOwnerRole) {
      throw unprocessable("Review decision requires a downstream owner role");
    }
  }

  if (state.sessionType === "eod" && ["reviewing", "accepted", "completed"].includes(state.state)) {
    assertDecisionSourceFreshness(state, observedAt);
    if (state.eodFindings.length === 0) {
      throw unprocessable("EOD review requires at least one material finding disposition");
    }
    const seen = new Set<string>();
    for (const finding of state.eodFindings) {
      if (seen.has(finding.findingId)) {
        throw unprocessable("EOD finding must have exactly one disposition", { findingId: finding.findingId });
      }
      seen.add(finding.findingId);
      if (["task", "ad_hoc_meeting", "system_change"].includes(finding.disposition) && !finding.ownerRole) {
        throw unprocessable("EOD material finding disposition requires an owner role", {
          findingId: finding.findingId,
        });
      }
      if (["accepted_risk", "no_op"].includes(finding.disposition) && !finding.reason.trim()) {
        throw unprocessable("EOD accepted-risk/no-op disposition requires a reason", {
          findingId: finding.findingId,
        });
      }
      if (["accepted", "completed"].includes(state.state) && finding.disposition === "task" && !finding.taskRouteId) {
        throw unprocessable("EOD task disposition requires an owner-bound task route", {
          findingId: finding.findingId,
        });
      }
    }
  }
}

function assertTaskRouteBoundary(input: PaperclipSessionTaskRouteRequest) {
  const searchable = `${input.title}\n${input.description}`.toLowerCase();
  const blocked = [
    ["live capital", "live-capital authority is outside session task routing"],
    ["real money", "real-money authority is outside session task routing"],
    ["permission grant", "permission mutation is outside session task routing"],
    ["grant permission", "permission mutation is outside session task routing"],
    ["instance admin", "permission mutation is outside session task routing"],
    ["unrelated project", "unrelated project mutation is outside session task routing"],
  ].find(([needle]) => searchable.includes(needle));
  if (blocked) throw forbidden(blocked[1]);
}

function buildLastTransition(input: {
  current: PaperclipSessionDocument;
  transition: PaperclipSessionDocument["lastTransition"]["transition"];
  actor: PaperclipSessionActor;
  now?: Date;
}) {
  return {
    transitionId: randomUUID(),
    transition: input.transition,
    actor: input.actor,
    beforeState: input.current.state,
    afterState: input.current.state,
    at: nowIso(input.now),
  };
}

export function evaluateCarSessionAdHocTrigger(input: CarSessionTriggerEvaluationRequest) {
  const spec = CAR_SESSION_TRIGGER_FRAMEWORK.find((candidate) => candidate.triggerClass === input.triggerClass);
  if (!spec) throw unprocessable("Unknown CAR session trigger class");
  const severityScore = Number(input.severityInputs.severityScore ?? input.severityInputs.score ?? 1);
  const overloaded = input.openSessionCount >= input.sessionCap || input.openTaskCount >= input.taskCap;
  const noOpReason = severityScore <= 0 ? spec.noOpRule : null;
  return {
    triggerClass: input.triggerClass,
    producer: spec.source,
    detector: spec.detector,
    severity: severityScore >= 3 ? "high" : severityScore >= 2 ? "medium" : "low",
    dedupeKey: input.dedupeKey,
    capDecision: input.openSessionCount >= input.sessionCap ? "at_session_cap" : "within_session_cap",
    overloadDecision: overloaded ? spec.overloadRule : "open_session_allowed",
    noOpReason,
    correctionTarget: input.correctionTarget ?? spec.correctionRule,
    reopenTarget: input.reopenTarget ?? spec.reopenRule,
    ownerRole: spec.ownerRole,
    ownerExpiry: spec.persistentCompletionExpiry,
  };
}

export function listCarSessionAdHocTriggerFramework() {
  return [...CAR_SESSION_TRIGGER_FRAMEWORK];
}

function carTriggerSpec(triggerClass: CarSessionTriggerSpec["triggerClass"]) {
  const spec = CAR_SESSION_TRIGGER_FRAMEWORK.find((candidate) => candidate.triggerClass === triggerClass);
  if (!spec) throw unprocessable("Unknown CAR session trigger class");
  return spec;
}

function numericSignal(value: unknown, fallback = 1) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

const ACTIVE_SESSION_STATES: readonly PaperclipSessionState[] = [
  "draft",
  "open",
  "waiting_response",
  "reviewing",
  "accepted",
  "rejected",
  "redirected",
  "blocked",
];

function isActiveSessionState(state: PaperclipSessionState) {
  return ACTIVE_SESSION_STATES.includes(state);
}

function buildTriggerCandidate(input: {
  triggerClass: CarSessionTriggerSpec["triggerClass"];
  sourceId: string;
  severityScore: number;
  dedupeKey: string;
  evidence: Record<string, unknown>;
  openSessionCount?: number;
  openTaskCount?: number;
  sessionCap?: number;
  taskCap?: number;
  action?: CarSessionTriggerCandidate["action"];
}) {
  const spec = carTriggerSpec(input.triggerClass);
  const evaluated = evaluateCarSessionAdHocTrigger({
    triggerClass: input.triggerClass,
    severityInputs: { ...input.evidence, severityScore: input.severityScore },
    dedupeKey: input.dedupeKey,
    openSessionCount: input.openSessionCount ?? 0,
    openTaskCount: input.openTaskCount ?? 0,
    sessionCap: input.sessionCap ?? 3,
    taskCap: input.taskCap ?? 12,
  });
  return {
    ...evaluated,
    source: spec.source,
    sourceId: input.sourceId,
    evidence: input.evidence,
    action: input.action ?? (evaluated.noOpReason ? "no_op" : "open_session"),
  };
}

export function sessionService(db: Db) {
  const documents = documentService(db);
  const adapter = createSessionStateAdapter(documents);
  const issueSvc = issueService(db);

  async function getIssue(issueId: string): Promise<SessionIssueRow | null> {
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        goalId: issues.goalId,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        identifier: issues.identifier,
        title: issues.title,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function assertParticipantAgent(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Participant agent not found");
    if (agent.companyId !== companyId) throw unprocessable("Participant agent must belong to session company");
    if (agent.status === "pending_approval" || agent.status === "terminated") {
      throw conflict("Participant agent cannot receive session obligations");
    }
  }

  async function readSessionDocumentsForPolicy(companyId: string, policyKey: string) {
    const rows = await db
      .select({
        issueId: issueDocuments.issueId,
        updatedAt: issueDocuments.updatedAt,
      })
      .from(issueDocuments)
      .where(and(
        eq(issueDocuments.companyId, companyId),
        eq(issueDocuments.key, PAPERCLIP_SESSION_DOCUMENT_KEY),
      ))
      .orderBy(desc(issueDocuments.updatedAt))
      .limit(100);

    const states: Array<{ issueId: string; updatedAt: Date; state: PaperclipSessionDocument }> = [];
    for (const row of rows) {
      try {
        const trusted = await adapter.read(row.issueId);
        if (trusted?.state.policyKey === policyKey && trusted.state.companyId === companyId) {
          states.push({ issueId: row.issueId, updatedAt: row.updatedAt, state: trusted.state });
        }
      } catch {
        // The session state gate owns parse/provenance failures. Detection only uses trusted session documents.
      }
    }
    return states;
  }

  async function countOpenSessionIssues(companyId: string, policyKey: string) {
    const rows = await readSessionDocumentsForPolicy(companyId, policyKey);
    return rows.filter((row) => isActiveSessionState(row.state.state)).length;
  }

  async function activeLinkedSessionRoutineExists(input: {
    companyId: string;
    policyKey: string;
    sessionType: PaperclipSessionDocument["sessionType"];
  }) {
    const active = await db
      .select({ id: routines.id })
      .from(routines)
      .where(and(
        eq(routines.companyId, input.companyId),
        eq(routines.status, "active"),
        sql`${routines.linkedSessionPolicy}->>'policyKey' = ${input.policyKey}`,
        sql`${routines.linkedSessionPolicy}->>'sessionType' = ${input.sessionType}`,
      ))
      .limit(1);
    return active.length > 0;
  }

  async function ensureParticipantObligations(
    issue: SessionIssueRow,
    state: PaperclipSessionDocument,
    actor: { agentId?: string | null; userId?: string | null },
  ) {
    const next = cloneSessionDocument(state);
    for (const participant of next.participants) {
      if (!participant.agentId || participant.issueId) continue;
      await assertParticipantAgent(issue.companyId, participant.agentId);
      const obligation = await issueSvc.create(issue.companyId, {
        projectId: issue.projectId,
        goalId: issue.goalId,
        parentId: issue.id,
        title: `${next.sessionType} session obligation: ${participant.role}`,
        description: [
          next.objective,
          "",
          `Session issue: ${issue.identifier ?? issue.id}`,
          `Proof target: respond through /api/sessions/respond with this assigned issue as evidence.`,
        ].join("\n"),
        status: "todo",
        priority: issue.priority,
        assigneeAgentId: participant.agentId,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        originKind: "session_participant_obligation",
        originId: issue.id,
        originRunId: next.lastTransition.actor.runId ?? null,
      });
      participant.issueId = obligation.id;
    }
    return next;
  }

  async function inspect(input: { issueId: string; includeReceipts?: boolean }) {
    const trusted = await adapter.read(input.issueId);
    if (!trusted) throw notFound("Session not found");
    const issue = await getIssue(input.issueId);
    assertSessionIssueScope(issue, trusted.state.companyId);
    const participantIssues = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        originRunId: issues.originRunId,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, trusted.state.companyId),
        eq(issues.parentId, input.issueId),
        eq(issues.originKind, "session_participant_obligation"),
        eq(issues.originId, input.issueId),
      ));

    return {
      companyId: trusted.state.companyId,
      issue,
      document: {
        id: trusted.document.id,
        key: trusted.document.key,
        latestRevisionId: trusted.document.latestRevisionId,
        latestRevisionNumber: trusted.document.latestRevisionNumber,
      },
      session: trusted.state,
      transitionReceipt: trusted.transitionReceipt,
      transitionReceiptDocument: {
        id: trusted.transitionReceiptDocument.id,
        key: trusted.transitionReceiptDocument.key,
        latestRevisionId: trusted.transitionReceiptDocument.latestRevisionId,
      },
      participantIssues,
      receipts: input.includeReceipts === false ? [] : trusted.state.receipts,
      taskRoutes: trusted.state.taskRoutes,
      reviews: trusted.state.reviews,
      eodFindings: trusted.state.eodFindings,
      health: trusted.state.health,
    };
  }

  async function transition(input: PaperclipSessionTransitionRequest) {
    const issue = await getIssue(input.issueId);
    assertSessionIssueScope(issue, input.nextState.companyId);
    const current = await adapter.read(input.issueId);
    if (current && current.state.idempotencyKey === input.idempotencyKey) {
      assertIdempotentReplayMatchesRecorded(input, current.state);
      return { replayed: true, ...(await inspect({ issueId: input.issueId })) };
    }
    assertSessionSourceImmutable(current?.state ?? null, input.nextState);
    assertTransitionRequestMatchesNextState(input, current?.state ?? null);
    assertAllowedTransition(current?.state.state ?? null, input.transition, input.nextState.state);
    assertDecisionQuality(input.nextState, new Date());
    const nextState = await ensureParticipantObligations(issue!, input.nextState, {
      agentId: input.actor.agentId ?? null,
      userId: input.actor.userId ?? null,
    });
    const written = await adapter.write({
      issueId: input.issueId,
      companyId: input.nextState.companyId,
      expectedRevisionId: input.expectedRevisionId ?? null,
      expectedState: input.expectedState ?? null,
      nextState,
      actorAgentId: input.actor.agentId ?? null,
      actorUserId: input.actor.userId ?? null,
      changeSummary: `session:${input.transition}`,
    });
    return { replayed: false, write: written, ...(await inspect({ issueId: input.issueId })) };
  }

  async function respond(input: PaperclipSessionResponseRequest) {
    const trusted = await adapter.read(input.issueId);
    if (!trusted) throw notFound("Session not found");
    if (trusted.document.latestRevisionId !== input.expectedRevisionId) {
      throw conflict("Session state was updated by someone else", {
        currentRevisionId: trusted.document.latestRevisionId,
      });
    }
    const participantIndex = trusted.state.participants.findIndex(
      (participant) => participant.agentId === input.participantAgentId,
    );
    if (participantIndex < 0) throw forbidden("Authenticated agent is not a session participant");
    if (input.actor.actorType !== "agent" || input.actor.agentId !== input.participantAgentId) {
      throw forbidden("Session response actor must match participant agent");
    }

    const next = cloneSessionDocument(trusted.state);
    const responseId =
      typeof input.response.responseId === "string" && input.response.responseId.trim()
        ? input.response.responseId.trim()
        : randomUUID();
    next.participants[participantIndex] = {
      ...next.participants[participantIndex],
      status: "responded",
      responseId,
      missedReason: null,
    };
    next.state = next.participants.every((participant) => participant.status === "responded" || participant.status === "excused")
      ? "reviewing"
      : "waiting_response";
    next.stateRevision += 1;
    next.idempotencyKey = `session-response:${input.issueId}:${input.participantAgentId}:${responseId}`;
    next.lastTransition = {
      transitionId: randomUUID(),
      transition: "respond",
      actor: input.actor,
      beforeState: trusted.state.state,
      afterState: next.state,
      at: nowIso(),
    };

    const written = await adapter.write({
      issueId: input.issueId,
      companyId: trusted.state.companyId,
      expectedRevisionId: input.expectedRevisionId,
      expectedState: trusted.state.state,
      nextState: next,
      actorAgentId: input.participantAgentId,
      changeSummary: "session:respond",
    });
    return { write: written, ...(await inspect({ issueId: input.issueId })) };
  }

  function assertRouteFindingAllowed(
    state: PaperclipSessionDocument,
    input: PaperclipSessionTaskRouteRequest,
    assigneeAgentId: string | null,
  ) {
    const targetParticipant = state.participants.find((participant) => participant.role === input.targetRole);
    if (!targetParticipant) {
      throw forbidden("Task route targetRole must match a session participant role");
    }
    if (input.intendedOwnerRole !== input.targetRole) {
      throw forbidden("Task route intendedOwnerRole must match the target participant role");
    }
    if (input.assigneeAgentId && targetParticipant.agentId && input.assigneeAgentId !== targetParticipant.agentId) {
      throw forbidden("Task route assignee must match the target participant agent");
    }
    if (input.assigneeAgentId && !targetParticipant.agentId) {
      throw forbidden("Task route cannot assign outside a target participant");
    }
    if (assigneeAgentId && targetParticipant.agentId && assigneeAgentId !== targetParticipant.agentId) {
      throw forbidden("Task route resolved assignee must match the target participant agent");
    }

    const materialEodFinding = state.eodFindings.find(
      (finding) =>
        finding.findingId === input.sourceFindingId &&
        finding.ownerRole === input.targetRole &&
        ["task", "ad_hoc_meeting", "system_change"].includes(finding.disposition),
    );
    if (materialEodFinding) return;

    const reviewFinding = state.reviews.find(
      (review) =>
        review.domain === input.sourceFindingId &&
        review.downstreamOwnerRole === input.targetRole &&
        ["accepted", "rejected", "redirected"].includes(review.disposition ?? ""),
    );
    if (reviewFinding) return;

    const healthFinding = state.health.find(
      (observation) =>
        observation.observationId === input.sourceFindingId &&
        observation.ownerRole === input.targetRole &&
        observation.status !== "healthy",
    );
    if (healthFinding) return;

    throw forbidden("Task route sourceFindingId must reference a material session finding for the target role");
  }

  async function validateServiceRunAuthority(input: {
    serviceRunId: string | null | undefined;
    companyId: string;
    policyKey: string;
    sessionType: string;
    actorAgentId?: string | null;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!input.serviceRunId) return { ok: false, reason: "service_run_missing" };
    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.serviceRunId))
      .then((rows) => rows[0] ?? null);
    if (!run) return { ok: false, reason: "service_run_not_found" };
    if (run.companyId !== input.companyId) return { ok: false, reason: "service_run_company_mismatch" };
    if (input.actorAgentId && run.agentId !== input.actorAgentId) {
      return { ok: false, reason: "service_run_agent_mismatch" };
    }
    if (["failed", "cancelled", "timed_out"].includes(run.status)) return { ok: false, reason: "service_run_not_active" };
    const snapshot = asRecord(run.contextSnapshot);
    const policyKey = typeof snapshot.policyKey === "string" ? snapshot.policyKey : null;
    if (policyKey !== input.policyKey) return { ok: false, reason: "service_run_policy_mismatch" };
    const allowedSessionTypes = Array.isArray(snapshot.allowedSessionTypes)
      ? snapshot.allowedSessionTypes.filter((value): value is string => typeof value === "string")
      : typeof snapshot.sessionType === "string"
        ? [snapshot.sessionType]
        : [];
    if (!allowedSessionTypes.includes(input.sessionType)) {
      return { ok: false, reason: "service_run_session_type_mismatch" };
    }
    if (snapshot.revokedAt || snapshot.routerRevoked === true || snapshot.routerKillSwitch === true) {
      return { ok: false, reason: "service_run_router_revoked" };
    }
    const policyActive = await activeLinkedSessionRoutineExists({
      companyId: input.companyId,
      policyKey: input.policyKey,
      sessionType: input.sessionType as PaperclipSessionDocument["sessionType"],
    });
    if (!policyActive) return { ok: false, reason: "service_run_policy_disabled" };
    return { ok: true };
  }

  async function appendTaskRouteReceipt(input: {
    trusted: Awaited<ReturnType<typeof readTrustedSessionDocument>>;
    route: PaperclipTaskRouteReceipt;
    actor: PaperclipSessionActor;
    expectedRevisionId: string;
  }) {
    if (!input.trusted) throw notFound("Session not found");
    const next = cloneSessionDocument(input.trusted.state);
    next.taskRoutes = [...next.taskRoutes, input.route];
    if (input.route.authorityPath !== "failed_router" && input.route.createdIssueId) {
      next.eodFindings = next.eodFindings.map((finding) =>
        finding.findingId === input.route.sourceFindingId &&
        finding.ownerRole === input.route.targetRole &&
        finding.disposition === "task"
          ? { ...finding, taskRouteId: input.route.routeId }
          : finding,
      );
    }
    next.stateRevision += 1;
    next.idempotencyKey = `session-task-route:${input.route.routeId}`;
    next.lastTransition = buildLastTransition({ current: input.trusted.state, transition: "route_task", actor: input.actor });
    const written = await adapter.write({
      issueId: input.trusted.state.issueId,
      companyId: input.trusted.state.companyId,
      expectedRevisionId: input.expectedRevisionId,
      expectedState: input.trusted.state.state,
      nextState: next,
      actorAgentId: input.actor.agentId ?? null,
      actorUserId: input.actor.userId ?? null,
      changeSummary: "session:route-task",
    });
    return written;
  }

  async function routeTask(input: PaperclipSessionTaskRouteRequest) {
    assertTaskRouteBoundary(input);
    if (input.actor.actorType === "service" && !input.serviceRunId) {
      throw forbidden("Session service task route requires serviceRunId");
    }
    if (input.actor.actorType === "service" && !input.actor.agentId) {
      throw forbidden("Session service task route requires actor agentId");
    }
    if (input.serviceRunId && input.actor.runId !== input.serviceRunId) {
      throw forbidden("Session task route actor run must match serviceRunId");
    }
    const trusted = await adapter.read(input.issueId);
    if (!trusted) throw notFound("Session not found");
    if (trusted.document.latestRevisionId !== input.expectedRevisionId) {
      throw conflict("Session state was updated by someone else", {
        currentRevisionId: trusted.document.latestRevisionId,
      });
    }
    const issue = await getIssue(input.issueId);
    assertSessionIssueScope(issue, trusted.state.companyId);
    let assigneeAgentId = input.assigneeAgentId ?? null;
    let authorityPath: PaperclipTaskRouteReceipt["authorityPath"] = input.serviceRunId ? "service" : "direct";
    let blockedReason: string | null = null;

    if (!assigneeAgentId) {
      assigneeAgentId = trusted.state.participants.find((participant) => participant.role === input.targetRole)?.agentId ?? null;
      authorityPath = assigneeAgentId ? "multi_actor_fallback" : "failed_router";
      if (!assigneeAgentId) blockedReason = "target_role_has_no_participant_agent";
    }
    assertRouteFindingAllowed(trusted.state, input, assigneeAgentId);

    if (input.serviceRunId) {
      const authority = await validateServiceRunAuthority({
        serviceRunId: input.serviceRunId,
        companyId: trusted.state.companyId,
        policyKey: trusted.state.policyKey,
        sessionType: trusted.state.sessionType,
        actorAgentId: input.actor.actorType === "service" ? input.actor.agentId : null,
      });
      if (!authority.ok) {
        if (authority.reason === "service_run_agent_mismatch") {
          throw forbidden("Session service task route actor must own serviceRunId");
        }
        blockedReason = authority.reason;
        authorityPath = "failed_router";
      }
    }

    let createdIssueId: string | null = null;
    if (authorityPath !== "failed_router" && assigneeAgentId) {
      await assertParticipantAgent(trusted.state.companyId, assigneeAgentId);
      const created = await issueSvc.create(trusted.state.companyId, {
        projectId: issue!.projectId,
        goalId: issue!.goalId,
        parentId: input.issueId,
        title: input.title,
        description: input.description,
        status: "todo",
        priority: input.priority,
        assigneeAgentId,
        createdByAgentId: input.actor.agentId ?? null,
        createdByUserId: input.actor.userId ?? null,
        originKind: "session_task_route",
        originId: input.issueId,
        originRunId: input.serviceRunId ?? input.actor.runId ?? null,
      });
      createdIssueId = created.id;
    }

    const route: PaperclipTaskRouteReceipt = {
      routeId: randomUUID(),
      authorityPath,
      companyId: trusted.state.companyId,
      policyKey: trusted.state.policyKey,
      sessionType: trusted.state.sessionType,
      sourceFindingId: input.sourceFindingId,
      intendedOwnerRole: input.intendedOwnerRole,
      targetRole: input.targetRole,
      createdIssueId,
      actor: input.actor,
      serviceRunId: input.serviceRunId ?? null,
      routerRevoked: blockedReason === "service_run_router_revoked",
      blockedReason,
    };
    const write = await appendTaskRouteReceipt({
      trusted,
      route,
      actor: input.actor,
      expectedRevisionId: input.expectedRevisionId,
    });
    return { route, write, ...(await inspect({ issueId: input.issueId })) };
  }

  async function redactReceipt(input: PaperclipSessionReceiptRedactionRequest) {
    const trusted = await adapter.read(input.issueId);
    if (!trusted) throw notFound("Session not found");
    if (trusted.document.latestRevisionId !== input.expectedRevisionId) {
      throw conflict("Session state was updated by someone else", {
        currentRevisionId: trusted.document.latestRevisionId,
      });
    }
    const managerReceiptId = randomUUID();
    const managerAuditDocument = await db.transaction(async (tx) => {
      const now = new Date();
      const body = `${JSON.stringify(input.redaction.managerReceipt, null, 2)}\n`;
      const [document] = await tx
        .insert(documentTable)
        .values({
          companyId: trusted.state.companyId,
          title: "Session manager audit receipt",
          format: "markdown",
          latestBody: body,
          latestRevisionId: null,
          latestRevisionNumber: 1,
          createdByAgentId: input.actor.agentId ?? null,
          createdByUserId: input.actor.userId ?? null,
          updatedByAgentId: input.actor.agentId ?? null,
          updatedByUserId: input.actor.userId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const [revision] = await tx
        .insert(documentRevisionTable)
        .values({
          companyId: trusted.state.companyId,
          documentId: document.id,
          revisionNumber: 1,
          body,
          changeSummary: "session:manager-audit-receipt",
          createdByAgentId: input.actor.agentId ?? null,
          createdByUserId: input.actor.userId ?? null,
          createdAt: now,
        })
        .returning();
      await tx
        .update(documentTable)
        .set({ latestRevisionId: revision.id })
        .where(eq(documentTable.id, document.id));
      return { ...document, latestRevisionId: revision.id };
    });
    const participantIssueIds = trusted.state.participants
      .map((participant) => participant.issueId)
      .filter((issueId): issueId is string => typeof issueId === "string" && issueId.length > 0);
    if (participantIssueIds.length === 0) {
      throw unprocessable("Participant redacted receipt requires participant obligation issues");
    }
    const participantReceipts = [];
    for (const participantIssueId of participantIssueIds) {
      const participantReceiptId = randomUUID();
      const participant = await documents.upsertIssueDocument({
        issueId: participantIssueId,
        key: `${PAPERCLIP_SESSION_RECEIPT_DOCUMENT_KEY_PREFIX}${participantReceiptId}`,
        title: "Session participant redacted receipt",
        format: "markdown",
        body: `${JSON.stringify(input.redaction.participantReceipt, null, 2)}\n`,
        createdByAgentId: input.actor.agentId ?? null,
        createdByUserId: input.actor.userId ?? null,
        allowReservedSessionDocumentKey: true,
        expectedCompanyId: trusted.state.companyId,
      });
      participantReceipts.push({
        receiptId: participantReceiptId,
        auditId: input.redaction.auditId,
        visibility: "participant_redacted" as const,
        issueId: participantIssueId,
        documentId: participant.document.id,
        redacted: true,
        createdAt: nowIso(),
      });
    }

    const next = cloneSessionDocument(trusted.state);
    next.receipts = [
      ...next.receipts,
      {
        receiptId: managerReceiptId,
        auditId: input.redaction.auditId,
        visibility: "manager_audit",
        issueId: null,
        documentId: managerAuditDocument.id,
        redacted: false,
        createdAt: nowIso(),
      },
      ...participantReceipts,
    ];
    next.stateRevision += 1;
    next.idempotencyKey = `session-redact:${input.issueId}:${input.redaction.auditId}`;
    next.lastTransition = buildLastTransition({ current: trusted.state, transition: "redact_receipt", actor: input.actor });
    const write = await adapter.write({
      issueId: input.issueId,
      companyId: trusted.state.companyId,
      expectedRevisionId: input.expectedRevisionId,
      expectedState: trusted.state.state,
      nextState: next,
      actorAgentId: input.actor.agentId ?? null,
      actorUserId: input.actor.userId ?? null,
      changeSummary: "session:redact-receipt",
    });
    return { write, redactedReceipts: next.receipts, ...(await inspect({ issueId: input.issueId })) };
  }

  async function rollbackDisable(input: {
    companyId: string;
    policyKey: string;
    sessionType: PaperclipSessionDocument["sessionType"];
    triggerClass: string;
    expectedNoNewSessionProof: string;
    actor: PaperclipSessionActor;
  }) {
    const disabled = await db
      .update(routines)
      .set({ status: "paused", updatedAt: new Date() })
      .where(and(
        eq(routines.companyId, input.companyId),
        eq(routines.status, "active"),
        sql`${routines.linkedSessionPolicy}->>'policyKey' = ${input.policyKey}`,
        sql`${routines.linkedSessionPolicy}->>'sessionType' = ${input.sessionType}`,
      ))
      .returning({ id: routines.id, title: routines.title });
    const revokedAt = nowIso();
    const revokedRuns = await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || jsonb_build_object(
          'routerRevoked', true,
          'routerKillSwitch', true,
          'revokedAt', ${revokedAt}::text,
          'revokedByPolicyKey', ${input.policyKey}::text,
          'revokedSessionType', ${input.sessionType}::text
        )`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'policyKey' = ${input.policyKey}`,
        sql`(
          ${heartbeatRuns.contextSnapshot}->>'sessionType' = ${input.sessionType}
          or exists (
            select 1
            from jsonb_array_elements_text(coalesce(${heartbeatRuns.contextSnapshot}->'allowedSessionTypes', '[]'::jsonb)) as allowed(session_type)
            where allowed.session_type = ${input.sessionType}::text
          )
        )`,
      ))
      .returning({ id: heartbeatRuns.id });
    return {
      companyId: input.companyId,
      policyKey: input.policyKey,
      sessionType: input.sessionType,
      triggerClass: input.triggerClass,
      disabledRoutineIds: disabled.map((row) => row.id),
      revokedServiceRunIds: revokedRuns.map((row) => row.id),
      preservedHistory: true,
      futureTriggersDisabled: true,
      expectedNoNewSessionProof: input.expectedNoNewSessionProof,
      auditId: randomUUID(),
      actor: input.actor,
    };
  }

  async function detectAdHocTriggers(input: CarSessionTriggerDetectionInput): Promise<CarSessionTriggerDetectionResult> {
    const now = input.now ?? new Date();
    const staleCutoff = new Date(now.getTime() - (input.staleAfterMinutes ?? 60) * 60 * 1000);
    const detectorsRun = CAR_SESSION_TRIGGER_FRAMEWORK.map((entry) => entry.triggerClass);
    const sourceCounts = Object.fromEntries(detectorsRun.map((triggerClass) => [triggerClass, 0])) as Record<string, number>;
    const candidates: CarSessionTriggerCandidate[] = [];
    const openSessionCount = input.openSessionCount ?? await countOpenSessionIssues(input.companyId, input.policyKey);
    const openTaskCount = input.openTaskCount ?? await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.originKind, "session_task_route"),
        inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
      ))
      .then((rows) => rows.length);

    const pushCandidate = (candidate: Omit<Parameters<typeof buildTriggerCandidate>[0], "openSessionCount" | "openTaskCount" | "sessionCap" | "taskCap">) => {
      candidates.push(buildTriggerCandidate({
        ...candidate,
        openSessionCount,
        openTaskCount,
        sessionCap: input.sessionCap,
        taskCap: input.taskCap,
      }));
    };

    const missedStandups = await db
      .select({
        participantId: standupParticipants.id,
        sessionId: standupParticipants.sessionId,
        agentId: standupParticipants.agentId,
        roleKey: standupParticipants.roleKey,
        responseDueAt: standupParticipants.responseDueAt,
        localDate: standupSessions.localDate,
        standupPolicyKey: standupPolicies.policyKey,
      })
      .from(standupParticipants)
      .innerJoin(standupSessions, eq(standupParticipants.sessionId, standupSessions.id))
      .innerJoin(standupPolicies, eq(standupSessions.policyId, standupPolicies.id))
      .where(and(
        eq(standupParticipants.companyId, input.companyId),
        inArray(standupParticipants.responseStatus, ["pending", "missing", "rejected"]),
        lte(standupParticipants.responseDueAt, now),
      ))
      .limit(25);
    sourceCounts.standup_nonresponse = missedStandups.length;
    for (const row of missedStandups) {
      pushCandidate({
        triggerClass: "standup_nonresponse",
        sourceId: row.participantId,
        severityScore: row.responseDueAt <= staleCutoff ? 3 : 2,
        dedupeKey: `${row.standupPolicyKey}:${row.localDate}:${row.agentId}`,
        evidence: {
          participantId: row.participantId,
          sessionId: row.sessionId,
          roleKey: row.roleKey,
          responseDueAt: row.responseDueAt.toISOString(),
        },
      });
    }

    const directiveComments = await db
      .select({
        id: issueComments.id,
        issueId: issueComments.issueId,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, input.companyId),
        sql`${issueComments.body} ILIKE ${"%directive%"}`,
      ))
      .orderBy(desc(issueComments.createdAt))
      .limit(100);
    const directiveCounts = new Map<string, typeof directiveComments>();
    for (const row of directiveComments) {
      directiveCounts.set(row.issueId, [...(directiveCounts.get(row.issueId) ?? []), row]);
    }
    for (const [issueId, rows] of directiveCounts) {
      if (rows.length < 2) continue;
      sourceCounts.repeated_unanswered_directive += rows.length;
      pushCandidate({
        triggerClass: "repeated_unanswered_directive",
        sourceId: issueId,
        severityScore: rows.length >= 3 ? 3 : 2,
        dedupeKey: `directive:${issueId}`,
        evidence: { issueId, repeatCount: rows.length, latestCommentId: rows[0]?.id },
      });
    }

    const stalePaperIssues = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, input.companyId),
        inArray(issues.status, ["todo", "in_progress", "blocked"]),
        lte(issues.updatedAt, staleCutoff),
        sql`${issues.originKind} not in ('session_task_route', 'session_participant_obligation')`,
      ))
      .limit(25);
    sourceCounts.full_paper_work_halt = stalePaperIssues.length;
    if (stalePaperIssues.length > 0) {
      pushCandidate({
        triggerClass: "full_paper_work_halt",
        sourceId: stalePaperIssues[0]!.id,
        severityScore: stalePaperIssues.some((issue) => issue.status === "blocked") ? 3 : 2,
        dedupeKey: `paper-halt:${input.companyId}:${staleCutoff.toISOString().slice(0, 13)}`,
        evidence: {
          staleIssueCount: stalePaperIssues.length,
          sampleIssueIds: stalePaperIssues.slice(0, 5).map((issue) => issue.identifier ?? issue.id),
        },
      });
    }

    const generatorRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->>'generatorState', ${heartbeatRuns.contextSnapshot}->>'state') in ('idle', 'incident', 'nonproductive', 'error')`,
      ))
      .orderBy(desc(heartbeatRuns.updatedAt))
      .limit(10);
    sourceCounts.generator_nonproductive_state = generatorRuns.length;
    for (const row of generatorRuns) {
      const snapshot = asRecord(row.contextSnapshot);
      const generatorState = String(snapshot.generatorState ?? snapshot.state ?? row.status);
      pushCandidate({
        triggerClass: "generator_nonproductive_state",
        sourceId: row.id,
        severityScore: generatorState === "incident" || generatorState === "error" ? 3 : 2,
        dedupeKey: `generator:${snapshot.runtimeLane ?? "default"}:${generatorState}`,
        evidence: { runId: row.id, generatorState, updatedAt: row.updatedAt.toISOString() },
      });
    }

    const sessionRows = await readSessionDocumentsForPolicy(input.companyId, input.policyKey);
    for (const row of sessionRows) {
      const state = row.state;
      if (state.sessionType === "review" && isActiveSessionState(state.state)) {
        const review = state.reviews[0];
        const missingChallenge = !review?.challenge && review?.disposition !== "not_applicable";
        const missingDispositionOwner =
          review?.disposition &&
          ["accepted", "rejected", "redirected"].includes(review.disposition) &&
          !review.downstreamOwnerRole;
        if (missingChallenge || missingDispositionOwner || state.state === "reviewing") {
          sourceCounts.failed_or_stalled_review += 1;
          pushCandidate({
            triggerClass: "failed_or_stalled_review",
            sourceId: row.issueId,
            severityScore: missingDispositionOwner ? 3 : 2,
            dedupeKey: `review:${row.issueId}:${review?.domain ?? "unqualified"}`,
            evidence: { issueId: row.issueId, missingChallenge, missingDispositionOwner, state: state.state },
          });
        }
      }

      for (const finding of state.eodFindings) {
        if (!["task", "ad_hoc_meeting", "system_change"].includes(finding.disposition)) continue;
        if (!finding.ownerRole) continue;
        sourceCounts.eod_material_finding += 1;
        pushCandidate({
          triggerClass: "eod_material_finding",
          sourceId: finding.findingId,
          severityScore: finding.disposition === "system_change" ? 3 : 2,
          dedupeKey: `eod:${finding.findingId}:${finding.ownerRole}`,
          evidence: {
            issueId: row.issueId,
            findingId: finding.findingId,
            disposition: finding.disposition,
            ownerRole: finding.ownerRole,
          },
          action: finding.disposition === "task" ? "route_task" : "open_session",
        });
      }

      for (const route of state.taskRoutes) {
        if (route.authorityPath !== "failed_router" && !route.blockedReason) continue;
        sourceCounts.permission_or_task_router_blocker += 1;
        pushCandidate({
          triggerClass: "permission_or_task_router_blocker",
          sourceId: route.routeId,
          severityScore: route.routerRevoked ? 3 : 2,
          dedupeKey: `router:${route.policyKey}:${route.targetRole}:${route.blockedReason ?? route.authorityPath}`,
          evidence: {
            issueId: row.issueId,
            routeId: route.routeId,
            authorityPath: route.authorityPath,
            blockedReason: route.blockedReason,
            targetRole: route.targetRole,
          },
          action: "route_task",
        });
      }
    }

    const runtimeEvents = await db
      .select({
        id: activityLog.id,
        action: activityLog.action,
        entityId: activityLog.entityId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        sql`(${activityLog.action} ILIKE ${"%runtime%"} OR ${activityLog.action} ILIKE ${"%health%"} OR ${activityLog.action} ILIKE ${"%error%"})`,
      ))
      .orderBy(desc(activityLog.createdAt))
      .limit(25);
    for (const event of runtimeEvents) {
      const details = asRecord(event.details);
      const status = String(details.status ?? "");
      const severityScore = numericSignal(details.severityScore ?? details.error_count, event.action.includes("error") ? 3 : 1);
      if (!["blocked", "degraded", "failed"].includes(status) && severityScore <= 1) continue;
      sourceCounts.runtime_risk += 1;
      pushCandidate({
        triggerClass: "runtime_risk",
        sourceId: event.id,
        severityScore,
        dedupeKey: `runtime:${details.runtime_surface ?? event.entityId}:${details.failure_signature ?? event.action}`,
        evidence: { action: event.action, entityId: event.entityId, status, details },
      });
    }

    const superPassEvents = await db
      .select({
        id: activityLog.id,
        entityId: activityLog.entityId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        sql`(${activityLog.action} ILIKE ${"%super%pass%"} OR ${activityLog.details}->>'eventType' = 'super_pass')`,
      ))
      .orderBy(desc(activityLog.createdAt))
      .limit(25);
    sourceCounts.material_super_pass_event = superPassEvents.length;
    for (const event of superPassEvents) {
      const details = asRecord(event.details);
      pushCandidate({
        triggerClass: "material_super_pass_event",
        sourceId: event.id,
        severityScore: numericSignal(details.score ?? details.severityScore, 3),
        dedupeKey: `super-pass:${details.strategy_id ?? details.strategyId ?? event.entityId}:${details.eventType ?? "event"}`,
        evidence: { entityId: event.entityId, details, createdAt: event.createdAt.toISOString() },
      });
    }

    return { detectorsRun, sourceCounts, candidates };
  }

  return {
    inspect,
    transition,
    respond,
    routeTask,
    redactReceipt,
    rollbackDisable,
    validateServiceRunAuthority,
    evaluateAdHocTrigger: evaluateCarSessionAdHocTrigger,
    detectAdHocTriggers,
    listAdHocTriggerFramework: listCarSessionAdHocTriggerFramework,
  };
}
