import { Router, type Request } from "express";
import { forbidden } from "../errors.js";

interface ContainerProbeRouteOptions {
  probe: () => Promise<{ ok: boolean; summary?: string; error?: string }>;
}

function assertInstanceAdmin(req: Request) {
  if (req.actor.type !== "board") throw forbidden("Board access required");
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  throw forbidden("Instance admin access required");
}

export function containerProbeRoutes(opts: ContainerProbeRouteOptions) {
  const router = Router();

  router.get("/instance/container-engine/probe", async (req, res) => {
    assertInstanceAdmin(req);
    const result = await opts.probe();
    res.json(result);
  });

  return router;
}
