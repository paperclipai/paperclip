import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createProposalSchema, castVoteSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { consensusService, logActivity } from "../services/index.js";

export function consensusRoutes(db: Db) {
  const router = Router();
  const svc = consensusService(db);

  // List proposals for a company
  router.get("/companies/:companyId/proposals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const proposals = await svc.list(companyId, {
      status: req.query.status as string | undefined,
    });
    res.json(proposals);
  });

  // Get a single proposal
  router.get("/proposals/:id", async (req, res) => {
    const proposal = await svc.getById(req.params.id as string);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    assertCompanyAccess(req, proposal.companyId);
    res.json(proposal);
  });

  // Create a proposal
  router.post(
    "/companies/:companyId/proposals",
    validate(createProposalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const proposal = await svc.create(
        companyId,
        {
          title: req.body.title,
          description: req.body.description,
          proposalType: req.body.proposalType,
          quorumType: req.body.quorumType,
          quorumMinVotes: req.body.quorumMinVotes,
          payload: req.body.payload,
          knowledgeEntryId: req.body.knowledgeEntryId,
          expiresAt: req.body.expiresAt,
        },
        { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null },
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "proposal.created",
        entityType: "proposal",
        entityId: proposal.id,
        details: { title: proposal.title, proposalType: proposal.proposalType },
      });

      res.status(201).json(proposal);
    },
  );

  // Cast a vote
  router.post(
    "/proposals/:id/vote",
    validate(castVoteSchema),
    async (req, res) => {
      const proposal = await svc.getById(req.params.id as string);
      if (!proposal) {
        res.status(404).json({ error: "Proposal not found" });
        return;
      }
      assertCompanyAccess(req, proposal.companyId);
      const actor = getActorInfo(req);

      const vote = await svc.vote(
        req.params.id as string,
        { vote: req.body.vote, reasoning: req.body.reasoning },
        { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null },
      );

      await logActivity(db, {
        companyId: proposal.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "proposal.voted",
        entityType: "proposal",
        entityId: proposal.id,
        details: { vote: req.body.vote },
      });

      res.json(vote);
    },
  );

  // Board veto
  router.post("/proposals/:id/veto", async (req, res) => {
    assertBoard(req);
    const proposal = await svc.getById(req.params.id as string);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    assertCompanyAccess(req, proposal.companyId);

    const vetoedBy = req.actor.userId ?? "board";
    const vetoed = await svc.veto(req.params.id as string, vetoedBy);

    await logActivity(db, {
      companyId: proposal.companyId,
      actorType: "user",
      actorId: vetoedBy,
      action: "proposal.vetoed",
      entityType: "proposal",
      entityId: proposal.id,
      details: { title: proposal.title },
    });

    res.json(vetoed);
  });

  // List votes for a proposal
  router.get("/proposals/:id/votes", async (req, res) => {
    const proposal = await svc.getById(req.params.id as string);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    assertCompanyAccess(req, proposal.companyId);
    const votes = await svc.listVotes(req.params.id as string);
    res.json(votes);
  });

  return router;
}
