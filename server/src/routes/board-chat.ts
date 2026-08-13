import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { instanceSettingsService, issueService } from "../services/index.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";

const BOARD_CHAT_ORIGIN_KIND = "board_chat";
const LEGACY_BOARD_CHAT_TITLE = "Board Operations";
const LEGACY_BOARD_CHAT_DESCRIPTION = "Standing issue for board concierge conversations and decision log";
const BOARD_CHAT_DESCRIPTION = "Standing issue for Conference Room conversations and decision log";
const BOARD_CHAT_UNAVAILABLE_REASONS = {
  NOT_FOUND: "not_found",
  WRONG_COMPANY: "wrong_company",
  WRONG_KIND: "wrong_kind",
  CANCELLED: "cancelled",
} as const;

function deriveBoardChatIssueTitle(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (!singleLine) return "New chat";
  if (singleLine.length <= 80) return singleLine;
  return `${singleLine.slice(0, 77).trimEnd()}...`;
}

function isAvailableBoardChatIssue(issue: { status?: string | null }) {
  return issue.status !== "cancelled";
}

function isLegacyBoardChatIssue(issue: {
  title?: string | null;
  description?: string | null;
  originKind?: string | null;
  status?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
}) {
  return (
    issue.title === LEGACY_BOARD_CHAT_TITLE &&
    issue.description === LEGACY_BOARD_CHAT_DESCRIPTION &&
    (issue.originKind === undefined || issue.originKind === null || issue.originKind === "manual") &&
    issue.assigneeAgentId === null &&
    issue.assigneeUserId === null &&
    isAvailableBoardChatIssue(issue)
  );
}

function getBoardChatUnavailableReason(
  issue: {
    companyId?: string | null;
    originKind?: string | null;
    status?: string | null;
  } | null,
  companyId: string,
) {
  if (!issue) return BOARD_CHAT_UNAVAILABLE_REASONS.NOT_FOUND;
  if (issue.companyId !== companyId) return BOARD_CHAT_UNAVAILABLE_REASONS.WRONG_COMPANY;
  if (issue.originKind !== BOARD_CHAT_ORIGIN_KIND) return BOARD_CHAT_UNAVAILABLE_REASONS.WRONG_KIND;
  if (issue.status === "cancelled") return BOARD_CHAT_UNAVAILABLE_REASONS.CANCELLED;
  return null;
}

/**
 * Resolve the standing `board_chat` conversation issue for a company, creating
 * one (origin-tagged) if none is open. The real-agent Conference Room
 * selected-agent surface needs a backing issue the web client cannot mint
 * itself, since `createIssueBaseSchema` strips `originKind`.
 *
 * - `wantsNewConversation` skips reuse and always creates a fresh conversation
 *   (the room's "New chat" control).
 * - Otherwise reuse the most-recent non-cancelled origin-tagged issue, then adopt and
 *   repair a legacy "Board Operations" issue, then create.
 * - `message`, when present, seeds a first-message title; absent (the room
 *   mints before the first message), it falls back to "New chat".
 */
async function resolveOrCreateBoardChatIssue(
  issueSvc: ReturnType<typeof issueService>,
  companyId: string,
  opts: {
    message?: string;
    wantsNewConversation?: boolean;
    createdByUserId?: string | null;
    responsibleUserId?: string | null;
    trustExplicitResponsibleUserId?: boolean;
  },
): Promise<{ id: string }> {
  if (!opts.wantsNewConversation) {
    const boardChatIssues = await issueSvc.list(companyId, {
      originKind: BOARD_CHAT_ORIGIN_KIND,
      sortField: "updated",
      sortDir: "desc",
    });
    const boardIssue = boardChatIssues.find(isAvailableBoardChatIssue);
    if (boardIssue) return boardIssue;

    const legacyIssues = await issueSvc.list(companyId, {
      q: LEGACY_BOARD_CHAT_TITLE,
      sortField: "updated",
      sortDir: "desc",
    });
    const legacyIssue = legacyIssues.find(isLegacyBoardChatIssue);
    if (legacyIssue) {
      try {
        await issueSvc.update(legacyIssue.id, { originKind: BOARD_CHAT_ORIGIN_KIND });
      } catch {
        /* best-effort legacy repair; the selected issue still anchors this request */
      }
      return legacyIssue;
    }
  }

  return issueSvc.create(companyId, {
    title: opts.message ? deriveBoardChatIssueTitle(opts.message) : "New chat",
    description: BOARD_CHAT_DESCRIPTION,
    originKind: BOARD_CHAT_ORIGIN_KIND,
    // `todo` rather than `in_progress`: this is an unassigned standing issue,
    // and the service rejects in_progress issues without an assignee.
    status: "todo",
    priority: "medium",
    createdByUserId: opts.createdByUserId ?? null,
    responsibleUserId: opts.responsibleUserId ?? null,
    trustExplicitResponsibleUserId: opts.trustExplicitResponsibleUserId ?? false,
  });
}

export function boardChatRoutes(
  db: Db,
  _opts: { deploymentMode: DeploymentMode; deploymentExposure: DeploymentExposure },
) {
  const router = Router();

  // Mint (or resolve) the backing `board_chat` conversation issue WITHOUT
  // spawning the concierge subprocess. The live Conference Room (PAP-11099
  // Phase 3b) renders the real-agent `SelectedAgentChat` over this issue;
  // the web client can't create it directly because `originKind` is stripped
  // by the issue create schema. Gated on the experimental flag + instance
  // admin + company access. There is no
  // deployment-mode restriction, since nothing is spawned here.
  router.post("/board/chat/conversations", async (req, res) => {
    const experimental = await instanceSettingsService(db).getExperimental();
    if (experimental.enableConferenceRoomChat !== true) {
      res.status(403).json({
        error: "Conference Room Chat is not enabled",
        code: "FEATURE_DISABLED",
      });
      return;
    }

    const { companyId, newConversation, message } = req.body as {
      companyId?: string;
      newConversation?: boolean | string;
      message?: string;
    };
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }

    assertInstanceAdmin(req);
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const wantsNewConversation = newConversation === true || newConversation === "true";
    const issue = await resolveOrCreateBoardChatIssue(issueService(db), companyId, {
      message,
      wantsNewConversation,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      responsibleUserId: actor.actorType === "user" ? actor.actorId : null,
      trustExplicitResponsibleUserId: actor.actorType === "user",
    });
    res.status(200).json({ issue });
  });

  // Resolve a direct Conference Room URL ref. This intentionally does not
  // create or redirect: invalid direct links need a visible unavailable state
  // while valid UUID links can be canonicalized client-side to identifiers.
  router.get("/board/chat/conversations/:conversationRef", async (req, res) => {
    const experimental = await instanceSettingsService(db).getExperimental();
    if (experimental.enableConferenceRoomChat !== true) {
      res.status(403).json({
        error: "Conference Room Chat is not enabled",
        code: "FEATURE_DISABLED",
      });
      return;
    }

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : null;
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }

    assertInstanceAdmin(req);
    assertCompanyAccess(req, companyId);

    const issue = await issueService(db).getById(req.params.conversationRef as string);
    const unavailableReason = getBoardChatUnavailableReason(issue, companyId);
    res.status(200).json({
      issue: unavailableReason ? null : issue,
      unavailableReason,
    });
  });

  return router;
}
