import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { templateRoutes } from "../routes/templates.js";

const templatesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../templates",
);

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/templates", templateRoutes({ templatesRoot }));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

describe("template routes", () => {
  it("lists built-in templates", async () => {
    const res = await request(buildApp()).get("/templates");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "solo-founder-lite",
          name: "Solo Founder Lite",
          riskProfile: "low",
        }),
        expect.objectContaining({
          id: "safe-autonomous-organization",
          name: "Safe Autonomous Organization",
          riskProfile: "high-control",
        }),
      ]),
    );
  });

  it("returns built-in template detail", async () => {
    const res = await request(buildApp()).get("/templates/solo-founder-lite");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: "solo-founder-lite",
        setupMarkdown: null,
        manifest: expect.objectContaining({
          includes: expect.objectContaining({
            company: true,
            agents: true,
            goals: false,
            projects: false,
            issues: false,
          }),
        }),
      }),
    );
  });

  it("returns setup guidance when a template provides it", async () => {
    const res = await request(buildApp()).get("/templates/safe-autonomous-organization");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: "safe-autonomous-organization",
        recommendedFor: expect.arrayContaining(["regulated workflows"]),
        setupMarkdown: expect.stringContaining("Safe Autonomous Organization Setup"),
      }),
    );
  });
});
