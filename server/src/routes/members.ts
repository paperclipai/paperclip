import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships, authUsers, userActivityLog, companies } from "@paperclipai/db";
import { badRequest, forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { requireRole, meetsMinRole, type CompanyRole } from "../middleware/role-guard.js";
import { logActivity } from "../services/index.js";
import { companyEmailService } from "../services/company-email.js";
import { logger } from "../middleware/logger.js";

const VALID_ROLES: CompanyRole[] = ["owner", "admin", "operator", "viewer"];

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

/**
 * Send an invitation email to a new member via the company's configured email service.
 * Fails silently — the invitation record is created regardless.
 */
async function sendInvitationEmail(
  db: Db,
  companyId: string,
  recipientEmail: string,
  role: string,
  inviterName: string | null,
  isExistingUser: boolean,
) {
  try {
    const emailSvc = companyEmailService(db);
    const settings = await emailSvc.getSettings(companyId);
    if (!settings?.enabled || !settings?.agentmailEmail) {
      logger.info({ companyId, recipientEmail }, "Skipping invite email — company email not configured");
      return;
    }

    const company = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);

    const companyName = company?.name ?? "the company";
    const roleName = ROLE_LABELS[role] ?? role;
    const inviterLine = inviterName ? `${inviterName} has invited you` : "You have been invited";
    const baseUrl = process.env.PAPERCLIP_PUBLIC_URL ?? "http://127.0.0.1:3100";

    const actionUrl = isExistingUser
      ? baseUrl
      : `${baseUrl}/auth?mode=sign_up&email=${encodeURIComponent(recipientEmail)}`;
    const actionLabel = isExistingUser ? "Open Dashboard" : "Create Your Account";
    const actionNote = isExistingUser
      ? "You can now access the company from your dashboard."
      : "Create your account to join the company. Your invitation will be activated automatically.";

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 0;">
        <h2 style="margin: 0 0 8px; font-size: 20px; font-weight: 600; color: #111;">You're invited to join ${companyName}</h2>
        <p style="margin: 0 0 24px; font-size: 14px; color: #555; line-height: 1.6;">
          ${inviterLine} to join <strong>${companyName}</strong> as a <strong>${roleName}</strong>.
        </p>
        <p style="margin: 0 0 24px; font-size: 14px; color: #555; line-height: 1.6;">
          ${actionNote}
        </p>
        <a href="${actionUrl}" style="display: inline-block; padding: 10px 24px; background: #111; color: #fff; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 500;">
          ${actionLabel}
        </a>
        <p style="margin: 24px 0 0; font-size: 12px; color: #999;">
          If you didn't expect this invitation, you can safely ignore this email.
        </p>
      </div>
    `;

    await emailSvc.sendMessage(companyId, {
      to: recipientEmail,
      subject: `You're invited to join ${companyName}`,
      text: `${inviterLine} to join ${companyName} as a ${roleName}. ${actionNote} Visit: ${actionUrl}`,
      html,
    });

    logger.info({ companyId, recipientEmail, role }, "Invitation email sent");
  } catch (err) {
    logger.warn({ err, companyId, recipientEmail }, "Failed to send invitation email");
  }
}

export function memberRoutes(db: Db) {
  const router = Router({ mergeParams: true });

  // GET /api/companies/:companyId/members
  // List all members with their user info
  router.get("/", requireRole(db, "viewer"), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rows = await db
      .select({
        id: companyMemberships.id,
        companyId: companyMemberships.companyId,
        principalType: companyMemberships.principalType,
        principalId: companyMemberships.principalId,
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
        role: companyMemberships.role,
        invitedBy: companyMemberships.invitedBy,
        joinedAt: companyMemberships.joinedAt,
        createdAt: companyMemberships.createdAt,
        updatedAt: companyMemberships.updatedAt,
        userName: authUsers.name,
        userEmail: authUsers.email,
        userImage: authUsers.image,
      })
      .from(companyMemberships)
      .leftJoin(
        authUsers,
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, authUsers.id),
        ),
      )
      .where(eq(companyMemberships.companyId, companyId))
      .orderBy(sql`${companyMemberships.createdAt} asc`);

    // Enrich pending invites that don't have a joined user yet
    const enriched = rows.map((row) => {
      if (!row.userName && !row.userEmail && row.principalId?.startsWith("pending:")) {
        const pendingEmail = row.principalId.replace("pending:", "");
        return {
          ...row,
          userName: pendingEmail.split("@")[0],
          userEmail: pendingEmail,
          pendingSignup: true,
        };
      }
      return row;
    });

    res.json(enriched);
  });

  // POST /api/companies/:companyId/members/invite
  // Invite a user by email
  router.post("/invite", requireRole(db, "admin"), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { email, role } = req.body as { email?: string; role?: string };
    if (!email || typeof email !== "string" || !email.includes("@")) {
      throw badRequest("A valid email address is required");
    }

    const assignRole: CompanyRole = VALID_ROLES.includes(role as CompanyRole)
      ? (role as CompanyRole)
      : "viewer";

    // Admins cannot invite owners
    const actor = getActorInfo(req);
    const invitedByUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor.actorId) ? actor.actorId : null;
    if (assignRole === "owner" && !req.actor.isInstanceAdmin && req.actor.source !== "local_implicit") {
      // Check if the requesting user is an owner
      const callerMembership = await db
        .select({ role: companyMemberships.role })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, actor.actorId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!callerMembership || callerMembership.role !== "owner") {
        throw forbidden("Only owners can invite new owners");
      }
    }

    // Look up the user by email
    const normalizedEmail = email.toLowerCase().trim();
    const user = await db
      .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.email, normalizedEmail))
      .then((rows) => rows[0] ?? null);

    // If user exists, check for existing membership
    if (user) {
      const existing = await db
        .select({ id: companyMemberships.id, status: companyMemberships.status })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, user.id),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (existing && existing.status === "active") {
        throw badRequest("User is already an active member of this company");
      }

      let membership;
      if (existing) {
        // Re-activate
        membership = await db
          .update(companyMemberships)
          .set({
            status: "active",
            role: assignRole,
            invitedBy: invitedByUuid,
            joinedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(companyMemberships.id, existing.id))
          .returning()
          .then((rows) => rows[0]);
      } else {
        membership = await db
          .insert(companyMemberships)
          .values({
            companyId,
            principalType: "user",
            principalId: user.id,
            status: "active",
            membershipRole: "member",
            role: assignRole,
            joinedAt: new Date(),
          })
          .returning()
          .then((rows) => rows[0]);
      }

      await db.insert(userActivityLog).values({
        companyId,
        userId: actor.actorId,
        action: "member.invited",
        resourceType: "member",
        resourceId: membership?.id,
        metadata: { invitedEmail: normalizedEmail, role: assignRole, invitedUserId: user.id },
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "member.invited",
        entityType: "member",
        entityId: user.id,
        details: { email: normalizedEmail, role: assignRole },
      });

      // Send invitation email (non-blocking)
      void sendInvitationEmail(db, companyId, normalizedEmail, assignRole, user.name, true);

      res.status(201).json({
        ...membership,
        userName: user.name,
        userEmail: user.email,
      });
      return;
    }

    // User doesn't exist yet — create a pending invitation.
    // Use the email as a placeholder principalId (prefixed) so we can match later on signup.
    const pendingPrincipalId = `pending:${normalizedEmail}`;

    // Check for existing pending invite
    const existingPending = await db
      .select({ id: companyMemberships.id, status: companyMemberships.status })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, pendingPrincipalId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existingPending && existingPending.status === "invited") {
      throw badRequest(`An invitation has already been sent to ${normalizedEmail}`);
    }

    let membership;
    if (existingPending) {
      // Re-invite (was previously rejected/removed)
      membership = await db
        .update(companyMemberships)
        .set({
          status: "invited",
          role: assignRole,
          invitedBy: invitedByUuid,
          updatedAt: new Date(),
        })
        .where(eq(companyMemberships.id, existingPending.id))
        .returning()
        .then((rows) => rows[0]);
    } else {
      membership = await db
        .insert(companyMemberships)
        .values({
          companyId,
          principalType: "user",
          principalId: pendingPrincipalId,
          status: "invited",
          membershipRole: "member",
          role: assignRole,
        })
        .returning()
        .then((rows) => rows[0]);
    }

    await db.insert(userActivityLog).values({
      companyId,
      userId: actor.actorId,
      action: "member.invited",
      resourceType: "member",
      resourceId: membership?.id,
      metadata: { invitedEmail: normalizedEmail, role: assignRole, pending: true },
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "member.invited",
      entityType: "member",
      entityId: pendingPrincipalId,
      details: { email: normalizedEmail, role: assignRole, pending: true },
    });

    // Send invitation email with signup link (non-blocking)
    void sendInvitationEmail(db, companyId, normalizedEmail, assignRole, null, false);

    res.status(201).json({
      ...membership,
      userName: normalizedEmail.split("@")[0],
      userEmail: normalizedEmail,
      pendingSignup: true,
    });
  });

  // PATCH /api/companies/:companyId/members/:userId/role
  // Change a member's role
  router.patch("/:userId/role", requireRole(db, "admin"), async (req, res) => {
    const companyId = req.params.companyId as string;
    const targetUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);

    const { role } = req.body as { role?: string };
    if (!role || !VALID_ROLES.includes(role as CompanyRole)) {
      throw badRequest(`Invalid role. Must be one of: ${VALID_ROLES.join(", ")}`);
    }

    const newRole = role as CompanyRole;
    const actor = getActorInfo(req);

    // Get the target membership
    const target = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, targetUserId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!target) {
      throw notFound("Member not found");
    }

    // Get the caller's role (unless instance admin / local)
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
      const callerMembership = await db
        .select({ role: companyMemberships.role })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, actor.actorId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!callerMembership) {
        throw forbidden("You are not a member of this company");
      }

      // Cannot promote someone to a role >= your own (unless you're owner)
      if (callerMembership.role !== "owner" && meetsMinRole(newRole, callerMembership.role as CompanyRole)) {
        throw forbidden("You cannot assign a role equal to or higher than your own");
      }

      // Cannot change the role of someone with a role >= yours (unless you're owner)
      if (callerMembership.role !== "owner" && meetsMinRole(target.role, callerMembership.role as CompanyRole)) {
        throw forbidden("You cannot change the role of a member with equal or higher rank");
      }
    }

    const updated = await db
      .update(companyMemberships)
      .set({ role: newRole, updatedAt: new Date() })
      .where(eq(companyMemberships.id, target.id))
      .returning()
      .then((rows) => rows[0]);

    await db.insert(userActivityLog).values({
      companyId,
      userId: actor.actorId,
      action: "member.role_changed",
      resourceType: "member",
      resourceId: target.id,
      metadata: { targetUserId, oldRole: target.role, newRole },
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "member.role_changed",
      entityType: "member",
      entityId: targetUserId,
      details: { oldRole: target.role, newRole },
    });

    res.json(updated);
  });

  // DELETE /api/companies/:companyId/members/:userId
  // Remove a member from the company
  router.delete("/:userId", requireRole(db, "admin"), async (req, res) => {
    const companyId = req.params.companyId as string;
    const targetUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);

    // Cannot remove yourself
    if (actor.actorId === targetUserId) {
      throw badRequest("You cannot remove yourself. Transfer ownership first.");
    }

    const target = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, targetUserId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!target) {
      throw notFound("Member not found");
    }

    // Only owners can remove admins
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
      const callerMembership = await db
        .select({ role: companyMemberships.role })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, actor.actorId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!callerMembership) {
        throw forbidden("You are not a member of this company");
      }

      // Cannot remove someone with a role >= yours (unless you're owner)
      if (callerMembership.role !== "owner" && meetsMinRole(target.role, callerMembership.role as CompanyRole)) {
        throw forbidden("You cannot remove a member with equal or higher rank");
      }
    }

    // Owners cannot be removed (must transfer ownership first)
    if (target.role === "owner") {
      throw forbidden("Cannot remove an owner. Transfer ownership first.");
    }

    await db
      .update(companyMemberships)
      .set({ status: "removed", updatedAt: new Date() })
      .where(eq(companyMemberships.id, target.id));

    await db.insert(userActivityLog).values({
      companyId,
      userId: actor.actorId,
      action: "member.removed",
      resourceType: "member",
      resourceId: target.id,
      metadata: { targetUserId, role: target.role },
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "member.removed",
      entityType: "member",
      entityId: targetUserId,
      details: { role: target.role },
    });

    res.json({ ok: true });
  });

  return router;
}
