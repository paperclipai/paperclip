import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  chatEndpoints,
  chatEndpointResources,
  chatGitHubRegistrations,
  companies,
  companyMemberships,
  type Db,
} from "@paperclipai/db";
import type { GitHubAppRegistrationInput } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { githubBotRequest } from "./chat-github-client.js";
import { logActivity } from "./activity-log.js";

const digest = (state: string) =>
  createHash("sha256").update(state).digest("hex");
const httpsOrigin = (input: string | null) => {
  if (!input)
    throw badRequest(
      "A publicly reachable HTTPS address is required before registering a GitHub App",
    );
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw badRequest(
      "Use a trusted public HTTPS origin for GitHub registration",
    );
  return url.origin;
};

export function githubChatRegistrationService(
  db: Db,
  options: {
    publicOrigin: () => string | null;
    webhookOrigin: () => string | null;
    fetch?: typeof fetch;
    storeApp: (
      endpointId: string,
      userId: string,
      app: {
        appId: string;
        privateKey: string;
        webhookSecret: string;
        slug: string;
        clientId?: string;
        clientSecret?: string;
      },
    ) => Promise<void>;
  },
) {
  async function start(
    endpointId: string,
    userId: string,
    input: string | GitHubAppRegistrationInput,
  ) {
    const {
      name,
      ownerType = "personal",
      ownerLogin,
    } = typeof input === "string" ? { name: input } : input;
    if (ownerType !== "personal" && ownerType !== "organization")
      throw badRequest("Choose a GitHub account type");
    if (
      ownerType === "organization" &&
      (!ownerLogin ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(ownerLogin))
    )
      throw badRequest("Enter the GitHub organization name");
    const origin = httpsOrigin(options.publicOrigin());
    const ingress = httpsOrigin(options.webhookOrigin());
    if (!name.trim() || name.length > 34)
      throw badRequest("Enter an App name with at most 34 characters");
    const [endpoint] = await db
      .select()
      .from(chatEndpoints)
      .where(
        and(
          eq(chatEndpoints.id, endpointId),
          eq(chatEndpoints.provider, "github"),
        ),
      );
    if (!endpoint || endpoint.status === "archived")
      throw notFound("GitHub bot not found");
    if (endpoint.botExternalId)
      throw conflict(
        "This bot already has a GitHub App. Reconnect its existing credentials.",
      );
    const [member] = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, endpoint.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      );
    if (!member || member.membershipRole === "viewer")
      throw forbidden("An active company member is required");
    const [company] = await db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, endpoint.companyId));
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    await db.transaction(async (tx) => {
      const [lockedEndpoint] = await tx
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpointId))
        .for("update");
      if (!lockedEndpoint || lockedEndpoint.status === "archived")
        throw notFound("GitHub bot not found");
      if (lockedEndpoint.botExternalId)
        throw conflict("This bot already has a GitHub App. Reconnect its existing credentials.");
      const [existingResource] = await tx
        .select({ id: chatEndpointResources.id })
        .from(chatEndpointResources)
        .where(eq(chatEndpointResources.endpointId, endpointId))
        .limit(1);
      if (!lockedEndpoint.setup.github?.repositorySelectionSaved && !existingResource)
        await tx.update(chatEndpoints).set({
          setup: sql`jsonb_set(${chatEndpoints.setup}, '{github}', coalesce(${chatEndpoints.setup}->'github', '{}'::jsonb) || '{"initialRepositoryImportPending":true}'::jsonb)`,
          updatedAt: new Date(),
        }).where(eq(chatEndpoints.id, endpointId));
      await tx
        .update(chatGitHubRegistrations)
        .set({ status: "failed", consumedAt: new Date() })
        .where(
          and(
            eq(chatGitHubRegistrations.endpointId, endpointId),
            eq(chatGitHubRegistrations.status, "pending"),
          ),
        );
      await tx.insert(chatGitHubRegistrations).values({
        companyId: endpoint.companyId,
        endpointId,
        userId,
        stateHash: digest(state),
        trustedOrigin: origin,
        ownerType,
        ownerLogin,
        appName: name.trim(),
        handoff: {
          cloudId: "",
          redemptionId: randomBytes(32).toString("base64url"),
          returnState: state,
        },
        expiresAt,
      });
      await logActivity(tx as unknown as Db, {
        companyId: endpoint.companyId,
        actorType: "user",
        actorId: userId,
        action: "chat_github.registration_started",
        entityType: "tool_connection",
        entityId: endpoint.connectionId,
        details: { endpointId, expiresAt: expiresAt.toISOString() },
      });
    });
    return manifest(endpoint, company!.issuePrefix, {
      trustedOrigin: origin,
      state,
      ownerType,
      ownerLogin,
      name: name.trim(),
      expiresAt,
    });
  }
  function manifest(
    endpoint: typeof chatEndpoints.$inferSelect,
    prefix: string,
    values: {
      trustedOrigin: string;
      state: string;
      ownerType: "personal" | "organization";
      ownerLogin?: string;
      name: string;
      expiresAt: Date;
    },
  ) {
    const {
      trustedOrigin: origin,
      state,
      ownerType,
      ownerLogin,
      name,
      expiresAt,
    } = values;
    const ingress = httpsOrigin(options.webhookOrigin());
    const registrationUrl = new URL(
      ownerType === "organization"
        ? `https://github.com/organizations/${encodeURIComponent(ownerLogin!)}/settings/apps/new`
        : "https://github.com/settings/apps/new",
    );
    registrationUrl.searchParams.set("state", state);
    return {
      expiresAt: expiresAt.toISOString(),
      registrationUrl: registrationUrl.toString(),
      manifest: {
        name,
        url: origin,
        public: false,
        hook_attributes: {
          url: `${ingress}/api/chat-webhooks/${endpoint.publicId}/github`,
          active: true,
        },
        redirect_url: `${origin}/api/chat-github/manifest/callback`,
        setup_url: `${origin}/${prefix}/apps/chat/connect?provider=github&resume=${endpoint.id}`,
        callback_urls: [`${origin}/api/chat-github/identity/callback`],
        setup_on_update: true,
        default_permissions: {
          contents: "read",
          issues: "write",
          metadata: "read",
          pull_requests: "write",
          checks: "write",
        },
        default_events: [
          "issues",
          "issue_comment",
          "pull_request_review_comment",
          "pull_request_review",
          "pull_request",
        ],
      },
    };
  }
  async function resumeRegistration(endpointId: string, userId: string) {
    const [session] = await db
      .select()
      .from(chatGitHubRegistrations)
      .where(
        and(
          eq(chatGitHubRegistrations.endpointId, endpointId),
          eq(chatGitHubRegistrations.status, "pending"),
        ),
      )
      .limit(1);
    if (
      !session?.handoff?.returnState ||
      session.handoff.cloudId ||
      session.userId !== userId ||
      session.expiresAt <= new Date() ||
      session.trustedOrigin !== httpsOrigin(options.publicOrigin())
    )
      throw conflict("Resume or recover the existing App registration");
    const [endpoint] = await db
      .select()
      .from(chatEndpoints)
      .where(
        and(
          eq(chatEndpoints.id, endpointId),
          eq(chatEndpoints.companyId, session.companyId),
        ),
      );
    const [company] = await db
      .select({ prefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, session.companyId));
    if (!endpoint || !company || !session.appName)
      throw notFound("GitHub registration not found");
    return manifest(endpoint, company.prefix, {
      trustedOrigin: session.trustedOrigin,
      state: session.handoff.returnState,
      ownerType: session.ownerType,
      ownerLogin: session.ownerLogin ?? undefined,
      name: session.appName,
      expiresAt: session.expiresAt,
    });
  }
  async function complete(state: string, code: string) {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !/^[a-zA-Z0-9_-]{1,256}$/.test(code)
    )
      throw badRequest("Invalid GitHub registration return");
    const origin = httpsOrigin(options.publicOrigin());
    // Claim before exchange. A timeout is intentionally not retried with a
    // new exchange: recovery must reconnect the App already created on GitHub.
    const [session] = await db
      .update(chatGitHubRegistrations)
      .set({ status: "exchanging", consumedAt: new Date() })
      .where(
        and(
          eq(chatGitHubRegistrations.stateHash, digest(state)),
          eq(chatGitHubRegistrations.status, "pending"),
          eq(chatGitHubRegistrations.trustedOrigin, origin),
          gt(chatGitHubRegistrations.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!session)
      throw conflict(
        "This GitHub registration expired or was already used. Resume setup to recover the existing App.",
      );
    try {
      const [member] = await db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, session.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, session.userId),
            eq(companyMemberships.status, "active"),
          ),
        );
      if (!member || member.membershipRole === "viewer")
        throw forbidden("The configuring member no longer has access");
      const app = await githubBotRequest<{
        id?: number;
        pem?: string;
        webhook_secret?: string;
        slug?: string;
        client_id?: string;
        client_secret?: string;
        owner?: { login?: string; type?: string };
      }>(
        options.fetch ?? fetch,
        null,
        `/app-manifests/${encodeURIComponent(code)}/conversions`,
        { method: "POST" },
      );
      if (
        !Number.isSafeInteger(app.id) ||
        !app.id ||
        !app.pem ||
        !app.webhook_secret ||
        !app.slug ||
        !/^[a-z0-9-]+$/.test(app.slug)
      )
        throw badRequest(
          "GitHub registration returned incomplete App credentials",
        );
      if (
        session.ownerType === "personal" &&
        app.owner?.type &&
        app.owner.type !== "User"
      )
        throw badRequest("GitHub returned an App owned by a different account");
      if (
        session.ownerType === "organization" &&
        (app.owner?.type !== "Organization" ||
          app.owner?.login?.toLowerCase() !== session.ownerLogin?.toLowerCase())
      )
        throw badRequest("GitHub returned an App owned by a different account");
      await options.storeApp(session.endpointId, session.userId, {
        appId: String(app.id),
        privateKey: app.pem,
        webhookSecret: app.webhook_secret,
        slug: app.slug,
        clientId: app.client_id,
        clientSecret: app.client_secret,
      });
      await db
        .update(chatGitHubRegistrations)
        .set({ status: "completed" })
        .where(eq(chatGitHubRegistrations.id, session.id));
      const [company] = await db
        .select({ issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, session.companyId));
      return `${origin}/${company!.issuePrefix}/apps/chat/connect?provider=github&resume=${session.endpointId}`;
    } catch (error) {
      await db
        .update(chatGitHubRegistrations)
        .set({ status: "failed" })
        .where(eq(chatGitHubRegistrations.id, session.id));
      throw error;
    }
  }
  return { start, complete, resumeRegistration };
}
