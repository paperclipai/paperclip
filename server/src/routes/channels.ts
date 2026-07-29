import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createChannelSchema,
  createDmChannelSchema,
  createIssueFromChannelMessageSchema,
  markChannelReadSchema,
  postChannelMessageSchema,
  updateChannelMemberSchema,
  updateChannelSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { channelService, type ChannelActor } from "../services/channels.js";
import { logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

function toChannelActor(req: Request): ChannelActor {
  const actor = getActorInfo(req);
  return actor.actorType === "agent"
    ? { principalType: "agent", principalId: actor.agentId ?? actor.actorId }
    : { principalType: "user", principalId: actor.actorId };
}

function parseLimit(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: unknown): boolean {
  return value === "true" || value === "1";
}

export function channelRoutes(db: Db) {
  const router = Router();
  const svc = channelService(db);

  router.get("/companies/:companyId/channels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = toChannelActor(req);
    // Every company with channels enabled always has a #general channel.
    if (await svc.channelsEnabled(companyId)) {
      await svc.ensureGeneralChannel(companyId);
    }
    const result = await svc.listChannels(companyId, actor, {
      includeArchived: parseBoolean(req.query.includeArchived),
    });
    res.json(result);
  });

  router.post(
    "/companies/:companyId/channels",
    validate(createChannelSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const channel = await svc.createChannel(companyId, toChannelActor(req), req.body);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "channel.created",
        entityType: "channel",
        entityId: channel.id,
        details: { name: channel.name, kind: channel.kind },
      });
      res.status(201).json(channel);
    },
  );

  router.post(
    "/companies/:companyId/channels/dm",
    validate(createDmChannelSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const channel = await svc.getOrCreateDm(companyId, toChannelActor(req), {
        principalType: req.body.principalType,
        principalId: req.body.principalId,
      });
      res.json(channel);
    },
  );

  router.get("/companies/:companyId/channels/presence", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listPresence(companyId));
  });

  router.get("/companies/:companyId/channels/:channelId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const channel = await svc.requireChannel(companyId, req.params.channelId as string);
    const member = await svc.getMember(channel.id, toChannelActor(req));
    res.json({ ...channel, muted: member?.muted ?? false, isMember: Boolean(member) });
  });

  router.patch(
    "/companies/:companyId/channels/:channelId",
    validate(updateChannelSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const channelId = req.params.channelId as string;
      assertCompanyAccess(req, companyId);
      const channel = await svc.updateChannel(companyId, channelId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "channel.updated",
        entityType: "channel",
        entityId: channel.id,
        details: req.body,
      });
      res.json(channel);
    },
  );

  router.get("/companies/:companyId/channels/:channelId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    assertCompanyAccess(req, companyId);
    await svc.requireChannel(companyId, channelId);
    const page = await svc.listRootMessages(channelId, {
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
      limit: parseLimit(req.query.limit),
      includeCompleted: parseBoolean(req.query.includeCompleted),
    });
    res.json(page);
  });

  router.post(
    "/companies/:companyId/channels/:channelId/messages",
    validate(postChannelMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const channelId = req.params.channelId as string;
      assertCompanyAccess(req, companyId);
      const actor = toChannelActor(req);
      const message = await svc.postMessage({
        companyId,
        channelId,
        authorType: actor.principalType,
        authorId: actor.principalId,
        body: req.body.body,
        threadRootId: req.body.threadRootId ?? null,
        replyToId: req.body.replyToId ?? null,
        channelWorkMode: req.body.channelWorkMode ?? null,
        issueId: req.body.issueId ?? null,
        cardKind: req.body.cardKind ?? null,
        mentionedAgentIds: req.body.mentionedAgentIds,
        mentionedUserIds: req.body.mentionedUserIds,
      });
      res.status(201).json(message);
    },
  );

  router.post("/companies/:companyId/channels/:channelId/materialize", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    assertCompanyAccess(req, companyId);
    await svc.requireChannel(companyId, channelId);
    const created = await svc.materializeProjectTaskRoots(channelId);
    res.json({ created });
  });

  router.get(
    "/companies/:companyId/channels/:channelId/messages/:messageId/thread",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const channelId = req.params.channelId as string;
      assertCompanyAccess(req, companyId);
      await svc.requireChannel(companyId, channelId);
      const page = await svc.listThreadMessages(req.params.messageId as string, {
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
        limit: parseLimit(req.query.limit),
      });
      res.json(page);
    },
  );

  router.post(
    "/companies/:companyId/channels/:channelId/messages/:messageId/issue",
    validate(createIssueFromChannelMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const channelId = req.params.channelId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const result = await svc.createIssueFromMessage({
        companyId,
        channelId,
        messageId: req.params.messageId as string,
        actor: toChannelActor(req),
        title: req.body.title,
        assigneeAgentId: req.body.assigneeAgentId ?? null,
        projectId: req.body.projectId ?? null,
        workMode: req.body.workMode,
        wakeAssignee: req.body.wakeAssignee,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "issue.created",
        entityType: "issue",
        entityId: result.issue.id,
        details: { source: "channel_message", channelId, messageId: req.params.messageId },
      });
      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/channels/:channelId/read",
    validate(markChannelReadSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const member = await svc.markRead(
        companyId,
        req.params.channelId as string,
        toChannelActor(req),
        req.body.messageId ?? null,
      );
      res.json(member);
    },
  );

  router.patch(
    "/companies/:companyId/channels/:channelId/member",
    validate(updateChannelMemberSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const member = await svc.updateMember(
        companyId,
        req.params.channelId as string,
        toChannelActor(req),
        req.body,
      );
      res.json(member);
    },
  );

  return router;
}
