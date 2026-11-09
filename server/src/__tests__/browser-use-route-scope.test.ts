import { randomUUID } from "node:crypto";
import express from "express";
import http from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { browserUseRoutes } from "../routes/browser-use.js";

const routes = [
  { method: "get", suffix: "" },
  { method: "get", suffix: "/viewer" },
  { method: "post", suffix: "/presence" },
  { method: "post", suffix: "/viewport" },
  { method: "post", suffix: "/viewport/release" },
  { method: "post", suffix: "/control" },
] as const;

describe("browser task route scope", () => {
  it.each([
    "12345678-1234-4234-8234-123456789abc",
    "12345678-1234-7234-8234-123456789ABC",
    "00000000-0000-0000-0000-000000000000",
  ])("keeps canonical PostgreSQL task UUIDs queryable: %s", async (id) => {
    const companyId = randomUUID();
    const limit = vi.fn().mockResolvedValue([{ companyId }]);
    const db = { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) } as unknown as Db;
    const list = vi.fn().mockResolvedValue([]);
    const service = { list } as unknown as NonNullable<Parameters<typeof browserUseRoutes>[1]>;
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "browser-reviewer", source: "session", companyIds: [companyId] };
      next();
    });
    app.use(browserUseRoutes(db, service));
    app.use(errorHandler);
    expect((await http(app).get(`/issues/${id}/browsers`)).status).toBe(200);
    expect(limit).toHaveBeenCalledExactlyOnceWith(1);
    expect(list).toHaveBeenCalledExactlyOnceWith(companyId, id, "browser-reviewer");
  });

  it.each(routes)("rejects invalid task IDs before any query: $method $suffix", async ({ method, suffix }) => {
    const select = vi.fn(() => { throw new Error("Invalid scope reached the database"); });
    const db = { select } as unknown as Db;
    const service = Object.fromEntries(
      ["list", "viewer", "presence", "resize", "releaseViewport", "humanSession", "control"]
        .map((name) => [name, vi.fn()]),
    ) as unknown as NonNullable<Parameters<typeof browserUseRoutes>[1]>;
    let actorType: "board" | "agent" | "none" = "board";
    const app = express();
    app.use((req, _res, next) => {
      req.actor = actorType === "board"
        ? { type: "board", userId: "browser-reviewer", source: "session", companyIds: [] }
        : actorType === "agent"
          ? { type: "agent", companyId: randomUUID(), agentId: randomUUID(), source: "agent_key" }
          : { type: "none" };
      next();
    });
    app.use(browserUseRoutes(db, service));
    app.use(errorHandler);
    const id = randomUUID();
    for (const invalidId of [`chat:${id}`, "not-a-uuid", `${id}'`, ` ${id}`, `${id}\n`]) {
      const path = `/issues/${encodeURIComponent(invalidId)}/browsers${suffix ? `/${id}${suffix}` : ""}`;
      for (const type of ["board", "agent", "none"] as const) {
        actorType = type;
        const response = await http(app)[method](path);
        expect(response.status).toBe(type === "board" ? 404 : 403);
        expect(response.body).toEqual({ error: type === "board" ? "Task not found" : "Board access required" });
      }
    }
    expect(select).not.toHaveBeenCalled();
    for (const handler of Object.values(service)) expect(handler).not.toHaveBeenCalled();
  });
});
