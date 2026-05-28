import { and, eq, isNull, or, gt } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agentDelegateGrants } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, assertAuthenticated } from "./authz.js";
import { logActivity } from "../services/index.js";

const createDelegateGrantSchema = z.object({
  delegateAgentId: z.string().uuid(),
  delegateCompanyId: z.string().uuid(),
  scopes: z.array(z.string()).min(1).default(["read", "write"]),
  expiresAt: z.string().datetime().nullable().optional(),
});

export function delegateGrantRoutes(db: Db) {
  const router = Router();

  // POST /api/companies/:companyId/delegate-grants
  // GC condition: agents MUST be rejected with 403.
  router.post(
    "/companies/:companyId/delegate-grants",
    validate(createDelegateGrantSchema),
    async (req, res) => {
      assertAuthenticated(req);
      if (req.actor.type === "agent") {
        throw forbidden("Agents cannot create delegate grants");
      }
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId, db);

      const { delegateAgentId, delegateCompanyId, scopes, expiresAt } = req.body as z.infer<typeof createDelegateGrantSchema>;
      const grantedByUserId = req.actor.userId ?? "board";

      const [created] = await db
        .insert(agentDelegateGrants)
        .values({
          hostCompanyId: companyId,
          delegateAgentId,
          delegateCompanyId,
          scopes,
          grantedByUserId,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        })
        .returning();

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: grantedByUserId,
        action: "delegate_grant.created",
        entityType: "delegate_grant",
        entityId: created.id,
        details: {
          delegateAgentId,
          delegateCompanyId,
          scopes,
          expiresAt: expiresAt ?? null,
        },
      });

      res.status(201).json(created);
    },
  );

  // GET /api/companies/:companyId/delegate-grants
  router.get("/companies/:companyId/delegate-grants", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId, db);

    const now = new Date();
    const grants = await db
      .select()
      .from(agentDelegateGrants)
      .where(
        and(
          eq(agentDelegateGrants.hostCompanyId, companyId),
          isNull(agentDelegateGrants.revokedAt),
          or(
            isNull(agentDelegateGrants.expiresAt),
            gt(agentDelegateGrants.expiresAt, now),
          ),
        ),
      )
      .orderBy(agentDelegateGrants.createdAt);

    res.json(grants);
  });

  // DELETE /api/companies/:companyId/delegate-grants/:grantId
  router.delete("/companies/:companyId/delegate-grants/:grantId", async (req, res) => {
    assertAuthenticated(req);
    if (req.actor.type === "agent") {
      throw forbidden("Agents cannot revoke delegate grants");
    }
    const companyId = req.params.companyId as string;
    const grantId = req.params.grantId as string;
    await assertCompanyAccess(req, companyId, db);

    const [existing] = await db
      .select({ id: agentDelegateGrants.id, revokedAt: agentDelegateGrants.revokedAt, delegateAgentId: agentDelegateGrants.delegateAgentId, delegateCompanyId: agentDelegateGrants.delegateCompanyId })
      .from(agentDelegateGrants)
      .where(
        and(
          eq(agentDelegateGrants.id, grantId),
          eq(agentDelegateGrants.hostCompanyId, companyId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw notFound("Delegate grant not found");
    }
    if (existing.revokedAt !== null) {
      res.status(409).json({ error: "Grant already revoked" });
      return;
    }

    const revokedByUserId = req.actor.userId ?? "board";
    const [revoked] = await db
      .update(agentDelegateGrants)
      .set({ revokedAt: new Date(), revokedByUserId, updatedAt: new Date() })
      .where(eq(agentDelegateGrants.id, grantId))
      .returning();

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: revokedByUserId,
      action: "delegate_grant.revoked",
      entityType: "delegate_grant",
      entityId: grantId,
      details: {
        delegateAgentId: existing.delegateAgentId,
        delegateCompanyId: existing.delegateCompanyId,
      },
    });

    res.json(revoked);
  });

  // GET /api/companies/:companyId/delegate-grants/by-agent/:agentId
  router.get("/companies/:companyId/delegate-grants/by-agent/:agentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await assertCompanyAccess(req, companyId, db);

    const now = new Date();
    const grants = await db
      .select()
      .from(agentDelegateGrants)
      .where(
        and(
          eq(agentDelegateGrants.hostCompanyId, companyId),
          eq(agentDelegateGrants.delegateAgentId, agentId),
          isNull(agentDelegateGrants.revokedAt),
          or(
            isNull(agentDelegateGrants.expiresAt),
            gt(agentDelegateGrants.expiresAt, now),
          ),
        ),
      )
      .orderBy(agentDelegateGrants.createdAt);

    res.json(grants);
  });

  return router;
}
