import express from "express";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let errorHandlerMiddleware!: typeof import("../middleware/index.js").errorHandler;
let roadmapRoutesFactory!: typeof import("../routes/roadmap.js").roadmapRoutes;

function createApp(
  actor: Record<string, unknown>,
  repoRoot: string,
  opts?: {
    resolveCompanyRoadmapPath?: (companyId: string) => Promise<string | null>;
    resolveCompanyRoadmapContext?: (companyId: string) => Promise<{
      roadmapPath: string | null;
      name: string | null;
      issuePrefix: string | null;
    } | null>;
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    roadmapRoutesFactory({
      repoRoot,
      resolveCompanyRoadmapPath: opts?.resolveCompanyRoadmapPath,
      resolveCompanyRoadmapContext: opts?.resolveCompanyRoadmapContext,
    }),
  );
  app.use(errorHandlerMiddleware);
  return app;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function requestWithApp<T>(
  app: express.Express,
  run: (agent: request.SuperTest<request.Test>) => Promise<T>,
) {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await run(request(server));
  } finally {
    await closeServer(server);
  }
}

describe.sequential("roadmap route", () => {
  let repoRoot = "";

  beforeEach(async () => {
    vi.resetModules();
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
    ({ roadmapRoutes: roadmapRoutesFactory } = await import("../routes/roadmap.js"));
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-roadmap-"));
    await fs.mkdir(path.join(repoRoot, "doc", "plans"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "doc", "ROADMAP.md"),
      [
        "# Roadmap",
        "",
        "Canonical roadmap source:",
        "",
        "- [2026 Q2 CEO Roadmap](./plans/2026-q2-roadmap.md)",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "doc", "plans", "2026-q2-roadmap.md"),
      [
        "# 2026 Q2 CEO Roadmap",
        "",
        "Status: Active",
        "Owner: CEO",
        "Last Updated: 2026-04-11",
        "",
        "## Contract",
        "1. Tickets must map to a roadmap item.",
        "",
        "## Now",
        "### RM-2026-Q2-01 First success",
        "- Outcome: A user reaches success quickly.",
        "- Status: Planned",
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(async () => {
    if (repoRoot) {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it.sequential("returns parsed roadmap data for board users", async () => {
    const app = createApp(
      { type: "board", source: "local_implicit", userId: "board-user-1" },
      repoRoot,
    );

    const response = await requestWithApp(app, (agent) => agent.get("/api/roadmap"));
    expect(response.status).toBe(200);
    expect(response.body.roadmap.title).toBe("2026 Q2 CEO Roadmap");
    expect(response.body.roadmap.owner).toBe("CEO");
    expect(response.body.roadmap.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Now",
          items: expect.arrayContaining([
            expect.objectContaining({
              id: "RM-2026-Q2-01",
              title: "First success",
            }),
          ]),
        }),
      ]),
    );
  });

  it.sequential("allows company-scoped roadmap reads for agent keys with matching company access", async () => {
    const app = createApp(
      {
        type: "agent",
        source: "agent_key",
        agentId: "agent-1",
        companyId: "company-1",
      },
      repoRoot,
    );

    const response = await requestWithApp(app, (agent) =>
      agent.get("/api/roadmap").query({ companyId: "company-1" }),
    );
    expect(response.status).toBe(200);
    expect(response.body.roadmap.title).toBe("2026 Q2 CEO Roadmap");
  });

  it.sequential("renames a roadmap item title in the canonical markdown source", async () => {
    const app = createApp(
      { type: "board", source: "local_implicit", userId: "board-user-1" },
      repoRoot,
    );

    const response = await requestWithApp(app, (agent) =>
      agent
        .patch("/api/roadmap/items/RM-2026-Q2-01")
        .send({ title: "Faster first success" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.item).toEqual(
      expect.objectContaining({
        id: "RM-2026-Q2-01",
        title: "Faster first success",
      }),
    );

    const updated = await fs.readFile(path.join(repoRoot, "doc", "plans", "2026-q2-roadmap.md"), "utf8");
    expect(updated).toContain("### RM-2026-Q2-01 Faster first success");
    expect(updated).not.toContain("### RM-2026-Q2-01 First success");
  });

  it.sequential("rejects company-scoped roadmap reads for agent keys on other companies", async () => {
    const app = createApp(
      {
        type: "agent",
        source: "agent_key",
        agentId: "agent-1",
        companyId: "company-1",
      },
      repoRoot,
    );

    const response = await requestWithApp(app, (agent) =>
      agent.get("/api/roadmap").query({ companyId: "company-2" }),
    );
    expect(response.status).toBe(403);
  });

  it.sequential("uses a company-specific roadmap file when the company has a roadmapPath override", async () => {
    await fs.mkdir(path.join(repoRoot, "doc", "company-roadmaps"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "doc", "company-roadmaps", "comandero-roadmap.md"),
      [
        "# Comandero Roadmap",
        "",
        "Status: Active",
        "Owner: CEO",
        "Last Updated: 2026-04-12",
        "",
        "## Now",
        "### RM-2026-Q2-01 Checkout trust and explainability",
        "- Outcome: Cart flows feel trustworthy.",
      ].join("\n"),
      "utf8",
    );

    const app = createApp(
      { type: "board", source: "local_implicit", userId: "board-user-1" },
      repoRoot,
      {
        resolveCompanyRoadmapPath: async (companyId) =>
          companyId === "company-1" ? "doc/company-roadmaps/comandero-roadmap.md" : null,
      },
    );

    const response = await requestWithApp(app, (agent) =>
      agent.get("/api/roadmap").query({ companyId: "company-1" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.roadmap.title).toBe("Comandero Roadmap");
    expect(response.body.roadmap.path).toBe("doc/company-roadmaps/comandero-roadmap.md");
    expect(response.body.roadmap.sections[0]?.items[0]).toEqual(
      expect.objectContaining({
        id: "RM-2026-Q2-01",
        title: "Checkout trust and explainability",
      }),
    );
  });

  it.sequential("renames a roadmap item in the company-specific roadmap file when a company override exists", async () => {
    await fs.mkdir(path.join(repoRoot, "doc", "company-roadmaps"), { recursive: true });
    const roadmapPath = path.join(repoRoot, "doc", "company-roadmaps", "comandero-roadmap.md");
    await fs.writeFile(
      roadmapPath,
      [
        "# Comandero Roadmap",
        "",
        "Status: Active",
        "Owner: CEO",
        "Last Updated: 2026-04-12",
        "",
        "## Now",
        "### RM-2026-Q2-01 Checkout trust and explainability",
        "- Outcome: Cart flows feel trustworthy.",
      ].join("\n"),
      "utf8",
    );

    const app = createApp(
      { type: "board", source: "local_implicit", userId: "board-user-1" },
      repoRoot,
      {
        resolveCompanyRoadmapPath: async (companyId) =>
          companyId === "company-1" ? "doc/company-roadmaps/comandero-roadmap.md" : null,
      },
    );

    const response = await requestWithApp(app, (agent) =>
      agent
        .patch("/api/roadmap/items/RM-2026-Q2-01")
        .query({ companyId: "company-1" })
        .send({ title: "Checkout trust and proof" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.item).toEqual(
      expect.objectContaining({
        id: "RM-2026-Q2-01",
        title: "Checkout trust and proof",
      }),
    );

    const updated = await fs.readFile(roadmapPath, "utf8");
    expect(updated).toContain("### RM-2026-Q2-01 Checkout trust and proof");
    expect(updated).not.toContain("### RM-2026-Q2-01 Checkout trust and explainability");
  });

  it.sequential("auto-detects a company roadmap by slugged company name when no explicit path is set", async () => {
    await fs.mkdir(path.join(repoRoot, "doc", "company-roadmaps"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "doc", "company-roadmaps", "comandero-labs-roadmap.md"),
      [
        "# Comandero Labs Roadmap",
        "",
        "Status: Active",
        "Owner: CEO",
        "Last Updated: 2026-04-12",
        "",
        "## Now",
        "### RM-2026-Q2-03 Sales-safe website and funnel",
        "- Outcome: Funnel is resilient.",
      ].join("\n"),
      "utf8",
    );

    const app = createApp(
      { type: "board", source: "local_implicit", userId: "board-user-1" },
      repoRoot,
      {
        resolveCompanyRoadmapContext: async (companyId) =>
          companyId === "company-1"
            ? { roadmapPath: null, name: "Comandero Labs", issuePrefix: "COMA" }
            : null,
      },
    );

    const response = await requestWithApp(app, (agent) =>
      agent.get("/api/roadmap").query({ companyId: "company-1" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.roadmap.title).toBe("Comandero Labs Roadmap");
    expect(response.body.roadmap.path).toBe("doc/company-roadmaps/comandero-labs-roadmap.md");
  });

  it.sequential("renames items in the auto-detected company roadmap file", async () => {
    await fs.mkdir(path.join(repoRoot, "doc", "company-roadmaps"), { recursive: true });
    const roadmapPath = path.join(repoRoot, "doc", "company-roadmaps", "comandero-labs-roadmap.md");
    await fs.writeFile(
      roadmapPath,
      [
        "# Comandero Labs Roadmap",
        "",
        "Status: Active",
        "Owner: CEO",
        "Last Updated: 2026-04-12",
        "",
        "## Now",
        "### RM-2026-Q2-03 Sales-safe website and funnel",
        "- Outcome: Funnel is resilient.",
      ].join("\n"),
      "utf8",
    );

    const app = createApp(
      { type: "board", source: "local_implicit", userId: "board-user-1" },
      repoRoot,
      {
        resolveCompanyRoadmapContext: async (companyId) =>
          companyId === "company-1"
            ? { roadmapPath: null, name: "Comandero Labs", issuePrefix: "COMA" }
            : null,
      },
    );

    const response = await requestWithApp(app, (agent) =>
      agent
        .patch("/api/roadmap/items/RM-2026-Q2-03")
        .query({ companyId: "company-1" })
        .send({ title: "Sales-safe website and conversion flow" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.roadmap.path).toBe("doc/company-roadmaps/comandero-labs-roadmap.md");

    const updated = await fs.readFile(roadmapPath, "utf8");
    expect(updated).toContain("### RM-2026-Q2-03 Sales-safe website and conversion flow");
    expect(updated).not.toContain("### RM-2026-Q2-03 Sales-safe website and funnel");
  });

  it.sequential("falls back to issue-prefix roadmap autodetect when slug candidate is missing", async () => {
    await fs.mkdir(path.join(repoRoot, "doc", "company-roadmaps"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "doc", "company-roadmaps", "coma-roadmap.md"),
      [
        "# COMA Roadmap",
        "",
        "Status: Active",
        "Owner: CEO",
        "Last Updated: 2026-04-12",
        "",
        "## Now",
        "### RM-2026-Q2-04 Runtime and ops hygiene",
        "- Outcome: Runtime locks stay healthy.",
      ].join("\n"),
      "utf8",
    );

    const app = createApp(
      { type: "board", source: "local_implicit", userId: "board-user-1" },
      repoRoot,
      {
        resolveCompanyRoadmapContext: async (companyId) =>
          companyId === "company-1"
            ? { roadmapPath: null, name: "Company With No Matching Slug File", issuePrefix: "COMA" }
            : null,
      },
    );

    const response = await requestWithApp(app, (agent) =>
      agent.get("/api/roadmap").query({ companyId: "company-1" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.roadmap.title).toBe("COMA Roadmap");
    expect(response.body.roadmap.path).toBe("doc/company-roadmaps/coma-roadmap.md");
  });

  it.sequential("falls back to canonical roadmap when no company roadmap override or autodetect files exist", async () => {
    const app = createApp(
      { type: "board", source: "local_implicit", userId: "board-user-1" },
      repoRoot,
      {
        resolveCompanyRoadmapContext: async (companyId) =>
          companyId === "company-1"
            ? { roadmapPath: null, name: "No Special File", issuePrefix: "NSF" }
            : null,
      },
    );

    const response = await requestWithApp(app, (agent) =>
      agent.get("/api/roadmap").query({ companyId: "company-1" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.roadmap.title).toBe("2026 Q2 CEO Roadmap");
    expect(response.body.roadmap.path).toBe("doc/plans/2026-q2-roadmap.md");
  });
});
