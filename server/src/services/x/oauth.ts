import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import {
  chatActions,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  companyMemberships,
  toolOauthStates,
  type Db,
} from "@paperclipai/db";
import { z } from "zod";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { logActivity } from "../activity-log.js";
import { xExchange, xIdentity } from "./client.js";

type Endpoint = typeof chatEndpoints.$inferSelect;
export const X_BOT_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
];
const HUMAN_SCOPES = ["tweet.read", "users.read"];
const clientSchema = z
  .object({
    clientId: z.string().trim().min(1).max(300),
    clientSecret: z.string().min(1).max(1000),
  })
  .strict();
const revision = (c: Record<string, string>) =>
  createHash("sha256").update(`${c.clientId}\0${c.clientSecret}`).digest("hex");
export function xOAuthService(
  db: Db,
  hooks: {
    publicUrl(): string | null | undefined;
    credentials(endpoint: Endpoint): Promise<Record<string, string>>;
    store(
      endpoint: Endpoint,
      values: Record<string, string>,
      userId: string,
    ): Promise<void>;
    connect(
      endpoint: Endpoint,
      values: Record<string, string>,
      userId: string,
    ): Promise<unknown>;
  },
  fetchImpl = fetch,
) {
  function redirectUri() {
    const base = hooks.publicUrl();
    if (!base)
      throw badRequest("Configure public HTTPS delivery before connecting X");
    const url = new URL(base);
    if (url.protocol !== "https:" || url.port || url.username || url.password)
      throw badRequest(
        "X requires a public HTTPS URL without an explicit port",
      );
    return new URL("/api/x/oauth/callback", url.origin).toString();
  }
  async function endpoint(id: string) {
    const [row] = await db
      .select()
      .from(chatEndpoints)
      .where(and(eq(chatEndpoints.id, id), eq(chatEndpoints.provider, "x")));
    if (!row || row.status === "archived")
      throw notFound("X connection not found");
    return row;
  }
  async function start(
    endpointId: string,
    userId: string,
    purpose: "bot" | "identity",
    input?: unknown,
  ) {
    const row = await endpoint(endpointId);
    const redirect = redirectUri();
    if (purpose === "bot" && input)
      await hooks.store(row, clientSchema.parse(input), userId);
    const credentials = await hooks.credentials(row);
    if (!credentials.clientId || !credentials.clientSecret)
      throw badRequest("Configure the X OAuth 2.0 client first");
    if (purpose === "identity" && !row.botExternalId)
      throw conflict("Authorize the bot account first");
    const verifier = randomBytes(32).toString("base64url");
    const state = `x.${randomBytes(32).toString("base64url")}`;
    const scopes = purpose === "bot" ? X_BOT_SCOPES : HUMAN_SCOPES;
    await db.insert(toolOauthStates).values({
      companyId: row.companyId,
      connectionId: row.connectionId,
      state,
      codeVerifier: JSON.stringify({
        verifier,
        endpointId,
        purpose,
        redirect,
        revision: revision(credentials),
      }),
      subjectUserId: userId,
      createdByActorType: "user",
      createdByActorId: userId,
      requestedScopes: scopes,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const url = new URL("https://x.com/i/oauth2/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: credentials.clientId,
      redirect_uri: redirect,
      scope: scopes.join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString(), redirectUri: redirect };
  }
  async function pending(state: string, userId: string) {
    if (!state.startsWith("x."))
      throw forbidden("Invalid X authorization state");
    const [row] = await db
      .select()
      .from(toolOauthStates)
      .where(
        and(
          eq(toolOauthStates.state, state),
          eq(toolOauthStates.subjectUserId, userId),
          gt(toolOauthStates.expiresAt, new Date()),
        ),
      );
    if (!row)
      throw forbidden(
        "X authorization expired, was already used, or belongs to another Paperclip account",
      );
    return {
      row,
      binding: JSON.parse(row.codeVerifier) as {
        endpointId: string;
        purpose: "bot" | "identity";
        verifier: string;
        redirect: string;
        revision: string;
      },
    };
  }
  async function complete(state: string, code: string, userId: string) {
    const { row: pendingRow, binding } = await pending(state, userId);
    const row = await endpoint(binding.endpointId);
    const credentials = await hooks.credentials(row);
    if (
      row.connectionId !== pendingRow.connectionId ||
      revision(credentials) !== binding.revision ||
      binding.redirect !== redirectUri()
    )
      throw conflict("X app configuration changed; authorize again");
    const [claimed] = await db
      .delete(toolOauthStates)
      .where(
        and(
          eq(toolOauthStates.state, state),
          eq(toolOauthStates.subjectUserId, userId),
          gt(toolOauthStates.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!claimed) throw conflict("X authorization already consumed");
    const tokens = await xExchange(
      credentials.clientId,
      credentials.clientSecret,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: binding.redirect,
        code_verifier: binding.verifier,
      },
      fetchImpl,
    );
    const scopes = new Set(tokens.scope?.split(" ") ?? []);
    if (
      !(binding.purpose === "bot" ? X_BOT_SCOPES : HUMAN_SCOPES).every(
        (scope) => scopes.has(scope),
      )
    )
      throw forbidden("X did not grant the requested scopes");
    const identity = await xIdentity(tokens.access_token!, fetchImpl);
    if (binding.purpose === "bot") {
      if (!tokens.refresh_token)
        throw forbidden("X did not grant offline access; authorize again");
      await hooks.connect(
        row,
        {
          ...credentials,
          accessToken: tokens.access_token!,
          refreshToken: tokens.refresh_token,
          expiresAt: String(Date.now() + tokens.expires_in! * 1000),
        },
        userId,
      );
      return {
        endpointId: row.id,
        companyId: row.companyId,
        purpose: binding.purpose,
      };
    }
    if (identity.id === row.botExternalId)
      throw badRequest("Choose your personal X account, not the bot account");
    // Human tokens are deliberately discarded. Linking never supplies a token
    // to the bot runtime or posts a public identity challenge.
    const [confirmation] = await db
      .insert(chatActions)
      .values({
        companyId: row.companyId,
        endpointId: row.id,
        kind: "x_identity_confirmation",
        providerActionId: `x-identity:${randomBytes(24).toString("base64url")}`,
        payload: { userId, identity, expiresAt: Date.now() + 600_000 },
        status: "pending",
      })
      .returning();
    return {
      endpointId: row.id,
      companyId: row.companyId,
      purpose: binding.purpose,
      confirmationId: confirmation.id,
    };
  }
  async function confirmation(id: string, userId: string) {
    const [row] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, id),
          eq(chatActions.kind, "x_identity_confirmation"),
          eq(chatActions.status, "pending"),
        ),
      );
    if (
      !row ||
      row.payload.userId !== userId ||
      Number(row.payload.expiresAt) < Date.now()
    )
      throw forbidden(
        "X identity confirmation expired or belongs to another account",
      );
    return row;
  }
  async function confirm(id: string, userId: string) {
    const action = await confirmation(id, userId);
    const row = await endpoint(action.endpointId);
    const identity = action.payload.identity as {
      id: string;
      name: string;
      username: string;
    };
    await db.transaction(async (tx) => {
      const [membership] = await tx
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, row.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        );
      if (!membership || membership.membershipRole === "viewer")
        throw forbidden("An active Paperclip company membership is required");
      const [claimed] = await tx
        .update(chatActions)
        .set({ status: "processed", updatedAt: new Date() })
        .where(and(eq(chatActions.id, id), eq(chatActions.status, "pending")))
        .returning();
      if (!claimed) throw conflict("Identity confirmation already used");
      const [principal] = await tx
        .insert(chatExternalPrincipals)
        .values({
          companyId: row.companyId,
          provider: "x",
          providerAccountId: row.providerAccountId!,
          externalId: identity.id,
          kind: "user",
          displayName: identity.name,
          handle: identity.username,
          isBot: false,
        })
        .onConflictDoUpdate({
          target: [
            chatExternalPrincipals.companyId,
            chatExternalPrincipals.provider,
            chatExternalPrincipals.providerAccountId,
            chatExternalPrincipals.externalId,
          ],
          set: { displayName: identity.name, handle: identity.username },
        })
        .returning();
      const [existing] = await tx
        .select()
        .from(chatIdentityLinks)
        .where(
          and(
            eq(chatIdentityLinks.endpointId, row.id),
            eq(chatIdentityLinks.principalId, principal.id),
          ),
        )
        .for("update");
      if (existing?.status === "linked" && existing.paperclipUserId !== userId)
        throw conflict(
          "This X account is already linked to another Paperclip account",
        );
      if (existing)
        await tx
          .update(chatIdentityLinks)
          .set({
            status: "linked",
            paperclipUserId: userId,
            confirmedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(chatIdentityLinks.id, existing.id));
      else
        await tx.insert(chatIdentityLinks).values({
          companyId: row.companyId,
          endpointId: row.id,
          principalId: principal.id,
          paperclipUserId: userId,
          status: "linked",
          confirmedAt: new Date(),
        });
      await logActivity(tx as unknown as Db, {
        companyId: row.companyId,
        actorType: "user",
        actorId: userId,
        action: "chat.identity_linked",
        entityType: "tool_connection",
        entityId: row.connectionId,
        details: { endpointId: row.id, principalId: principal.id },
      });
    });
    return { endpointId: row.id, companyId: row.companyId };
  }
  return { start, pending, complete, confirmation, confirm, redirectUri };
}
