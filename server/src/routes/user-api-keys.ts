import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { userApiKeys } from "@paperclipai/db";
import { assertBoard } from "./authz.js";
import { unauthorized, badRequest, notFound } from "../errors.js";

function generatePat(): string {
  return `pclip_${randomBytes(16).toString("hex")}`;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function assertBoardUserId(req: Express.Request): string {
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw unauthorized();
  }
  return req.actor.userId;
}

export function userApiKeyRoutes(db: Db) {
  const router = Router();

  // POST /users/me/api-keys — create a new PAT
  router.post("/users/me/api-keys", async (req, res) => {
    assertBoard(req);
    const userId = assertBoardUserId(req);

    const { name } = req.body as { name?: string };
    if (!name || typeof name !== "string" || !name.trim()) {
      throw badRequest("name is required");
    }

    const key = generatePat();
    const keyPrefix = key.slice(0, 14); // "pclip_" + first 8 hex chars
    const keyHash = hashKey(key);

    const [created] = await db
      .insert(userApiKeys)
      .values({
        userId,
        name: name.trim(),
        keyPrefix,
        keyHash,
      })
      .returning({
        id: userApiKeys.id,
        name: userApiKeys.name,
        keyPrefix: userApiKeys.keyPrefix,
        createdAt: userApiKeys.createdAt,
      });

    res.status(201).json({
      id: created.id,
      name: created.name,
      key,
      keyPrefix: created.keyPrefix,
      createdAt: created.createdAt,
    });
  });

  // GET /users/me/api-keys — list all PATs for current user
  router.get("/users/me/api-keys", async (req, res) => {
    assertBoard(req);
    const userId = assertBoardUserId(req);

    const keys = await db
      .select({
        id: userApiKeys.id,
        name: userApiKeys.name,
        keyPrefix: userApiKeys.keyPrefix,
        lastUsedAt: userApiKeys.lastUsedAt,
        revokedAt: userApiKeys.revokedAt,
        expiresAt: userApiKeys.expiresAt,
        createdAt: userApiKeys.createdAt,
      })
      .from(userApiKeys)
      .where(eq(userApiKeys.userId, userId));

    res.json(keys);
  });

  // DELETE /users/me/api-keys/:keyId — revoke a PAT
  router.delete("/users/me/api-keys/:keyId", async (req, res) => {
    assertBoard(req);
    const userId = assertBoardUserId(req);
    const keyId = req.params.keyId as string;

    const [existing] = await db
      .select({ id: userApiKeys.id, userId: userApiKeys.userId, revokedAt: userApiKeys.revokedAt })
      .from(userApiKeys)
      .where(eq(userApiKeys.id, keyId));

    if (!existing) {
      throw notFound("API key not found");
    }

    if (existing.userId !== userId) {
      throw notFound("API key not found");
    }

    if (existing.revokedAt) {
      res.json({ revoked: true });
      return;
    }

    await db
      .update(userApiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(userApiKeys.id, keyId));

    res.json({ revoked: true });
  });

  return router;
}
