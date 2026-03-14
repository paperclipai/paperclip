import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, authAccounts } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import { hashPassword } from "better-auth/crypto";
import {
  createProvisionRouter,
  type ProvisionAdapter,
  type ProvisionRequest,
  type ProvisionResponse,
  type AdminUser,
  type AgentSpec,
  type CreatedAgent,
} from "@wopr-network/provision-server";
import { companyService, agentService, accessService, logActivity } from "../services/index.js";

/** Default model for hosted agents routed through the metered gateway. */
const DEFAULT_GATEWAY_MODEL = "anthropic/claude-sonnet-4-20250514";

/** Directory where we persist the OpenCode gateway provider config. */
const GATEWAY_CONFIG_DIR = path.join(process.env.PAPERCLIP_HOME ?? "/data", ".opencode-gateway");

/**
 * Write an opencode.json that configures our metered inference gateway as an
 * OpenAI-compatible provider.  We write it to a dedicated directory and pass
 * OPENCODE_CONFIG_DIR via the adapter env so OpenCode finds it regardless of
 * which workspace cwd the agent runs in (OpenCode only walks up to the nearest
 * .git boundary, which won't reach a parent config).
 */
async function ensureGatewayProviderConfig(gatewayUrl: string): Promise<void> {
  const configPath = path.join(GATEWAY_CONFIG_DIR, "opencode.json");
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      "paperclip-gateway": {
        npm: "@ai-sdk/openai-compatible",
        name: "Paperclip Gateway",
        options: {
          baseURL: gatewayUrl,
          apiKey: "{env:PAPERCLIP_GATEWAY_KEY}",
        },
        models: {
          [DEFAULT_GATEWAY_MODEL]: {
            name: "Claude Sonnet 4",
            limit: { context: 200000, output: 16384 },
          },
        },
      },
    },
    model: `paperclip-gateway/${DEFAULT_GATEWAY_MODEL}`,
  };
  await fs.mkdir(GATEWAY_CONFIG_DIR, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** Role → permission grants for member management. */
const ROLE_PERMISSIONS: Record<string, Array<{ permissionKey: string }>> = {
  owner: [
    { permissionKey: "agents:create" },
    { permissionKey: "agents:update" },
    { permissionKey: "agents:delete" },
    { permissionKey: "costs:view" },
    { permissionKey: "company:delete" },
    { permissionKey: "users:invite" },
    { permissionKey: "users:manage_permissions" },
    { permissionKey: "tasks:assign" },
    { permissionKey: "joins:approve" },
  ],
  admin: [
    { permissionKey: "agents:create" },
    { permissionKey: "agents:update" },
    { permissionKey: "agents:delete" },
    { permissionKey: "costs:view" },
    { permissionKey: "users:invite" },
    { permissionKey: "users:manage_permissions" },
    { permissionKey: "tasks:assign" },
    { permissionKey: "joins:approve" },
  ],
  member: [
    { permissionKey: "tasks:assign" },
  ],
};

/**
 * Paperclip adapter for the generic provision-server protocol.
 *
 * Maps generic provisioning operations to Paperclip's domain model:
 *   tenant → company
 *   agents → agents (opencode_local adapter routed through metered gateway)
 */
function createPaperclipAdapter(db: Db): ProvisionAdapter {
  const companies = companyService(db);
  const agents = agentService(db);
  const access = accessService(db);

  return {
    async createTenant(req: ProvisionRequest) {
      const company = await companies.create({
        name: req.tenantName,
        description: `wopr:${req.tenantId}`,
        budgetMonthlyCents: req.budgetCents ?? 0,
        requireBoardApprovalForNewAgents: false,
      });
      return { id: company.id, slug: company.issuePrefix };
    },

    async ensureUser(user: AdminUser) {
      const existing = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.id, user.id))
        .then((rows) => rows[0] ?? null);

      const now = new Date();
      if (!existing) {
        await db.insert(authUsers).values({
          id: user.id,
          name: user.name ?? user.email,
          email: user.email,
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      // Ensure a credential account exists so the admin can sign in.
      // Password is a random UUID — admin must use "forgot password" to set theirs.
      const existingAccount = await db
        .select({ id: authAccounts.id })
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, user.id), eq(authAccounts.providerId, "credential")))
        .then((rows) => rows[0] ?? null);

      if (!existingAccount) {
        const hash = await hashPassword(randomUUID());

        await db.insert(authAccounts).values({
          id: randomUUID(),
          accountId: user.id,
          providerId: "credential",
          userId: user.id,
          password: hash,
          createdAt: now,
          updatedAt: now,
        });
      }
    },

    async grantAccess(tenantEntityId: string, userId: string) {
      await access.ensureMembership(tenantEntityId, "user", userId, "owner", "active");
      await access.promoteInstanceAdmin(userId);
    },

    async seedAgents(
      tenantEntityId: string,
      specs: AgentSpec[],
      gateway: { url: string; apiKey: string },
    ): Promise<CreatedAgent[]> {
      // Ensure the gateway provider config exists so OpenCode can resolve
      // the "paperclip-gateway" provider at agent execution time.
      await ensureGatewayProviderConfig(gateway.url);

      const created: CreatedAgent[] = [];
      const nameToId = new Map<string, string>();

      // First pass: create agents with the opencode_local adapter.
      // The gateway key is passed via env so the AI SDK provider picks it up
      // through the {env:PAPERCLIP_GATEWAY_KEY} reference in opencode.json.
      for (const spec of specs) {
        if (!spec.name || !spec.role) continue;
        const agent = await agents.create(tenantEntityId, {
          name: spec.name,
          role: spec.role,
          title: spec.title ?? null,
          adapterType: "opencode_local",
          adapterConfig: {
            model: `paperclip-gateway/${DEFAULT_GATEWAY_MODEL}`,
            env: {
              PAPERCLIP_GATEWAY_KEY: gateway.apiKey,
              OPENCODE_CONFIG_DIR: GATEWAY_CONFIG_DIR,
            },
          },
          budgetMonthlyCents: spec.budgetMonthlyCents ?? 0,
          status: "idle",
        });
        created.push({ id: agent.id, name: agent.name, role: agent.role });
        nameToId.set(spec.name, agent.id);
      }

      // Second pass: wire reportsTo
      for (const spec of specs) {
        if (!spec.reportsTo) continue;
        const agentId = nameToId.get(spec.name);
        const managerId = nameToId.get(spec.reportsTo);
        if (agentId && managerId) {
          await agents.update(agentId, { reportsTo: managerId });
        }
      }

      return created;
    },

    async updateBudget(tenantEntityId: string, budgetCents: number) {
      await companies.update(tenantEntityId, { budgetMonthlyCents: budgetCents });
    },

    async updateAgentBudgets(tenantEntityId: string, perAgentCents: number) {
      const companyAgents = await agents.list(tenantEntityId);
      for (const agent of companyAgents) {
        await agents.update(agent.id, { budgetMonthlyCents: perAgentCents });
      }
    },

    async tenantExists(tenantEntityId: string) {
      const company = await companies.getById(tenantEntityId);
      return company != null;
    },

    async teardown(tenantEntityId: string) {
      await companies.remove(tenantEntityId);
    },

    async onProvisioned(req: ProvisionRequest, _result: ProvisionResponse) {
      await logActivity(db, {
        companyId: _result.tenantEntityId,
        actorType: "user",
        actorId: "wopr-platform",
        action: "company.provisioned",
        entityType: "company",
        entityId: _result.tenantEntityId,
        details: {
          tenantId: req.tenantId,
          adminUserId: req.adminUser.id,
          adminEmail: req.adminUser.email,
        },
      });
    },
  };
}

/**
 * Bearer-token auth guard reusing the same WOPR_PROVISION_SECRET
 * that the provision-server router checks.
 */
function requireProvisionSecret(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.WOPR_PROVISION_SECRET;
  if (!secret) {
    res.status(500).json({ error: "WOPR_PROVISION_SECRET not configured" });
    return;
  }
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/**
 * Create member management routes.
 *
 * These extend the provision protocol with fine-grained member
 * add / remove / change-role operations called by platform-core
 * when org membership changes.
 */
function createMemberRouter(db: Db): Router {
  const router = Router();
  const access = accessService(db);

  /**
   * Reuse the same ensureUser logic as the provision adapter.
   * Creates the auth user + credential account if they don't exist.
   */
  async function ensureAuthUser(user: { id: string; email: string; name?: string }) {
    const existing = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, user.id))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);

    const now = new Date();
    if (!existing) {
      await db.insert(authUsers).values({
        id: user.id,
        name: user.name ?? user.email,
        email: user.email,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    const existingAccount = await db
      .select({ id: authAccounts.id })
      .from(authAccounts)
      .where(and(eq(authAccounts.userId, user.id), eq(authAccounts.providerId, "credential")))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);

    if (!existingAccount) {
      const hash = await hashPassword(randomUUID());
      await db.insert(authAccounts).values({
        id: randomUUID(),
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: hash,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /** Map platform role to Paperclip membershipRole. admin → owner in Paperclip. */
  function mapRole(role: string): string {
    return role === "admin" || role === "owner" ? "owner" : "member";
  }

  /** Whether this role gets instance_admin promotion. */
  function isAdminRole(role: string): boolean {
    return role === "admin" || role === "owner";
  }

  // POST /members/add
  router.post("/members/add", requireProvisionSecret, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { companyId, user, role } = req.body as {
        companyId: string;
        user: { id: string; email: string; name?: string };
        role: string;
      };

      await ensureAuthUser(user);
      await access.ensureMembership(companyId, "user", user.id, mapRole(role), "active");

      if (isAdminRole(role)) {
        await access.promoteInstanceAdmin(user.id);
      }

      const grants = ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.member;
      await access.setPrincipalGrants(companyId, "user", user.id, grants as any, null);

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /members/remove
  router.post("/members/remove", requireProvisionSecret, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { companyId, userId } = req.body as { companyId: string; userId: string };

      await access.removeMembership(companyId, "user", userId);

      // Demote from instance_admin if user has no remaining company memberships
      const remaining = await access.listUserCompanyAccess(userId);
      if (remaining.length === 0) {
        await access.demoteInstanceAdmin(userId);
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /members/change-role
  router.post("/members/change-role", requireProvisionSecret, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { companyId, userId, role } = req.body as {
        companyId: string;
        userId: string;
        role: string;
      };

      await access.ensureMembership(companyId, "user", userId, mapRole(role), "active");

      if (isAdminRole(role)) {
        await access.promoteInstanceAdmin(userId);
      } else {
        await access.demoteInstanceAdmin(userId);
      }

      const grants = ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.member;
      await access.setPrincipalGrants(companyId, "user", userId, grants as any, null);

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Create the provisioning Express router for Paperclip.
 *
 * Mount at `/internal`:
 *   app.use("/internal", provisionRoutes(db));
 *
 * Provides:
 *   POST   /provision          — provision a new tenant
 *   PUT    /provision/budget   — update budget
 *   DELETE /provision          — teardown
 *   GET    /provision/health   — health check (no auth)
 *   POST   /members/add        — add a member to a company
 *   POST   /members/remove     — remove a member from a company
 *   POST   /members/change-role — change a member's role
 */
export function provisionRoutes(db: Db): Router {
  const router = Router();
  router.use(createProvisionRouter(createPaperclipAdapter(db)));
  router.use(createMemberRouter(db));
  return router;
}
