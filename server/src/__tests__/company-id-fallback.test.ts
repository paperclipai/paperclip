import express, { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

describe("Company ID Fallback Middleware", () => {
  function createApp(actor: any) {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });

    const api = Router();

    // O mesmo middleware de fallback que inserimos no app.ts
    api.use((req, _res, next) => {
      if (req.method === "GET" && (req.path === "/issues" || req.path === "/companies/issues")) {
        let companyId: string | undefined;
        if (req.actor?.type === "agent") {
          companyId = req.actor.companyId;
        } else if (req.actor?.type === "board") {
          if (req.actor.companyIds && req.actor.companyIds.length > 0) {
            companyId = req.actor.companyIds[0];
          }
        }

        if (companyId) {
          const queryIndex = req.url.indexOf("?");
          const queryString = queryIndex !== -1 ? req.url.slice(queryIndex) : "";
          req.url = `/companies/${companyId}/issues${queryString}`;
        }
      }
      next();
    });

    // Rota alvo dummy
    api.get("/companies/:companyId/issues", (req, res) => {
      res.json({
        success: true,
        companyId: req.params.companyId,
        query: req.query,
      });
    });

    // Rotas de erro/fallback originais para quando não há fallback disponível
    api.get("/issues", (_req, res) => {
      res.status(400).json({
        error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
      });
    });

    api.get("/companies/issues", (_req, res) => {
      res.status(400).json({
        error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
      });
    });

    app.use("/api", api);
    return app;
  }

  it("performs fallback to companyId for agent actor querying /api/issues", async () => {
    const app = createApp({
      type: "agent",
      companyId: "company-agent-123",
    });

    const res = await request(app).get("/api/issues?status=in_review");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      companyId: "company-agent-123",
      query: { status: "in_review" },
    });
  });

  it("performs fallback to companyId for board actor querying /api/companies/issues", async () => {
    const app = createApp({
      type: "board",
      companyIds: ["company-board-456"],
    });

    const res = await request(app).get("/api/companies/issues");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      companyId: "company-board-456",
      query: {},
    });
  });

  it("returns 400 when no fallback companyId is available for agent/board", async () => {
    const app = createApp({
      type: "none",
    });

    const res = await request(app).get("/api/issues");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing companyId in path");
  });
});
