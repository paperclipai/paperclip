import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { authUsers, invites, workspaceRuntimeServices } from "@paperclipai/db";
import { badRequest, forbidden, unauthorized } from "../errors.js";
import { accessService, companyService, logActivity, secretService } from "../services/index.js";

const INVITE_TOKEN_PREFIX = "pcp_invite_";
const INVITE_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const INVITE_TOKEN_SUFFIX_LENGTH = 10;
const INVITE_TOKEN_MAX_RETRIES = 8;

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return value;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createInviteToken() {
  const bytes = randomBytes(INVITE_TOKEN_SUFFIX_LENGTH);
  let suffix = "";
  for (let idx = 0; idx < INVITE_TOKEN_SUFFIX_LENGTH; idx += 1) {
    suffix += INVITE_TOKEN_ALPHABET[bytes[idx]! % INVITE_TOKEN_ALPHABET.length];
  }
  return `${INVITE_TOKEN_PREFIX}${suffix}`;
}

function tokenFromRequest(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1].trim();
  return header.trim();
}

function equalTokens(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function assertInternalAuth(req: Request) {
  const expected =
    process.env.PAPERCLIP_SAAS_CONTROL_TOKEN?.trim() ??
    process.env.SAAS_CONTROL_TOKEN?.trim() ??
    "";
  if (!expected) throw forbidden("SaaS control token is not configured");
  const provided = tokenFromRequest(req);
  if (!provided) throw unauthorized("SaaS control token is required");
  if (!equalTokens(expected, provided)) throw unauthorized("Invalid SaaS control token");
}

async function createCompanyInvite(input: {
  db: Db;
  companyId: string;
  allowedJoinTypes: "human" | "agent" | "both";
  defaultsPayload: Record<string, unknown> | null;
  ttlMinutes: number;
  invitedByUserId: string | null;
}) {
  const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
  let created: typeof invites.$inferSelect | null = null;
  let plainToken: string | null = null;

  for (let attempt = 0; attempt < INVITE_TOKEN_MAX_RETRIES; attempt += 1) {
    const token = createInviteToken();
    const tokenHash = hashToken(token);
    try {
      created = await input.db
        .insert(invites)
        .values({
          companyId: input.companyId,
          inviteType: "company_join",
          tokenHash,
          allowedJoinTypes: input.allowedJoinTypes,
          defaultsPayload: input.defaultsPayload,
          expiresAt,
          invitedByUserId: input.invitedByUserId,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      plainToken = token;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const constraint = typeof error === "object" && error !== null && "constraint" in error
        ? (error as { constraint?: string }).constraint
        : undefined;
      if (constraint === "invites_token_hash_unique_idx" || message.includes("invites_token_hash_unique_idx")) {
        continue;
      }
      throw error;
    }
  }

  if (!created || !plainToken) {
    throw badRequest("Failed to create invite token. Try again.");
  }

  return {
    invite: created,
    token: plainToken,
    invitePath: `/invite/${plainToken}`,
    inviteApiPath: `/api/invites/${plainToken}`,
  };
}

export function internalSaasControlRoutes(db: Db) {
  const router = Router();
  const companies = companyService(db);
  const access = accessService(db);
  const secrets = secretService(db);

  router.post("/companies/provision", async (req, res) => {
    assertInternalAuth(req);
    const body = parseRecord(req.body);
    if (!body) throw badRequest("Request body must be an object");

    const companyName = parseNonEmptyString(body.companyName);
    if (!companyName) throw badRequest("companyName is required");
    const companyDescription = parseNonEmptyString(body.companyDescription);
    const ownerEmail = parseNonEmptyString(body.ownerEmail);
    const allowedJoinTypesRaw = parseNonEmptyString(body.allowedJoinTypes) ?? "human";
    const allowedJoinTypes: "human" | "agent" | "both" =
      allowedJoinTypesRaw === "agent" || allowedJoinTypesRaw === "both"
      ? allowedJoinTypesRaw
      : "human";
    const inviteTtlMinutes = Math.max(5, Math.min(60 * 24 * 7, parseNumber(body.inviteTtlMinutes, 60 * 24)));
    const defaultsPayload = parseRecord(body.defaultsPayload);
    const monthlyBudgetCents = Math.max(0, parseNumber(body.monthlyBudgetCents, 50_00));

    const company = await companies.create({
      name: companyName,
      description: companyDescription ?? `Provisioned by SaaS control at ${new Date().toISOString()}`,
      budgetMonthlyCents: monthlyBudgetCents,
      requireBoardApprovalForNewAgents: true,
    });

    let linkedOwnerUserId: string | null = null;
    if (ownerEmail) {
      const existingUser = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.email, ownerEmail))
        .then((rows) => rows[0] ?? null);
      if (existingUser) {
        linkedOwnerUserId = existingUser.id;
        await access.ensureMembership(company.id, "user", existingUser.id, "owner", "active");
      }
    }

    const invite = await createCompanyInvite({
      db,
      companyId: company.id,
      allowedJoinTypes,
      defaultsPayload,
      ttlMinutes: inviteTtlMinutes,
      invitedByUserId: linkedOwnerUserId,
    });

    const starterAgentTemplate = {
      name: "Starter CEO",
      role: "ceo",
      adapterType: "openclaw_gateway",
      budgetMonthlyCents: Math.max(10_00, Math.floor(monthlyBudgetCents * 0.2)),
      heartbeat: {
        enabled: true,
        intervalSec: 300,
        wakeOnAssignment: true,
        wakeOnOnDemand: true,
        wakeOnAutomation: true,
      },
      notes: "Conservative defaults for invite-only beta.",
    };

    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: "saas-control",
      action: "company.provisioned",
      entityType: "company",
      entityId: company.id,
      details: {
        ownerEmail: ownerEmail ?? null,
        linkedOwnerUserId,
        inviteId: invite.invite.id,
      },
    });

    res.status(201).json({
      company,
      owner: {
        email: ownerEmail ?? null,
        linkedUserId: linkedOwnerUserId,
      },
      invite: {
        id: invite.invite.id,
        token: invite.token,
        invitePath: invite.invitePath,
        inviteApiPath: invite.inviteApiPath,
        expiresAt: invite.invite.expiresAt,
      },
      starterAgentTemplate,
    });
  });

  router.post("/companies/:companyId/provision-runner", async (req, res) => {
    assertInternalAuth(req);
    const companyId = req.params.companyId as string;
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const body = parseRecord(req.body) ?? {};
    const machineId = parseNonEmptyString(body.machineId) ?? randomUUID();
    const region = parseNonEmptyString(body.region) ?? "iad";
    const gatewayUrl = parseNonEmptyString(body.gatewayUrl) ?? `wss://${machineId}.fly.dev/gateway`;
    const gatewayToken = parseNonEmptyString(body.gatewayToken);
    const paperclipApiUrl =
      parseNonEmptyString(body.paperclipApiUrl) ??
      process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.replace(/\/+$/, "") ??
      process.env.PAPERCLIP_PUBLIC_URL?.replace(/\/+$/, "") ??
      "http://localhost:3100";

    const existing = await db
      .select()
      .from(workspaceRuntimeServices)
      .where(
        and(
          eq(workspaceRuntimeServices.companyId, companyId),
          eq(workspaceRuntimeServices.scopeType, "company"),
          eq(workspaceRuntimeServices.serviceName, "openclaw-gateway"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    const now = new Date();
    const serviceId = existing?.id ?? randomUUID();
    if (existing) {
      await db
        .update(workspaceRuntimeServices)
        .set({
          status: "running",
          lifecycle: "shared",
          scopeId: companyId,
          url: gatewayUrl,
          provider: "adapter_managed",
          providerRef: machineId,
          reuseKey: `company:${companyId}:openclaw-gateway`,
          healthStatus: "unknown",
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(eq(workspaceRuntimeServices.id, existing.id));
    } else {
      await db.insert(workspaceRuntimeServices).values({
        id: serviceId,
        companyId,
        scopeType: "company",
        scopeId: companyId,
        serviceName: "openclaw-gateway",
        status: "running",
        lifecycle: "shared",
        provider: "adapter_managed",
        providerRef: machineId,
        reuseKey: `company:${companyId}:openclaw-gateway`,
        url: gatewayUrl,
        healthStatus: "unknown",
      });
    }

    if (gatewayToken) {
      const existingGatewaySecret = await secrets.getByName(companyId, "OPENCLAW_GATEWAY_TOKEN");
      if (existingGatewaySecret) {
        await secrets.rotate(
          existingGatewaySecret.id,
          { value: gatewayToken },
          { userId: "saas-control", agentId: null },
        );
      } else {
        await secrets.create(
          companyId,
          {
            name: "OPENCLAW_GATEWAY_TOKEN",
            provider: "local_encrypted",
            value: gatewayToken,
            description: "Gateway token used by dedicated OpenClaw runner",
          },
          { userId: "saas-control", agentId: null },
        );
      }
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: "saas-control",
      action: "runner.provisioned",
      entityType: "runtime_service",
      entityId: serviceId,
      details: {
        machineId,
        region,
        gatewayUrl,
      },
    });

    res.status(201).json({
      runner: {
        id: serviceId,
        companyId,
        machineId,
        region,
        gatewayUrl,
        status: "running",
      },
      openclawGatewayDefaults: {
        adapterType: "openclaw_gateway",
        agentDefaultsPayload: {
          url: gatewayUrl,
          paperclipApiUrl,
          headers: gatewayToken ? { "x-openclaw-token": gatewayToken } : { "x-openclaw-token": "<set-token>" },
          sessionKeyStrategy: "agent",
          waitTimeoutMs: 90_000,
        },
      },
    });
  });

  router.post("/companies/:companyId/deactivate", async (req, res) => {
    assertInternalAuth(req);
    const companyId = req.params.companyId as string;
    const body = parseRecord(req.body) ?? {};
    const pauseReason = parseNonEmptyString(body.pauseReason) ?? "Deactivated by SaaS control";
    const deprovisionRunner = parseBoolean(body.deprovisionRunner, true);

    const updatedCompany = await companies.update(companyId, {
      status: "paused",
      pauseReason,
      pausedAt: new Date(),
    });
    if (!updatedCompany) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    let runnerUpdates = 0;
    if (deprovisionRunner) {
      const activeRunnerIds = await db
        .select({ id: workspaceRuntimeServices.id })
        .from(workspaceRuntimeServices)
        .where(
          and(
            eq(workspaceRuntimeServices.companyId, companyId),
            eq(workspaceRuntimeServices.scopeType, "company"),
            eq(workspaceRuntimeServices.serviceName, "openclaw-gateway"),
          ),
        )
        .then((rows) => rows.map((row) => row.id));
      runnerUpdates = activeRunnerIds.length;
      if (runnerUpdates > 0) {
        await db
        .update(workspaceRuntimeServices)
        .set({
          status: "stopped",
          stoppedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(workspaceRuntimeServices.companyId, companyId), inArray(workspaceRuntimeServices.id, activeRunnerIds)));
      }
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: "saas-control",
      action: "company.deactivated",
      entityType: "company",
      entityId: companyId,
      details: {
        pauseReason,
        deprovisionRunner,
        runnerUpdates,
      },
    });

    res.json({
      ok: true,
      companyId,
      companyStatus: updatedCompany.status,
      pauseReason,
      runnerUpdates,
    });
  });

  return router;
}
