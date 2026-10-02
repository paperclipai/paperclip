import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  pubsubEnvelopeSchema,
  pubsubIdSchema,
  pubsubObserverSchema,
  pubsubPublishSchema,
  pubsubSubscribeSchema,
  pubsubTopicSchema,
  pubsubTrustSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import type { PubsubService } from "../services/pubsub.js";
import { findPubsubCeo } from "../services/pubsub-wake.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";

const companyScope = z.object({ companyId: pubsubIdSchema });
const pageQuery = companyScope.extend({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  after: z.string().min(1).max(1024).optional(),
});
const trustBody = pubsubTrustSchema.extend({ companyId: pubsubIdSchema });
const subscriptionBody = pubsubSubscribeSchema.extend({ companyId: pubsubIdSchema });
const publishBody = pubsubPublishSchema.extend({ companyId: pubsubIdSchema });
const observerBody = pubsubObserverSchema.extend({ companyId: pubsubIdSchema });

/** Mounted before local actor authentication. Only this exact POST trusts signatures instead. */
export function pubsubDeliveryRoutes(service: PubsubService) {
  const router = Router();
  router.post("/api/pubsub/deliver", async (req, res) => {
    res.json(await service.receive(pubsubEnvelopeSchema.parse(req.body)));
  });
  return router;
}

export function pubsubRoutes(db: Db, service: PubsubService) {
  const router = Router();
  router.use((req, _res, next) => {
    assertAuthenticated(req);
    next();
  });

  function scope(req: Request) {
    const { companyId } = companyScope.parse(req.method === "GET" ? req.query : req.body);
    assertCompanyAccess(req, companyId);
    return companyId;
  }
  function boardScope(req: Request) {
    const companyId = scope(req);
    assertBoard(req);
    return companyId;
  }
  async function dataAuthority(req: Request, companyId: string, readOnly: boolean) {
    if (req.actor.type === "board") return "board" as const;
    const agentId = req.actor.agentId;
    if (req.actor.type !== "agent" || !agentId) throw forbidden("CEO or board access required");
    if (await service.isObserver(companyId, agentId)) {
      if (readOnly) return "observer" as const;
      throw forbidden("PubSub observers are read-only");
    }
    const ceo = await findPubsubCeo(db, companyId);
    if (ceo?.id === agentId) return "ceo" as const;
    throw forbidden("CEO or board access required");
  }
  async function audit(req: Request, companyId: string, action: string, entityId: string) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: `pubsub.${action}`,
      entityType: "pubsub",
      entityId,
    });
  }

  router.get("/identity", async (req, res) => {
    scope(req);
    assertInstanceAdmin(req);
    res.json(await service.identity());
  });
  router.get("/trust", async (req, res) => {
    res.json(await service.listTrust(boardScope(req)));
  });
  router.post("/trust", async (req, res) => {
    const companyId = boardScope(req);
    const body = trustBody.parse(req.body);
    const result = await service.addTrust(body);
    await audit(req, companyId, "trust_added", body.peerInstanceId);
    res.status(201).json(result);
  });
  router.delete("/trust/:peerInstanceId", async (req, res) => {
    const companyId = boardScope(req);
    const peerInstanceId = pubsubIdSchema.parse(req.params.peerInstanceId);
    await service.revokeTrust(companyId, peerInstanceId);
    await audit(req, companyId, "trust_revoked", peerInstanceId);
    res.status(204).end();
  });
  router.get("/subscriptions", async (req, res) => {
    res.json(await service.subscriptions(boardScope(req)));
  });
  router.post("/subscriptions", async (req, res) => {
    const companyId = boardScope(req);
    const body = subscriptionBody.parse(req.body);
    const result = await service.subscribe(body);
    await audit(req, companyId, "subscribed", body.peerInstanceId);
    res.status(201).json(result);
  });
  router.delete("/subscriptions/:id", async (req, res) => {
    const companyId = boardScope(req);
    const id = pubsubIdSchema.parse(req.params.id);
    await service.unsubscribe(companyId, id);
    await audit(req, companyId, "unsubscribed", id);
    res.status(204).end();
  });
  router.post("/publish", async (req, res) => {
    const companyId = scope(req);
    const authority = await dataAuthority(req, companyId, false);
    const body = publishBody.parse(req.body);
    const result = await service.publish({
      ...body,
      agentId: authority === "ceo" ? req.actor.agentId! : null,
      role: authority === "ceo" ? "ceo" : "board",
    });
    await audit(req, companyId, "published", result.id);
    res.status(202).json(result);
  });
  router.get("/inbox", async (req, res) => {
    const companyId = scope(req);
    const authority = await dataAuthority(req, companyId, true);
    const query = pageQuery.parse(req.query);
    res.json(await service.inbox(companyId, { limit: query.limit, after: query.after, observer: authority === "observer" }));
  });
  router.post("/inbox/:id/ack", async (req, res) => {
    const companyId = scope(req);
    await dataAuthority(req, companyId, false);
    const id = pubsubIdSchema.parse(req.params.id);
    const result = await service.ack(companyId, id);
    await audit(req, companyId, "acked", id);
    res.json(result);
  });
  router.get("/history", async (req, res) => {
    const companyId = scope(req);
    const authority = await dataAuthority(req, companyId, true);
    const query = pageQuery.extend({ topic: pubsubTopicSchema }).parse(req.query);
    if (authority === "observer" && !query.topic.startsWith("fleet.chat.") && !query.topic.startsWith("fleet.p2p.")) {
      throw forbidden("PubSub observers may read only chat and P2P topics");
    }
    res.json(await service.history(companyId, { topic: query.topic, limit: query.limit, after: query.after }));
  });
  router.post("/observers", async (req, res) => {
    const companyId = boardScope(req);
    const { agentId } = observerBody.parse(req.body);
    await service.addObserver(companyId, agentId);
    await audit(req, companyId, "observer_added", agentId);
    res.status(201).json({ agentId });
  });
  router.delete("/observers/:agentId", async (req, res) => {
    const companyId = boardScope(req);
    const agentId = pubsubIdSchema.parse(req.params.agentId);
    await service.removeObserver(companyId, agentId);
    await audit(req, companyId, "observer_removed", agentId);
    res.status(204).end();
  });
  return router;
}
