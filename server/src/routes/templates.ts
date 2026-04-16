import { Router, type Request, type Response, type NextFunction } from "express";
import type { TemplateRegistryService } from "../services/template-registry.js";

export interface TemplatePortabilityAdapter {
  importBundle(payload: unknown, userId: string | null): Promise<{
    company: { id: string; name?: string };
    agents: Array<{ slug: string }>;
    warnings: unknown[];
  }>;
}

function requireBoard(req: Request, res: Response, next: NextFunction) {
  const actor = (req as any).actor;
  if (!actor || actor.type !== "board") {
    res.status(401).json({ error: "Board authentication required" });
    return;
  }
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const actor = (req as any).actor;
  if (!actor || actor.type !== "board" || !actor.isInstanceAdmin) {
    res.status(403).json({ error: "Instance admin required" });
    return;
  }
  next();
}

export function templateRoutes(deps: {
  registry: TemplateRegistryService;
  portability: TemplatePortabilityAdapter;
}) {
  const router = Router();

  router.get("/companies", requireBoard, async (_req, res) => {
    try {
      const registry = await deps.registry.get();
      res.json({ companies: registry.companies });
    } catch (err) {
      res.status(503).json({ error: "registry unavailable", detail: (err as Error).message });
    }
  });

  // Reserved for Task 6 (admin-only template import).
  void requireAdmin;

  return router;
}
