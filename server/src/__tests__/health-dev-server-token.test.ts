import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";

const tempDirs: string[] = [];

function createDevServerStatusFile(payload: unknown) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-health-dev-server-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "dev-server-status.json");
  writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GET /health dev-server supervisor access", () => {
  it("exposes dev-server metadata to the supervising dev runner in authenticated mode", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    const previousToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      pendingMigrations: [],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });
    process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN = "dev-runner-token";

    let selectCall = 0;
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([{ count: 1 }]),
            })),
          };
        }
        if (selectCall === 2) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([
                {
                  id: "settings-1",
                  general: {},
                  experimental: { autoRestartDevServerWhenIdle: true },
                  createdAt: new Date("2026-03-20T11:00:00.000Z"),
                  updatedAt: new Date("2026-03-20T11:00:00.000Z"),
                },
              ]),
            })),
          };
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          })),
        };
      }),
    } as unknown as Db;

    try {
      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = { type: "none", source: "none" };
        next();
      });
      app.use(
        "/health",
        healthRoutes(db, {
          deploymentMode: "authenticated",
          deploymentExposure: "private",
          authReady: true,
          companyDeletionEnabled: true,
        }),
      );

      const res = await request(app)
        .get("/health")
        .set("X-Paperclip-Dev-Server-Status-Token", "dev-runner-token");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: "ok",
        deploymentMode: "authenticated",
        bootstrapStatus: "ready",
        bootstrapInviteActive: false,
        devServer: {
          enabled: true,
          restartRequired: true,
          reason: "backend_changes",
          lastChangedAt: "2026-03-20T12:00:00.000Z",
          changedPathCount: 1,
          changedPathsSample: ["server/src/routes/health.ts"],
          pendingMigrations: [],
          autoRestartEnabled: true,
          activeRunCount: 0,
          waitingForIdle: false,
          lastRestartAt: "2026-03-20T11:30:00.000Z",
        },
      });
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
      if (previousToken === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN = previousToken;
      }
    }
  });
});
