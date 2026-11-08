import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { chatChannelRoutes } from "../routes/chat-channels.js";
import type { ChatChannelService } from "../services/chat-channels.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const endpointId = "33333333-3333-4333-8333-333333333333";
const conversationId = "44444444-4444-4444-8444-444444444444";
const publicationId = "55555555-5555-4555-8555-555555555555";
const grantId = "66666666-6666-4666-8666-666666666666";

function app() {
  const databaseRead = vi.fn();
  const query: Record<string, unknown> = {
    then: (_resolve: unknown, reject: (error: Error) => void) => {
      databaseRead();
      reject(new Error("database read"));
    },
  };
  for (const step of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin"]) query[step] = () => query;
  const db = { select: () => query, transaction: () => query, execute: () => query } as unknown as Db;
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId: "test-board-user", companyIds: [companyId], isInstanceAdmin: true };
    next();
  });
  instance.use("/api", chatChannelRoutes(db, {
    service: {} as unknown as ChatChannelService,
    heartbeat: { wakeup: vi.fn() },
  }));
  instance.use(errorHandler);
  return { instance, databaseRead };
}

const padded = (id: string) => encodeURIComponent(` ${id} `);

describe("chat channel route ids with the real connection management guard", () => {
  it.each([
    ["get", `/api/chat-endpoints/${padded(endpointId)}`],
    ["delete", `/api/companies/${companyId}/chat-slack/manager-grants/${padded(grantId)}`],
    ["get", `/api/chat-endpoints/${endpointId}/conversations/${padded(conversationId)}/publications/${publicationId}/status`],
  ] as const)("rejects a padded id on %s %s with 400 before a database read", async (method, path) => {
    const { instance, databaseRead } = app();
    const response = await request(instance)[method](path).expect(400);
    expect(response.body.error).toBe("Expected a resource identifier");
    expect(databaseRead).not.toHaveBeenCalled();
  });
});
