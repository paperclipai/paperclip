import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  approveOPCBlueprintSchema,
  createOPCCompanySchema,
  createOPCProposalSchema,
  opcChatSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";
import { opcService } from "../services/opc.js";

export function opcRoutes(db: Db) {
  const router = Router();
  const svc = opcService(db);

  function boardActor(req: Request) {
    return {
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    };
  }

  router.post("/opc/proposals", validate(createOPCProposalSchema), async (req, res) => {
    assertBoard(req);
    const result = await svc.createProposal(req.body, boardActor(req));
    res.status(201).json(result);
  });

  router.get("/opc/proposals/:id", async (req, res) => {
    assertBoard(req);
    const result = await svc.getProposal(req.params.id as string);
    res.json(result);
  });

  router.post("/opc/proposals/:id/chat", validate(opcChatSchema), async (req, res) => {
    assertBoard(req);
    const result = await svc.chat(req.params.id as string, req.body, boardActor(req));
    res.json(result);
  });

  router.post(
    "/opc/proposals/:id/blueprint/approve",
    validate(approveOPCBlueprintSchema),
    async (req, res) => {
      assertBoard(req);
      const result = await svc.approveBlueprint(req.params.id as string, boardActor(req));
      res.json(result);
    },
  );

  router.post("/opc/proposals/:id/create-company", validate(createOPCCompanySchema), async (req, res) => {
    assertBoard(req);
    const result = await svc.createCompany(req.params.id as string, req.body, boardActor(req));
    res.status(201).json(result);
  });

  return router;
}
