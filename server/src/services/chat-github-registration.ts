import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import {
  chatEndpoints,
  chatGitHubRegistrations,
  companies,
  companyMemberships,
  type Db,
} from "@paperclipai/db";
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
      },
    ) => Promise<void>;
  },
) {
  async function start(endpointId: string, userId: string, name: string) {
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
      await tx
        .select({ id: chatEndpoints.id })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpointId))
        .for("update");
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
    const resume = `${origin}/${company!.issuePrefix}/apps/chat/connect?provider=github&resume=${endpointId}`;
    const callback = new URL("/api/chat-github/manifest/callback", origin);
    const registrationUrl = new URL("https://github.com/settings/apps/new");
    registrationUrl.searchParams.set("state", state);
    return {
      expiresAt: expiresAt.toISOString(),
      registrationUrl: registrationUrl.toString(),
      manifest: {
        name: name.trim(),
        url: origin,
        public: false,
        hook_attributes: {
          url: `${ingress}/api/chat-webhooks/${endpoint.publicId}/github`,
          active: true,
        },
        redirect_url: callback.toString(),
        setup_url: resume,
        setup_on_update: true,
        default_permissions: {
          contents: "read",
          issues: "write",
          metadata: "read",
          pull_requests: "write",
          checks: "write",
        },
        default_events: [
          "issue_comment",
          "pull_request_review_comment",
          "pull_request",
        ],
      },
    };
  }
  async function complete(state: string, code: string) {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !/^[a-zA-Z0-9_-]{1,256}$/.test(code)
    )
      throw badRequest("Invalid GitHub registration return");
    const origin = httpsOrigin(options.publicOrigin());
    // Claim before exchange. A timeout is intentionally not retried with a
    // new exchange: the recovery UI must start a new single-use registration.
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
        "This GitHub registration expired or was already used. Resume setup and start registration again.",
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
      await options.storeApp(session.endpointId, session.userId, {
        appId: String(app.id),
        privateKey: app.pem,
        webhookSecret: app.webhook_secret,
        slug: app.slug,
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
  return { start, complete };
}
