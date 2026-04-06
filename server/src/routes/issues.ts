import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import {
  addIssueCommentSchema,
  createIssueAttachmentMetadataSchema,
  createIssueWorkProductSchema,
  createIssueLabelSchema,
  checkoutIssueSchema,
  createIssueSchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  upsertIssueFeedbackVoteSchema,
  linkIssueApprovalSchema,
  issueDocumentKeySchema,
  restoreIssueDocumentRevisionSchema,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  updateIssueSchema,
} from "@paperclipai/shared";
import { trackAgentTaskCompleted } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  executionWorkspaceService,
  feedbackService,
  goalService,
  heartbeatService,
  instanceSettingsService,
  issueApprovalService,
  issueService,
  documentService,
  logActivity,
  projectService,
  routineService,
  workProductService,
} from "../services/index.js";
import { logger } from "../middleware/logger.js";
import { forbidden, HttpError, unauthorized } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { isDispatchableAgent } from "../utils/agent-dispatchability.js";
import { getTaskBoundScope, assertTaskBoundAccess } from "../utils/task-bound-scope.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;
const updateIssueRouteSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
});

export function issueRoutes(
  db: Db,
  storage: StorageService,
  opts?: {
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
  },
) {
  const router = Router();
  const svc = issueService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const feedback = feedbackService(db);
  const instanceSettings = instanceSettingsService(db);
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const routinesSvc = routineService(db);
  const feedbackExportService = opts?.feedbackExportService;

  async function incrementGateBlockCount(issueId: string) {
    try {
      await db.update(issues).set({
        gateBlockCount: sql`${issues.gateBlockCount} + 1`,
      }).where(eq(issues.id, issueId));
    } catch (err) {
      logger.error({ err, issueId }, "failed to increment gate block count");
    }
  }

  /**
   * Task-bound scope enforcement. Returns true if access is allowed,
   * false if blocked (response already sent). Board users always pass.
   */
  async function enforceTaskBoundScope(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string },
    httpStatus?: number,
  ): Promise<boolean> {
    const scope = await getTaskBoundScope(req, (runId) => heartbeat.getRun(runId));
    const block = assertTaskBoundAccess(scope, issue.id);
    if (!block) return true;
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.task_bound_scope_blocked",
      entityType: "issue",
      entityId: issue.id,
      details: {
        gate: block.gate,
        boundIssueId: scope.boundIssueId,
        endpoint: req.method + " " + (req.route?.path ?? req.path),
      },
    });
    res.status(httpStatus ?? 422).json({ error: block.reason, gate: block.gate });
    return false;
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `Invalid ${field} query value`);
    }
    return parsed;
  }

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function assertCanManageIssueApprovalLinks(req: Request, res: Response, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return true;
    if (!req.actor.agentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      res.status(403).json({ error: "Forbidden" });
      return false;
    }
    if (actorAgent.role === "ceo" || Boolean(actorAgent.permissions?.canCreateAgents)) return true;
    res.status(403).json({ error: "Missing permission to link approvals" });
    return false;
  }

  const C_SUITE_ROLES = new Set(["ceo", "cto", "cmo", "cfo"]);

  function canAssignTasksImplicitly(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    if (C_SUITE_ROLES.has(agent.role)) return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  function actorCanAccessCompany(req: Request, companyId: string) {
    if (req.actor.type === "none") return false;
    if (req.actor.type === "agent") return req.actor.companyId === companyId;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return (req.actor.companyIds ?? []).includes(companyId);
  }

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    if (agent.role === "ceo") return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanAssignTasks(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
      return;
    }
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const allowedByGrant = await access.hasPermission(companyId, "agent", req.actor.agentId, "tasks:assign");
      if (allowedByGrant) return;
      const actorAgent = await agentsSvc.getById(req.actor.agentId);
      if (actorAgent && actorAgent.companyId === companyId && canAssignTasksImplicitly(actorAgent)) return;
      throw forbidden("Missing permission: tasks:assign");
    }
    throw unauthorized();
  }

  // Agent status transition enforcement — agents follow a forward-only workflow.
  // Board actors bypass this entirely.
  const AGENT_ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
    backlog:     new Set(["todo", "in_progress", "cancelled"]),
    todo:        new Set(["in_progress", "backlog", "cancelled"]),
    in_progress: new Set(["in_review", "done", "blocked", "cancelled"]),
    in_review:   new Set(["in_progress", "done", "cancelled"]),
    blocked:     new Set(["in_progress", "todo", "cancelled"]),
    done:        new Set([]),
    cancelled:   new Set([]),
  };

  function assertAgentTransition(
    req: Request,
    fromStatus: string,
    toStatus: string,
  ): { gate: string; reason: string } | null {
    if (req.actor.type !== "agent") return null;
    if (fromStatus === toStatus) return null;

    const allowed = AGENT_ALLOWED_TRANSITIONS[fromStatus];
    if (allowed && !allowed.has(toStatus)) {
      return {
        gate: "invalid_agent_transition",
        reason: `Agents cannot move issues from '${fromStatus}' to '${toStatus}'. Terminal statuses (done, cancelled) cannot be changed by agents.`,
      };
    }
    return null;
  }

  const CODE_DELIVERY_TYPES = new Set(["branch", "commit", "pull_request"]);
  const PR_VALID_STATUSES = new Set(["active", "ready_for_review", "approved", "merged"]);

  // GitHub URL patterns for work product integrity verification
  const GH_PR_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;
  const GH_BRANCH_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[^/]+$/;
  const GH_COMMIT_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/commit\/[0-9a-f]+$/;

  async function assertDeliveryGate(
    workProducts: ReturnType<typeof workProductService>,
    req: Request,
    issue: { id: string; executionWorkspaceId: string | null },
    targetStatus: string,
  ): Promise<{ gate: string; reason: string } | null> {
    if (req.actor.type !== "agent") return null;
    if (!issue.executionWorkspaceId) return null;

    const products = await workProducts.listForIssue(issue.id);

    if (targetStatus === "in_review") {
      const hasCodeArtifact = products.some(wp => CODE_DELIVERY_TYPES.has(wp.type));
      if (!hasCodeArtifact) return {
        gate: "in_review_requires_artifact",
        reason: "Cannot move to in_review without a pushed branch, commit, or pull request.",
      };
    }

    if (targetStatus === "done") {
      const hasValidPR = products.some(
        wp => wp.type === "pull_request"
          && PR_VALID_STATUSES.has(wp.status)
          && wp.url
          && GH_PR_URL_PATTERN.test(wp.url),
      );
      if (!hasValidPR) return {
        gate: "done_requires_pr",
        reason: "Cannot mark done without a pull request that has a valid GitHub PR URL.",
      };
    }

    return null;
  }

  const QA_PASS_PATTERN = /\bqa[\s:]+pass(ed)?\b/i;

  async function assertQAGate(
    req: Request,
    issue: { id: string; executionWorkspaceId: string | null; assigneeAgentId: string | null },
    targetStatus: string,
    comments: Array<{ body: string; authorAgentId: string | null; authorUserId: string | null; createdAt: Date | string }>,
  ): Promise<{ gate: string; reason: string } | null> {
    if (req.actor.type !== "agent") return null;
    if (targetStatus !== "done") return null;

    const hasQAPass = comments.some(
      c =>
        (c.authorAgentId || c.authorUserId) &&
        c.authorAgentId !== issue.assigneeAgentId &&
        QA_PASS_PATTERN.test(c.body),
    );
    if (!hasQAPass) {
      return {
        gate: "done_requires_qa_pass",
        reason: "Cannot mark done without QA approval. A comment containing 'QA: PASS' from a different reviewer is required. The assigned agent cannot approve their own work.",
      };
    }
    return null;
  }

  // ---------- Browse evidence gates (v1 — interim regex control) ----------
  // This regex is a stopgap. It detects common browser testing command patterns
  // from the dogfood skill and AGENTS.md. It is gameable (canned text) and will
  // miss novel workflows. The v2 path is structured evidence tokens from browser-test CLI.
  const BROWSE_EVIDENCE_PATTERN =
    /\b(browser-test\s+(headless|headed)|browse\s+(goto|screenshot|snapshot|click)|dump-dom|--dump-dom|screenshot\s+saved|console\s+output|no\s+console\s+errors|DOM\s+(dump|snapshot|output))\b/i;

  /**
   * Check if an actor has posted browse evidence text in their comments on this issue.
   * Only considers comments created after `sinceDate` to scope evidence to the current review cycle.
   */
  function actorHasBrowseEvidence(
    comments: Array<{ body: string; authorAgentId: string | null; authorUserId: string | null; createdAt: Date | string }>,
    actorAgentId: string | null,
    actorUserId: string | null,
    sinceDate: Date | string,
  ): boolean {
    const since = new Date(sinceDate).getTime();
    return comments.some(c => {
      if (new Date(c.createdAt).getTime() < since) return false;
      const isActor =
        (actorAgentId && c.authorAgentId === actorAgentId) ||
        (actorUserId && c.authorUserId === actorUserId);
      return isActor && BROWSE_EVIDENCE_PATTERN.test(c.body);
    });
  }

  /**
   * Check if an actor has uploaded an image attachment to this issue.
   * Only considers attachments created after `sinceDate`.
   */
  function actorHasImageAttachment(
    attachments: Array<{ contentType: string | null; createdByAgentId: string | null; createdByUserId: string | null; createdAt: Date | string }>,
    actorAgentId: string | null,
    actorUserId: string | null,
    sinceDate: Date | string,
  ): boolean {
    const since = new Date(sinceDate).getTime();
    return attachments.some(a => {
      if (new Date(a.createdAt).getTime() < since) return false;
      const isActor =
        (actorAgentId && a.createdByAgentId === actorAgentId) ||
        (actorUserId && a.createdByUserId === actorUserId);
      return isActor && a.contentType?.startsWith("image/");
    });
  }

  /**
   * Engineer evidence gate: code issues moving to in_review must include
   * browser testing evidence (browse command text + image attachment)
   * from the transitioning agent.
   */
  async function assertEngineerBrowseEvidence(
    req: Request,
    issue: { id: string; executionWorkspaceId: string | null; updatedAt: Date | string },
    targetStatus: string,
    comments: Array<{ body: string; authorAgentId: string | null; authorUserId: string | null; createdAt: Date | string }>,
    attachments: Array<{ contentType: string | null; createdByAgentId: string | null; createdByUserId: string | null; createdAt: Date | string }>,
  ): Promise<{ gate: string; reason: string } | null> {
    if (req.actor.type !== "agent") return null;
    if (targetStatus !== "in_review") return null;
    if (!issue.executionWorkspaceId) return null;

    const agentId = req.actor.agentId ?? null;
    const sinceDate = issue.updatedAt;

    const hasBrowseText = actorHasBrowseEvidence(comments, agentId, null, sinceDate);
    const hasImage = actorHasImageAttachment(attachments, agentId, null, sinceDate);

    if (!hasBrowseText || !hasImage) {
      const missing: string[] = [];
      if (!hasBrowseText) missing.push("browser testing commands in a comment (e.g. 'browser-test headless <url>')");
      if (!hasImage) missing.push("an image attachment (screenshot)");
      return {
        gate: "in_review_requires_browse_evidence",
        reason: `Code issues require interactive browser testing evidence before moving to in_review. Missing: ${missing.join(" and ")}. Use the Browser Testing VPS (ssh -i $BROWSER_TEST_SSH_KEY ...) to test your changes, post the output as a comment, and attach a screenshot.`,
      };
    }

    return null;
  }

  /**
   * QA browse evidence gate: code issues moving to done must have browse
   * evidence from the same actor who posted QA: PASS.
   * Runs AFTER assertQAGate (which confirms QA: PASS exists).
   */
  async function assertQABrowseEvidence(
    req: Request,
    issue: { id: string; executionWorkspaceId: string | null; assigneeAgentId: string | null; updatedAt: Date | string },
    comments: Array<{ body: string; authorAgentId: string | null; authorUserId: string | null; createdAt: Date | string }>,
    attachments: Array<{ contentType: string | null; createdByAgentId: string | null; createdByUserId: string | null; createdAt: Date | string }>,
  ): Promise<{ gate: string; reason: string } | null> {
    if (req.actor.type !== "agent") return null;
    if (!issue.executionWorkspaceId) return null;

    // Find the QA PASS comment author (same logic as assertQAGate: non-assignee, authenticated)
    const qaPassComment = comments.find(
      c =>
        (c.authorAgentId || c.authorUserId) &&
        c.authorAgentId !== issue.assigneeAgentId &&
        QA_PASS_PATTERN.test(c.body),
    );
    if (!qaPassComment) return null; // assertQAGate should have caught this already

    const qaAgentId = qaPassComment.authorAgentId;
    const qaUserId = qaPassComment.authorUserId;
    const sinceDate = issue.updatedAt;

    const hasBrowseText = actorHasBrowseEvidence(comments, qaAgentId, qaUserId, sinceDate);
    const hasImage = actorHasImageAttachment(attachments, qaAgentId, qaUserId, sinceDate);

    if (!hasBrowseText || !hasImage) {
      const missing: string[] = [];
      if (!hasBrowseText) missing.push("browser testing commands");
      if (!hasImage) missing.push("screenshot attachment");
      return {
        gate: "done_requires_qa_browse_evidence",
        reason: `QA PASS without interactive testing evidence is insufficient for code issues. The QA reviewer must include ${missing.join(" and ")} in their review. Use the Browser Testing VPS to verify the fix interactively.`,
      };
    }

    return null;
  }

  // ---------- Assignment policy gate ----------
  // Control-plane roles bypass ownership and role-matrix restrictions.
  // They are still subject to target existence, company, and dispatchability checks.
  const CONTROL_PLANE_ROLES = new Set(["ceo", "cto"]);

  // Role handoff matrix: operational handoffs + management escalation.
  // Every non-control-plane role can escalate to CEO/CTO.
  // Same-role lateral handoffs are blocked separately below.
  const MANAGEMENT_ROLES = ["ceo", "cto"] as const;
  const ALLOWED_HANDOFFS: Record<string, readonly string[]> = {
    engineer: ["qa", "devops", ...MANAGEMENT_ROLES],
    devops: ["qa", "engineer", ...MANAGEMENT_ROLES],
    qa: ["engineer", "devops", ...MANAGEMENT_ROLES],
    pm: ["engineer", "devops", "qa", ...MANAGEMENT_ROLES],
    cmo: ["engineer", "devops", "qa", "pm", ...MANAGEMENT_ROLES],
    researcher: ["engineer", "qa", ...MANAGEMENT_ROLES],
    general: ["engineer", "qa", "devops", ...MANAGEMENT_ROLES],
  };

  // Lightweight status-role consistency: expected status for role handoff pairs.
  // Mismatches are logged but not blocked (the transition gate already prevents
  // truly illegal status moves).
  const EXPECTED_HANDOFF_STATUS: Record<string, string> = {
    "engineer->qa": "in_review",
    "devops->qa": "in_review",
    "qa->engineer": "in_progress",
    "qa->devops": "in_progress",
  };

  async function assertAgentAssignmentPolicy(
    req: Request,
    issue: { id: string; companyId: string; assigneeAgentId: string | null },
    targetAssigneeAgentId: string,
    targetStatus: string | undefined,
  ): Promise<{ gate: string; reason: string } | null> {
    // Board users bypass entirely
    if (req.actor.type !== "agent") return null;

    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) return { gate: "assignment_policy_error", reason: "Agent authentication required." };

    const [actorAgent, targetAgent] = await Promise.all([
      agentsSvc.getById(actorAgentId),
      agentsSvc.getById(targetAssigneeAgentId),
    ]);

    // Target must exist and belong to the same company
    if (!targetAgent || targetAgent.companyId !== issue.companyId) {
      return { gate: "assignment_target_not_found", reason: "Target agent not found in this company." };
    }

    const isControlPlane = actorAgent && CONTROL_PLANE_ROLES.has(actorAgent.role);

    // 1. Ownership check (control-plane bypasses)
    if (!isControlPlane) {
      const ownsIssue = issue.assigneeAgentId === actorAgentId;
      if (!ownsIssue) {
        return {
          gate: "assignment_ownership_required",
          reason: "Agents can only reassign issues they currently own. Control-plane roles (CEO, CTO) can reassign any issue.",
        };
      }
    }

    // 2. Dispatchability check (applies even to control-plane — don't assign to broken agents)
    if (!isDispatchableAgent(targetAgent)) {
      return {
        gate: "assignment_target_not_dispatchable",
        reason: `Cannot assign to agent '${targetAgent.name}' in '${targetAgent.status}' state. Target must be active, idle, or running.`,
      };
    }

    // 3. Role handoff matrix (control-plane bypasses)
    if (!isControlPlane && actorAgent) {
      const allowed = ALLOWED_HANDOFFS[actorAgent.role];
      if (!allowed || !allowed.includes(targetAgent.role)) {
        return {
          gate: "assignment_role_not_allowed",
          reason: `Role '${actorAgent.role}' cannot hand off to role '${targetAgent.role}'. Allowed targets: ${(allowed ?? []).join(", ") || "none (use control-plane actor)"}.`,
        };
      }
    }

    // 4. Status-role consistency advisory (server log only — not issue activity feed)
    if (actorAgent && targetStatus) {
      const handoffKey = `${actorAgent.role}->${targetAgent.role}`;
      const expectedStatus = EXPECTED_HANDOFF_STATUS[handoffKey];
      if (expectedStatus && targetStatus !== expectedStatus) {
        logger.warn(
          {
            issueId: issue.id,
            companyId: issue.companyId,
            handoff: handoffKey,
            expectedStatus,
            actualStatus: targetStatus,
            actorAgentId: actorAgent.id,
            targetAgentId: targetAgent.id,
          },
          "Assignment handoff status inconsistency (advisory — transition gate validates legality)",
        );
      }
    }

    return null;
  }

  function assertAgentCommentRequired(
    req: Request,
    existing: { status: string; assigneeAgentId: string | null; assigneeUserId: string | null },
    commentBody: string | undefined,
  ): { gate: string; reason: string } | null {
    if (req.actor.type !== "agent") return null;
    const statusChanging = req.body.status && req.body.status !== existing.status;
    const assigneeChanging =
      (req.body.assigneeAgentId !== undefined && req.body.assigneeAgentId !== existing.assigneeAgentId) ||
      (req.body.assigneeUserId !== undefined && req.body.assigneeUserId !== existing.assigneeUserId);
    if ((statusChanging || assigneeChanging) && !commentBody) {
      return { gate: "comment_required", reason: "Agents must include a comment when changing status or assignee." };
    }
    return null;
  }

  function requireAgentRunId(req: Request, res: Response) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (runId) return runId;
    res.status(401).json({ error: "Agent run id required" });
    return null;
  }

  async function assertAgentRunCheckoutOwnership(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (issue.status !== "in_progress" || issue.assigneeAgentId !== actorAgentId) {
      return true;
    }
    const runId = requireAgentRunId(req, res);
    if (!runId) return false;
    const ownership = await svc.assertCheckoutOwner(issue.id, actorAgentId, runId);
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.checkout_lock_adopted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          previousCheckoutRunId: ownership.adoptedFromRunId,
          checkoutRunId: runId,
          reason: "stale_checkout_run",
        },
      });
    }
    return true;
  }

  async function resolveActiveIssueRun(issue: {
    id: string;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  }) {
    let runToInterrupt = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;

    if ((!runToInterrupt || runToInterrupt.status !== "running") && issue.assigneeAgentId) {
      const activeRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
      const activeIssueId =
        activeRun &&
        activeRun.contextSnapshot &&
        typeof activeRun.contextSnapshot === "object" &&
        typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
          ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
          : null;
      if (activeRun && activeRun.status === "running" && activeIssueId === issue.id) {
        runToInterrupt = activeRun;
      }
    }

    return runToInterrupt?.status === "running" ? runToInterrupt : null;
  }

  async function normalizeIssueIdentifier(rawId: string): Promise<string> {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      const issue = await svc.getByIdentifier(rawId);
      if (issue) {
        return issue.id;
      }
    }
    return rawId;
  }

  async function resolveIssueProjectAndGoal(issue: {
    companyId: string;
    projectId: string | null;
    goalId: string | null;
  }) {
    const projectPromise = issue.projectId ? projectsSvc.getById(issue.projectId) : Promise.resolve(null);
    const directGoalPromise = issue.goalId ? goalsSvc.getById(issue.goalId) : Promise.resolve(null);
    const [project, directGoal] = await Promise.all([projectPromise, directGoalPromise]);

    if (directGoal) {
      return { project, goal: directGoal };
    }

    const projectGoalId = project?.goalId ?? project?.goalIds[0] ?? null;
    if (projectGoalId) {
      const projectGoal = await goalsSvc.getById(projectGoalId);
      return { project, goal: projectGoal };
    }

    if (!issue.projectId) {
      const defaultGoal = await goalsSvc.getDefaultCompanyGoal(issue.companyId);
      return { project, goal: defaultGoal };
    }

    return { project, goal: null };
  }

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/companies/:companyId/issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const assigneeUserFilterRaw = req.query.assigneeUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const inboxArchivedByUserFilterRaw = req.query.inboxArchivedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const assigneeUserId =
      assigneeUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : assigneeUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : touchedByUserFilterRaw;
    const inboxArchivedByUserId =
      inboxArchivedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : inboxArchivedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : unreadForUserFilterRaw;

    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "assigneeUserId=me requires board authentication" });
      return;
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "touchedByUserId=me requires board authentication" });
      return;
    }
    if (inboxArchivedByUserFilterRaw === "me" && (!inboxArchivedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "inboxArchivedByUserId=me requires board authentication" });
      return;
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "unreadForUserId=me requires board authentication" });
      return;
    }

    // Task-bound scope: short-circuit to avoid full DB query
    const scope = await getTaskBoundScope(req, (runId) => heartbeat.getRun(runId));
    if (scope.isTaskBound) {
      if (!scope.boundIssueId) {
        res.json([]);
        return;
      }
      const issue = await svc.getById(scope.boundIssueId);
      if (issue && issue.companyId === companyId) {
        res.json([issue]);
      } else {
        res.json([]);
      }
      return;
    }

    const result = await svc.list(companyId, {
      status: req.query.status as string | undefined,
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      assigneeUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId: req.query.projectId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
      parentId: req.query.parentId as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      q: req.query.q as string | undefined,
    });

    res.json(result);
  });

  router.get("/companies/:companyId/labels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listLabels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/labels", validate(createIssueLabelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const label = await svc.createLabel(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    const labelId = req.params.labelId as string;
    const existing = await svc.getLabelById(labelId);
    if (!existing) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue, 403))) return;
    const [{ project, goal }, ancestors, mentionedProjectIds, documentPayload] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.findMentionedProjectIds(issue.id),
      documentsSvc.getIssueDocumentPayload(issue),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = issue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json({
      ...issue,
      goalId: goal?.id ?? issue.goalId,
      ancestors,
      ...documentPayload,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace,
      workProducts,
    });
  });

  router.get("/issues/:id/heartbeat-context", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue, 403))) return;

    const wakeCommentId =
      typeof req.query.wakeCommentId === "string" && req.query.wakeCommentId.trim().length > 0
        ? req.query.wakeCommentId.trim()
        : null;

    const [{ project, goal }, ancestors, commentCursor, wakeComment] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.getCommentCursor(issue.id),
      wakeCommentId ? svc.getComment(wakeCommentId) : null,
    ]);

    res.json({
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: goal?.id ?? issue.goalId,
        parentId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        updatedAt: issue.updatedAt,
      },
      ancestors: ancestors.map((ancestor) => ({
        id: ancestor.id,
        identifier: ancestor.identifier,
        title: ancestor.title,
        status: ancestor.status,
        priority: ancestor.priority,
      })),
      project: project
        ? {
            id: project.id,
            name: project.name,
            status: project.status,
            targetDate: project.targetDate,
          }
        : null,
      goal: goal
        ? {
            id: goal.id,
            title: goal.title,
            status: goal.status,
            level: goal.level,
            parentId: goal.parentId,
          }
        : null,
      commentCursor,
      wakeComment:
        wakeComment && wakeComment.issueId === issue.id
          ? wakeComment
          : null,
    });
  });

  router.get("/issues/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue, 403))) return;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json(workProducts);
  });

  router.get("/issues/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue, 403))) return;
    const docs = await documentsSvc.listIssueDocuments(issue.id);
    res.json(docs);
  });

  router.get("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const doc = await documentsSvc.getIssueDocumentByKey(issue.id, keyParsed.data);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  });

  router.put("/issues/:id/documents/:key", validate(upsertIssueDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const result = await documentsSvc.upsertIssueDocument({
      issueId: issue.id,
      key: keyParsed.data,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId ?? null,
    });
    const doc = result.document;

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "issue.document_created" : "issue.document_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
      },
    });

    res.status(result.created ? 201 : 200).json(doc);
  });

  router.get("/issues/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue, 403))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const revisions = await documentsSvc.listIssueDocumentRevisions(issue.id, keyParsed.data);
    res.json(revisions);
  });

  router.post(
    "/issues/:id/documents/:key/revisions/:revisionId/restore",
    validate(restoreIssueDocumentRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const revisionId = req.params.revisionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      if (!(await enforceTaskBoundScope(req, res, issue))) return;
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }

      const actor = getActorInfo(req);
      const result = await documentsSvc.restoreIssueDocumentRevision({
        issueId: issue.id,
        key: keyParsed.data,
        revisionId,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.document_restored",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          format: result.document.format,
          revisionNumber: result.document.latestRevisionNumber,
          restoredFromRevisionId: result.restoredFromRevisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
        },
      });

      res.json(result.document);
    },
  );

  router.delete("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue))) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const removed = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.document_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
      },
    });
    res.json({ ok: true });
  });

  router.post("/issues/:id/work-products", validate(createIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue))) return;

    // Agents must provide valid GitHub URLs for code delivery work products
    if (req.actor.type === "agent") {
      const { type, url, externalId } = req.body;
      if (type === "pull_request") {
        if (!url || !GH_PR_URL_PATTERN.test(url)) {
          res.status(422).json({
            error: "Pull request work products require a valid GitHub PR URL (https://github.com/{owner}/{repo}/pull/{number}).",
            gate: "invalid_work_product_url",
          });
          return;
        }
        if (!externalId) {
          res.status(422).json({
            error: "Pull request work products require an externalId (the PR number).",
            gate: "invalid_work_product_url",
          });
          return;
        }
      }
      if (type === "branch" && url && !GH_BRANCH_URL_PATTERN.test(url)) {
        res.status(422).json({
          error: "Branch work products must use a valid GitHub branch URL (https://github.com/{owner}/{repo}/tree/{branch}).",
          gate: "invalid_work_product_url",
        });
        return;
      }
      if (type === "commit" && url && !GH_COMMIT_URL_PATTERN.test(url)) {
        res.status(422).json({
          error: "Commit work products must use a valid GitHub commit URL (https://github.com/{owner}/{repo}/commit/{sha}).",
          gate: "invalid_work_product_url",
        });
        return;
      }
    }

    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, {
      ...req.body,
      projectId: req.body.projectId ?? issue.projectId ?? null,
    });
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_created",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    res.status(201).json(product);
  });

  router.patch("/work-products/:id", validate(updateIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await enforceTaskBoundScope(req, res, { id: existing.issueId, companyId: existing.companyId }))) return;
    const product = await workProductsSvc.update(id, req.body);
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_updated",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, changedKeys: Object.keys(req.body).sort() },
    });
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await enforceTaskBoundScope(req, res, { id: existing.issueId, companyId: existing.companyId }))) return;
    const removed = await workProductsSvc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_deleted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: removed.id, type: removed.type },
    });
    res.json(removed);
  });

  router.post("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.delete("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.markUnread(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_unmarked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json({ id: issue.id, removed });
  });

  router.post("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const archiveState = await svc.archiveInbox(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_archived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, archivedAt: archiveState.archivedAt },
    });
    res.json(archiveState);
  });

  router.delete("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.unarchiveInbox(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_unarchived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json(removed ?? { ok: true });
  });

  router.get("/issues/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.json(approvals);
  });

  router.post("/issues/:id/approvals", validate(linkIssueApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    const actor = getActorInfo(req);
    await issueApprovalsSvc.link(id, req.body.approvalId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_linked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId: req.body.approvalId },
    });

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.status(201).json(approvals);
  });

  router.delete("/issues/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    await issueApprovalsSvc.unlink(id, approvalId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/issues", validate(createIssueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, companyId);
    }

    const actor = getActorInfo(req);

    // Agent issue creation rate limit
    if (actor.actorType === "agent" && actor.agentId) {
      const recentCount = await svc.countRecentByAgent(actor.agentId);
      const rateLimit = parseInt(process.env.AGENT_ISSUE_CREATION_RATE_LIMIT ?? "50", 10);
      if (recentCount >= rateLimit) {
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.creation_rate_limited",
          entityType: "issue",
          entityId: actor.agentId,
          details: { count: recentCount, limit: rateLimit, window: "1h" },
        });
        res.status(429).json({
          error: "rate_limited",
          gate: "issue_creation_rate_limit",
          message: `Agent created ${recentCount} issues in the last hour (limit: ${rateLimit})`,
        });
        return;
      }
    }

    let issue;
    try {
      issue = await svc.create(companyId, {
        ...req.body,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: { title: issue.title, identifier: issue.identifier },
    });

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    res.status(201).json(issue);
  });

  router.patch("/issues/:id", validate(updateIssueRouteSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await enforceTaskBoundScope(req, res, existing))) return;

    // Auto-assign from @mention: when an agent transitions to in_review without setting
    // assigneeAgentId, infer the assignment from @mentions in the PATCH comment or
    // recent comments (within 2 minutes). This prevents the common pattern where agents
    // @mention a QA agent in a separate comment but forget to include assigneeAgentId
    // in the status-change PATCH, leaving the issue assigned to themselves.
    if (
      req.actor.type === "agent" &&
      req.body.status === "in_review" &&
      req.body.assigneeAgentId === undefined
    ) {
      try {
        let targetId: string | undefined;

        // First: check the inline PATCH comment for @mentions
        if (req.body.comment) {
          const mentionedIds = await svc.findMentionedAgents(existing.companyId, req.body.comment);
          targetId = mentionedIds.find((mid) => mid !== req.actor.agentId);
        }

        // Second: if no mention found in the PATCH comment, check recent comments
        // on this issue (last 2 minutes) for @mentions — covers the split-call pattern
        // where the agent posts the @mention in a separate comment before the status change.
        if (!targetId) {
          const recentComments = await svc.listComments(existing.id, { order: "desc", limit: 5 });
          const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
          for (const comment of recentComments) {
            const commentTime = new Date(comment.createdAt).getTime();
            if (commentTime < twoMinutesAgo) break;
            const mentionedIds = await svc.findMentionedAgents(existing.companyId, comment.body);
            targetId = mentionedIds.find((mid) => mid !== req.actor.agentId);
            if (targetId) break;
          }
        }

        if (targetId) {
          req.body.assigneeAgentId = targetId;
          logger.info(
            { issueId: id, mentionedAgentId: targetId, actorAgentId: req.actor.agentId },
            "auto-inferred assigneeAgentId from @mention in in_review transition",
          );
        }
      } catch (err) {
        logger.warn({ err, issueId: id }, "failed to resolve @mentions for auto-assign inference");
      }
    }

    // Review handoff gate: agents transitioning to in_review MUST hand off to a different
    // assignee. If auto-infer didn't find a mention and the agent didn't set assigneeAgentId,
    // the issue would stay assigned to the transitioning agent — which stalls the pipeline.
    // Also allow if assigneeUserId is set (handoff to a board user, e.g. CEO routing to board).
    if (
      req.actor.type === "agent" &&
      req.body.status === "in_review" &&
      existing.status !== "in_review" &&
      req.body.assigneeAgentId === undefined &&
      req.body.assigneeUserId === undefined &&
      existing.assigneeAgentId === req.actor.agentId
    ) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.review_handoff_blocked",
        entityType: "issue",
        entityId: existing.id,
        details: {
          gate: "review_handoff_required",
          reason: "Transitioning to in_review requires assigning to a different agent (e.g. QA). Set assigneeAgentId or @mention the reviewer in your comment.",
          currentAssigneeAgentId: existing.assigneeAgentId,
        },
      });
      await incrementGateBlockCount(existing.id);
      res.status(422).json({
        error: "Transitioning to in_review requires assigning to a different agent (e.g. QA). Set assigneeAgentId or @mention the reviewer in your comment.",
        gate: "review_handoff_required",
      });
      return;
    }

    const assigneeWillChange =
      (req.body.assigneeAgentId !== undefined && req.body.assigneeAgentId !== existing.assigneeAgentId) ||
      (req.body.assigneeUserId !== undefined && req.body.assigneeUserId !== existing.assigneeUserId);

    const isAgentReturningIssueToCreator =
      req.actor.type === "agent" &&
      !!req.actor.agentId &&
      existing.assigneeAgentId === req.actor.agentId &&
      req.body.assigneeAgentId === null &&
      typeof req.body.assigneeUserId === "string" &&
      !!existing.createdByUserId &&
      req.body.assigneeUserId === existing.createdByUserId;

    if (assigneeWillChange) {
      if (!isAgentReturningIssueToCreator) {
        // Coarse permission check: is this actor allowed to attempt assignment at all?
        await assertCanAssignTasks(req, existing.companyId);

        // Contextual policy gate: is this specific assignment permitted?
        if (typeof req.body.assigneeAgentId === "string") {
          const policyResult = await assertAgentAssignmentPolicy(
            req,
            existing,
            req.body.assigneeAgentId,
            req.body.status,
          );
          if (policyResult) {
            const actor = getActorInfo(req);
            await logActivity(db, {
              companyId: existing.companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "issue.assignment_policy_blocked",
              entityType: "issue",
              entityId: existing.id,
              details: {
                gate: policyResult.gate,
                reason: policyResult.reason,
                targetAssigneeAgentId: req.body.assigneeAgentId,
                currentAssigneeAgentId: existing.assigneeAgentId,
                targetStatus: req.body.status ?? existing.status,
              },
            });
            await incrementGateBlockCount(existing.id);
            res.status(422).json({ error: policyResult.reason, gate: policyResult.gate });
            return;
          }
        }
      }
    }
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;

    // Status transition gates (agent-only — board always bypasses)
    if (req.body.status && req.body.status !== existing.status) {
      // Transition graph: agents follow forward-only workflow
      const transitionResult = assertAgentTransition(req, existing.status, req.body.status);
      if (transitionResult) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.transition_blocked",
          entityType: "issue",
          entityId: existing.id,
          details: { gate: transitionResult.gate, reason: transitionResult.reason, fromStatus: existing.status, targetStatus: req.body.status },
        });
        await incrementGateBlockCount(existing.id);
        res.status(422).json({ error: transitionResult.reason, gate: transitionResult.gate });
        return;
      }

      // Delivery gate: agents must push code before transitioning code issues
      const gateResult = await assertDeliveryGate(workProductsSvc, req, existing, req.body.status);
      if (gateResult) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.delivery_gate_blocked",
          entityType: "issue",
          entityId: existing.id,
          details: { gate: gateResult.gate, reason: gateResult.reason, targetStatus: req.body.status },
        });
        await incrementGateBlockCount(existing.id);
        res.status(422).json({ error: gateResult.reason, gate: gateResult.gate });
        return;
      }

      // Fetch comments + attachments once for evidence and QA gates (only on transitions that need them)
      const needsEvidenceOrQA = req.body.status === "in_review" || req.body.status === "done";
      const allComments = needsEvidenceOrQA ? await svc.listComments(existing.id, { order: "asc" }) : [];
      const allAttachments = needsEvidenceOrQA ? await svc.listAttachments(existing.id) : [];

      // Engineer evidence gate: browse evidence + screenshot for in_review (code issues)
      const evidenceResult = await assertEngineerBrowseEvidence(req, existing, req.body.status, allComments, allAttachments);
      if (evidenceResult) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.evidence_gate_blocked",
          entityType: "issue",
          entityId: existing.id,
          details: { gate: evidenceResult.gate, reason: evidenceResult.reason, targetStatus: req.body.status },
        });
        await incrementGateBlockCount(existing.id);
        res.status(422).json({ error: evidenceResult.reason, gate: evidenceResult.gate });
        return;
      }

      // QA gate: agents must have QA approval before marking code issues done
      const qaGateResult = await assertQAGate(req, existing, req.body.status, allComments);
      if (qaGateResult) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.qa_gate_blocked",
          entityType: "issue",
          entityId: existing.id,
          details: { gate: qaGateResult.gate, reason: qaGateResult.reason, targetStatus: req.body.status },
        });
        await incrementGateBlockCount(existing.id);
        res.status(422).json({ error: qaGateResult.reason, gate: qaGateResult.gate });
        return;
      }

      // QA browse evidence gate: QA reviewer must include testing evidence (code issues, done only)
      if (req.body.status === "done") {
        const qaBrowseResult = await assertQABrowseEvidence(req, existing, allComments, allAttachments);
        if (qaBrowseResult) {
          const actor = getActorInfo(req);
          await logActivity(db, {
            companyId: existing.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.qa_evidence_gate_blocked",
            entityType: "issue",
            entityId: existing.id,
            details: { gate: qaBrowseResult.gate, reason: qaBrowseResult.reason, targetStatus: req.body.status },
          });
          await incrementGateBlockCount(existing.id);
          res.status(422).json({ error: qaBrowseResult.reason, gate: qaBrowseResult.gate });
          return;
        }
      }
    }

    const actor = getActorInfo(req);
    const isClosed = existing.status === "done" || existing.status === "cancelled";
    const {
      comment: commentBody,
      reopen: reopenRequested,
      interrupt: interruptRequested,
      hiddenAt: hiddenAtRaw,
      ...updateFields
    } = req.body;
    let interruptedRunId: string | null = null;

    if (interruptRequested) {
      if (!commentBody) {
        res.status(400).json({ error: "Interrupt is only supported when posting a comment" });
        return;
      }
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      const runToInterrupt = await resolveActiveIssueRun(existing);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: existing.id },
          });
        }
      }
    }

    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw) : null;
    }

    // Short-circuit no-op updates: if nothing is actually changing, return early.
    // This prevents agents (especially CEO) from spamming redundant reassignments
    // that pollute the activity log and trigger unnecessary wakeups.
    if (!commentBody && !reopenRequested) {
      const isNoop = Object.keys(updateFields).every((key) => {
        if (!(key in existing)) return false;
        return (existing as Record<string, unknown>)[key] === (updateFields as Record<string, unknown>)[key];
      });
      if (isNoop) {
        res.json(existing);
        return;
      }
    }

    if (commentBody && reopenRequested === true && isClosed && updateFields.status === undefined) {
      if (req.actor.type === "agent") {
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.transition_blocked",
          entityType: "issue",
          entityId: existing.id,
          details: { gate: "invalid_agent_transition", reason: "Agents cannot reopen terminal issues.", fromStatus: existing.status, targetStatus: "todo" },
        });
        res.status(422).json({ error: "Agents cannot reopen terminal issues. Only board users can reopen done or cancelled issues.", gate: "invalid_agent_transition" });
        return;
      }
      updateFields.status = "todo";
    }

    // Comment-required gate: agents must explain status/assignee changes
    const commentGateResult = assertAgentCommentRequired(req, existing, commentBody);
    if (commentGateResult) {
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_required_blocked",
        entityType: "issue",
        entityId: existing.id,
        details: {
          gate: commentGateResult.gate,
          reason: commentGateResult.reason,
          targetStatus: req.body.status ?? existing.status,
          targetAssigneeAgentId: req.body.assigneeAgentId,
          targetAssigneeUserId: req.body.assigneeUserId,
        },
      });
      await incrementGateBlockCount(existing.id);
      res.status(422).json({ error: commentGateResult.reason, gate: commentGateResult.gate });
      return;
    }

    // Reset counters when assignee changes so the new assignee gets a fresh
    // SLA window and gate-block budget.
    if (assigneeWillChange) {
      (updateFields as Record<string, unknown>).activationRetriggerCount = 0;
      (updateFields as Record<string, unknown>).gateBlockCount = 0;
    }

    // Reset gate-block counter on any status change — the issue has progressed.
    if (req.body.status && req.body.status !== existing.status) {
      (updateFields as Record<string, unknown>).gateBlockCount = 0;
    }

    let issue;
    try {
      issue = await svc.update(id, updateFields);
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn(
          {
            issueId: id,
            companyId: existing.companyId,
            assigneePatch: {
              assigneeAgentId:
                req.body.assigneeAgentId === undefined ? "__omitted__" : req.body.assigneeAgentId,
              assigneeUserId:
                req.body.assigneeUserId === undefined ? "__omitted__" : req.body.assigneeUserId,
            },
            currentAssignee: {
              assigneeAgentId: existing.assigneeAgentId,
              assigneeUserId: existing.assigneeUserId,
            },
            error: err.message,
            details: err.details,
          },
          "issue update rejected with 422",
        );
      }
      throw err;
    }
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await routinesSvc.syncRunStatusForIssue(issue.id);

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue activity"));
    }

    // Build activity details with previous values for changed fields
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(updateFields)) {
      if (key in existing && (existing as Record<string, unknown>)[key] !== (updateFields as Record<string, unknown>)[key]) {
        previous[key] = (existing as Record<string, unknown>)[key];
      }
    }

    const hasFieldChanges = Object.keys(previous).length > 0;
    const reopened =
      commentBody &&
      reopenRequested === true &&
      isClosed &&
      previous.status !== undefined &&
      issue.status === "todo";
    const reopenFromStatus = reopened ? existing.status : null;
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        ...updateFields,
        identifier: issue.identifier,
        ...(commentBody ? { source: "comment" } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        _previous: hasFieldChanges ? previous : undefined,
      },
    });

    if (issue.status === "done" && existing.status !== "done") {
      const tc = getTelemetryClient();
      if (tc && actor.agentId) {
        const actorAgent = await agentsSvc.getById(actor.agentId);
        if (actorAgent) {
          trackAgentTaskCompleted(tc, { agentRole: actorAgent.role });
        }
      }
    }

    let comment = null;
    if (commentBody) {
      comment = await svc.addComment(id, commentBody, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
          ...(hasFieldChanges ? { updated: true } : {}),
        },
      });

    }

    const assigneeChanged = assigneeWillChange;
    const statusChangedFromBacklog =
      existing.status === "backlog" &&
      issue.status !== "backlog" &&
      req.body.status !== undefined;

    // Merge all wakeups from this update into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();

      if (assigneeChanged && issue.assigneeAgentId && issue.status !== "backlog") {
        wakeups.set(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: {
            issueId: issue.id,
            mutation: "update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: "issue.update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (!assigneeChanged && statusChangedFromBacklog && issue.assigneeAgentId) {
        wakeups.set(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_status_changed",
          payload: {
            issueId: issue.id,
            mutation: "update",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: "issue.status_change",
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      // Same-assignee re-trigger: when a comment is posted on an issue that
      // already has an assignee but the assignee didn't change, fire a
      // task-specific wakeup so the agent wakes with paperclipTaskId set.
      // This handles the "CEO re-triggers SCCE via comment" pattern.
      const isTerminal = issue.status === "done" || issue.status === "cancelled";
      if (
        commentBody &&
        comment &&
        !assigneeChanged &&
        issue.assigneeAgentId &&
        issue.status !== "backlog" &&
        !isTerminal &&
        !wakeups.has(issue.assigneeAgentId) &&
        // Don't self-wake: if the commenting agent IS the assignee, skip
        !(actor.actorType === "agent" && actor.actorId === issue.assigneeAgentId)
      ) {
        wakeups.set(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_retrigger",
          payload: { issueId: issue.id, commentId: comment.id },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "issue_comment_retrigger",
            source: "comment.retrigger",
          },
        });
      }

      if (commentBody && comment) {
        let mentionedIds: string[] = [];
        try {
          mentionedIds = await svc.findMentionedAgents(issue.companyId, commentBody);
        } catch (err) {
          logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
        }

        for (const mentionedId of mentionedIds) {
          if (wakeups.has(mentionedId)) continue;
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          wakeups.set(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_mentioned",
              source: "comment.mention",
            },
          });
        }
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }
    })();

    res.json({ ...issue, comment });
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await enforceTaskBoundScope(req, res, existing))) return;
    const attachments = await svc.listAttachments(id);

    const issue = await svc.remove(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(attachment.companyId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    res.json(issue);
  });

  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue))) return;

    if (issue.projectId) {
      const project = await projectsSvc.getById(issue.projectId);
      if (project?.pausedAt) {
        res.status(409).json({
          error:
            project.pauseReason === "budget"
              ? "Project is paused because its budget hard-stop was reached"
              : "Project is paused",
        });
        return;
      }
    }

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only checkout as itself" });
      return;
    }

    const checkoutRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !checkoutRunId) return;
    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issue.id,
      details: { agentId: req.body.agentId },
    });

    if (
      shouldWakeAssigneeOnCheckout({
        actorType: req.actor.type,
        actorAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        checkoutAgentId: req.body.agentId,
        checkoutRunId,
      })
    ) {
      void heartbeat
        .wakeup(req.body.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_checked_out",
          payload: { issueId: issue.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.checkout" },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }

    res.json(updated);
  });

  router.post("/issues/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;
    const actorRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !actorRunId) return;

    const released = await svc.release(
      id,
      req.actor.type === "agent" ? req.actor.agentId : undefined,
      actorRunId,
    );
    if (!released) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: released.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
    });

    res.json(released);
  });

  router.get("/issues/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue, 403))) return;
    const afterCommentId =
      typeof req.query.after === "string" && req.query.after.trim().length > 0
        ? req.query.after.trim()
        : typeof req.query.afterCommentId === "string" && req.query.afterCommentId.trim().length > 0
          ? req.query.afterCommentId.trim()
          : null;
    const order =
      typeof req.query.order === "string" && req.query.order.trim().toLowerCase() === "asc"
        ? "asc"
        : "desc";
    const limitRaw =
      typeof req.query.limit === "string" && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : null;
    const limit =
      limitRaw && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_ISSUE_COMMENT_LIMIT)
        : null;
    const comments = await svc.listComments(id, {
      afterCommentId,
      order,
      limit,
    });
    res.json(comments);
  });

  router.get("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue, 403))) return;
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.get("/issues/:id/feedback-votes", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback votes" });
      return;
    }

    const votes = await feedback.listIssueVotesForUser(id, req.actor.userId ?? "local-board");
    res.json(votes);
  });

  router.get("/issues/:id/feedback-traces", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const targetType = targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined;
    const vote = voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined;
    const status = statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId: issue.companyId,
      issueId: issue.id,
      targetType,
      vote,
      status,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.get("/feedback-traces/:traceId", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }
    const includePayload = parseBooleanQuery(req.query.includePayload) || req.query.includePayload === undefined;
    const trace = await feedback.getFeedbackTraceById(traceId, includePayload);
    if (!trace || !actorCanAccessCompany(req, trace.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(trace);
  });

  router.get("/feedback-traces/:traceId/bundle", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback trace bundles" });
      return;
    }
    const bundle = await feedback.getFeedbackTraceBundle(traceId);
    if (!bundle || !actorCanAccessCompany(req, bundle.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(bundle);
  });

  router.post("/issues/:id/comments", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue))) return;
    if (!(await assertAgentRunCheckoutOwnership(req, res, issue))) return;

    const actor = getActorInfo(req);

    const reopenRequested = req.body.reopen === true;
    const interruptRequested = req.body.interrupt === true;
    const isClosed = issue.status === "done" || issue.status === "cancelled";
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue = issue;

    if (reopenRequested && isClosed) {
      if (req.actor.type === "agent") {
        res.status(422).json({ error: "Agents cannot reopen terminal issues. Only board users can reopen done or cancelled issues.", gate: "invalid_agent_transition" });
        return;
      }
      const reopenedIssue = await svc.update(id, { status: "todo" });
      if (!reopenedIssue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      reopened = true;
      reopenFromStatus = issue.status;
      currentIssue = reopenedIssue;

      await logActivity(db, {
        companyId: currentIssue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: currentIssue.id,
        details: {
          status: "todo",
          reopened: true,
          reopenedFrom: reopenFromStatus,
          source: "comment",
          identifier: currentIssue.identifier,
        },
      });
    }

    if (interruptRequested) {
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      const runToInterrupt = await resolveActiveIssueRun(currentIssue);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: currentIssue.id },
          });
        }
      }
    }

    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
      runId: actor.runId,
    });

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue comment"));
    }

    await logActivity(db, {
      companyId: currentIssue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
      },
    });

    // Merge all wakeups from this comment into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();
      const assigneeId = currentIssue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      const skipWake = selfComment || isClosed;
      if (assigneeId && (reopened || !skipWake)) {
        if (reopened) {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_reopened_via_comment",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              reopenedFrom: reopenFromStatus,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              source: "issue.comment.reopen",
              wakeReason: "issue_reopened_via_comment",
              reopenedFrom: reopenFromStatus,
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              source: "issue.comment",
              wakeReason: "issue_commented",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }
      }

      let mentionedIds: string[] = [];
      try {
        mentionedIds = await svc.findMentionedAgents(issue.companyId, req.body.body);
      } catch (err) {
        logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
      }

      for (const mentionedId of mentionedIds) {
        if (wakeups.has(mentionedId)) continue;
        if (actorIsAgent && actor.actorId === mentionedId) continue;
        wakeups.set(mentionedId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_mentioned",
          payload: { issueId: id, commentId: comment.id },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: id,
            taskId: id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "issue_comment_mentioned",
            source: "comment.mention",
          },
        });
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: currentIssue.id, agentId }, "failed to wake agent on issue comment"));
      }
    })();

    res.status(201).json(comment);
  });

  router.post("/issues/:id/feedback-votes", validate(upsertIssueFeedbackVoteSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can vote on AI feedback" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await feedback.saveIssueVote({
      issueId: id,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      vote: req.body.vote,
      reason: req.body.reason,
      authorUserId: req.actor.userId ?? "local-board",
      allowSharing: req.body.allowSharing === true,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.feedback_vote_saved",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        targetType: result.vote.targetType,
        targetId: result.vote.targetId,
        vote: result.vote.vote,
        hasReason: Boolean(result.vote.reason),
        sharingEnabled: result.sharingEnabled,
      },
    });

    if (result.consentEnabledNow) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.feedback_data_sharing_updated",
        entityType: "company",
        entityId: issue.companyId,
        details: {
          feedbackDataSharingEnabled: true,
          source: "issue_feedback_vote",
        },
      });
    }

    if (result.persistedSharingPreference) {
      const settings = await instanceSettings.get();
      const companyIds = await instanceSettings.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: settings.id,
            details: {
              general: settings.general,
              changedKeys: ["feedbackDataSharingPreference"],
              source: "issue_feedback_vote",
            },
          }),
        ),
      );
    }

    if (result.sharingEnabled && result.traceId && feedbackExportService) {
      try {
        await feedbackExportService.flushPendingFeedbackTraces({
          companyId: issue.companyId,
          traceId: result.traceId,
          limit: 1,
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id, traceId: result.traceId }, "failed to flush shared feedback trace immediately");
      }
    }

    res.status(201).json(result.vote);
  });

  router.get("/issues/:id/attachments", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await enforceTaskBoundScope(req, res, issue, 403))) return;
    const attachments = await svc.listAttachments(issueId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/companies/:companyId/issues/:issueId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await enforceTaskBoundScope(req, res, issue))) return;
    if (issue.companyId !== companyId) {
      res.status(422).json({ error: "Issue does not belong to company" });
      return;
    }

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = (file.mimetype || "").toLowerCase();
    if (!isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported attachment type: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      issueId,
      issueCommentId: parsedMeta.data.issueCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_added",
      entityType: "issue",
      entityId: issueId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);
    if (!(await enforceTaskBoundScope(req, res, { id: attachment.issueId, companyId: attachment.companyId }, 403))) return;

    const object = await storage.getObject(attachment.companyId, attachment.objectKey);
    res.setHeader("Content-Type", attachment.contentType || object.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    const filename = attachment.originalFilename ?? "attachment";
    res.setHeader("Content-Disposition", `inline; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);
    if (!(await enforceTaskBoundScope(req, res, { id: attachment.issueId, companyId: attachment.companyId }))) return;

    try {
      await storage.deleteObject(attachment.companyId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_removed",
      entityType: "issue",
      entityId: removed.issueId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
