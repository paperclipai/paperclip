import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies } from "@paperclipai/db";
import { supportChatSessionSchema, type SupportChatCompany } from "@paperclipai/shared";
import { notFound, unauthorized } from "../errors.js";
import {
  computePlainEmailHash,
  resolveSupportChatConfig,
  type SupportChatRuntimeConfig,
} from "../services/support-chat.js";
import {
  ensurePlainTenant,
  plainTenantExternalId,
} from "../services/plain-tenant-sync.js";
import type { CloudInstanceEnv } from "../services/cloud-instance.js";
import { hasCompanyAccess } from "./authz.js";

const companyIdParamSchema = z.string().uuid();

/**
 * The support chat session route: the browser asks whether this instance
 * serves the Plain chat surface and, if so, receives the widget configuration
 * plus a narrow attested customer identity and — when the caller names a
 * company it is a member of — the current-company context.
 *
 * Fail-closed properties:
 * - 404 (`support_chat_disabled`) unless the server-owned config enables the
 *   surface — self-hosted instances answer 404 and load no vendor code.
 * - Board authentication required; agent/run actors get 401.
 * - Identity derives from the authenticated user row only. The only caller
 *   input is `?companyId=`, which selects among the caller's own memberships
 *   and can never alter the identity block or reference someone else's
 *   company: a malformed, foreign, or unknown id all collapse to
 *   `company: null` (no existence oracle).
 * - `emailHash` is only issued for a verified email, and the response is
 *   marked `Cache-Control: no-store` because the hash is a bearer credential
 *   for the customer's chat identity.
 * - Tenant context is only handed out after `ensurePlainTenant` confirmed the
 *   tenant exists in the Plain workspace (needs `PLAIN_API_KEY`); without it
 *   the company block still names the company but carries no tenant id, and
 *   the widget passes no tenant to Plain.
 */
export function supportChatRoutes(
  db: Db,
  opts: {
    runtimeEnv?: CloudInstanceEnv;
    nodeEnv?: string | undefined;
    /** Test seam for the Plain tenant upsert call. */
    tenantSyncFetch?: typeof fetch;
  } = {},
) {
  const router = Router();

  async function resolveCompanyContext(
    config: SupportChatRuntimeConfig,
    companyId: string,
  ): Promise<SupportChatCompany | null> {
    const company = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) return null;

    let tenantExternalId: string | null = null;
    if (config.tenantSyncApiKey) {
      const externalId = plainTenantExternalId(company.id);
      const ensured = await ensurePlainTenant({
        apiKey: config.tenantSyncApiKey,
        externalId,
        name: company.name,
        fetchImpl: opts.tenantSyncFetch,
      });
      if (ensured) tenantExternalId = externalId;
    }
    return { id: company.id, name: company.name, tenantExternalId };
  }

  router.get("/session", async (req, res) => {
    const config = resolveSupportChatConfig(
      opts.runtimeEnv ?? process.env,
      "nodeEnv" in opts ? opts.nodeEnv : process.env.NODE_ENV,
    );
    if (!config) {
      throw notFound("Support chat is not enabled on this instance", {
        code: "support_chat_disabled",
      });
    }

    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const user = await db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        emailVerified: authUsers.emailVerified,
      })
      .from(authUsers)
      .where(eq(authUsers.id, req.actor.userId))
      .then((rows) => rows[0] ?? null);

    if (!user) {
      throw unauthorized("Signed-in user not found");
    }

    // Attest identity only when every link in the chain holds: a signing
    // secret is configured, the user row carries an email, and that email is
    // verified. Otherwise the widget runs without `customerDetails` and
    // Plain's own email verification covers identity.
    const email = user.email?.trim() || null;
    const customer =
      config.emailHmacSecret && email && user.emailVerified
        ? {
            email,
            emailHash: computePlainEmailHash(config.emailHmacSecret, email),
            fullName: user.name?.trim() || null,
            externalId: user.id,
          }
        : null;

    // Current-company context: honored only for a well-formed id the actor is
    // actually a member of. Everything else — absent, malformed, foreign,
    // nonexistent — is the same `null`, so this parameter cannot be used to
    // probe company ids.
    const requestedCompanyId = companyIdParamSchema.safeParse(req.query.companyId);
    const company =
      requestedCompanyId.success && hasCompanyAccess(req, requestedCompanyId.data)
        ? await resolveCompanyContext(config, requestedCompanyId.data)
        : null;

    res.setHeader("Cache-Control", "no-store");
    res.json(
      supportChatSessionSchema.parse({
        provider: "plain",
        appId: config.appId,
        devPreview: config.devPreview,
        customer,
        company,
      }),
    );
  });

  return router;
}
