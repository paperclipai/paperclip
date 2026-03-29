import path from "node:path";
import fs from "node:fs/promises";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { evalRunnerService, loadBundle } from "../services/eval-runner.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";

/**
 * Default directory where eval bundle JSON files live.
 * Can be overridden via PAPERCLIP_EVALS_DIR env var.
 */
function getEvalsDir(): string {
  return process.env.PAPERCLIP_EVALS_DIR ?? path.resolve(process.cwd(), "evals");
}

export function evalRoutes(db: Db) {
  const router = Router();
  const evalRunner = evalRunnerService(db);

  // ── GET /companies/:companyId/evals/bundles ───────────────────────────
  // List available eval bundles by scanning the evals directory for JSON files.
  router.get("/companies/:companyId/evals/bundles", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const evalsDir = getEvalsDir();
    try {
      const entries = await fs.readdir(evalsDir).catch(() => [] as string[]);
      const jsonFiles = entries.filter((f) => f.endsWith(".json"));

      const bundles = [];
      for (const file of jsonFiles) {
        try {
          const bundle = await loadBundle(path.join(evalsDir, file));
          bundles.push({
            id: bundle.id,
            name: bundle.name,
            description: bundle.description,
            caseCount: bundle.cases.length,
            createdAt: bundle.createdAt,
            fileName: file,
          });
        } catch {
          // Skip malformed bundle files
          logger.warn({ file }, "Skipping malformed eval bundle file");
        }
      }

      res.json(bundles);
    } catch (err) {
      logger.error({ err }, "Failed to list eval bundles");
      res.json([]);
    }
  });

  // ── POST /companies/:companyId/evals/run ──────────────────────────────
  // Run an eval bundle against a specific agent.
  router.post("/companies/:companyId/evals/run", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const { bundleId, agentId } = req.body as { bundleId?: string; agentId?: string };
    if (!bundleId) throw badRequest("bundleId is required");
    if (!agentId) throw badRequest("agentId is required");

    // Find the bundle file
    const evalsDir = getEvalsDir();
    let bundle: Awaited<ReturnType<typeof loadBundle>> | null = null;

    try {
      const entries = await fs.readdir(evalsDir);
      for (const file of entries.filter((f) => f.endsWith(".json"))) {
        try {
          const candidate = await loadBundle(path.join(evalsDir, file));
          if (candidate.id === bundleId) {
            bundle = candidate;
            break;
          }
        } catch {
          // skip
        }
      }
    } catch {
      throw notFound("Evals directory not found or not readable");
    }

    if (!bundle) {
      throw notFound(`Eval bundle "${bundleId}" not found`);
    }

    // Run the bundle (this may take a while)
    const summary = await evalRunner.runBundle(bundle, companyId, agentId);
    res.status(201).json(summary);
  });

  // ── GET /companies/:companyId/evals/results ───────────────────────────
  // List past eval results.
  router.get("/companies/:companyId/evals/results", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const limitRaw = req.query.limit as string | undefined;
    const limit = limitRaw ? Math.min(Number.parseInt(limitRaw, 10) || 50, 200) : 50;

    const results = await evalRunner.listResults(companyId, limit);
    res.json(results);
  });

  // ── GET /companies/:companyId/evals/results/:id ───────────────────────
  // Get one eval result by ID.
  router.get("/companies/:companyId/evals/results/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const resultId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const result = await evalRunner.getResult(companyId, resultId);
    if (!result) {
      throw notFound("Eval result not found");
    }
    res.json(result);
  });

  // ── GET /companies/:companyId/evals/results/:id/cases ─────────────────
  // Get individual case results for an eval run.
  router.get("/companies/:companyId/evals/results/:id/cases", async (req, res) => {
    const companyId = req.params.companyId as string;
    const resultId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const result = await evalRunner.getResult(companyId, resultId);
    if (!result) {
      throw notFound("Eval result not found");
    }

    const caseResults = await evalRunner.getCaseResults(companyId, resultId);
    res.json(caseResults);
  });

  // ── GET /companies/:companyId/evals/results/:bundleId/summary ─────────
  // Get aggregated summary for a specific bundle across all runs.
  router.get("/companies/:companyId/evals/summary/:bundleId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const bundleId = req.params.bundleId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const summary = await evalRunner.getSummary(companyId, bundleId);
    if (!summary) {
      throw notFound(`No eval results found for bundle "${bundleId}"`);
    }
    res.json(summary);
  });

  return router;
}
