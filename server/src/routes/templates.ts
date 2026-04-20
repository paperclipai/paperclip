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
      res.status(503).json({ error: "registry unavailable" });
    }
  });

  router.post("/companies/install", requireBoard, async (req, res) => {
    const slug = typeof req.body?.slug === "string" ? req.body.slug : null;
    if (!slug) {
      res.status(400).json({ error: "slug required" });
      return;
    }

    let registry;
    try {
      registry = await deps.registry.get();
    } catch (err) {
      res.status(503).json({ error: "registry unavailable" });
      return;
    }

    const tpl = registry.companies.find((c) => c.slug === slug);
    if (!tpl) {
      res.status(404).json({ error: `unknown template: ${slug}` });
      return;
    }

    const payload = {
      source: { type: "github" as const, url: tpl.url },
      target: { mode: "new" as const, newCompanyName: tpl.name },
      include: ["company", "agents", "skills"],
      collision: "skip" as const,
    };

    try {
      const actor = (req as any).actor;
      const userId = actor?.type === "board" ? actor.userId : null;
      const result = await deps.portability.importBundle(payload, userId);
      res.json({
        companyId: result.company.id,
        name: result.company.name ?? tpl.name,
        agentsCreated: result.agents.length,
      });
    } catch (err) {
      res.status(422).json({ error: "import failed", detail: (err as Error).message });
    }
  });

  router.post("/refresh", requireAdmin, async (_req, res) => {
    deps.registry.invalidate();
    try {
      const registry = await deps.registry.get();
      res.json({ ok: true, companies: registry.companies.length });
    } catch (err) {
      res.status(503).json({ error: "registry reload failed" });
    }
  });

  return router;
}
