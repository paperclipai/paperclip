import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentConnectors } from "@paperclipai/db";
import { notFound, conflict, badRequest } from "../errors.js";

export type ConnectorStatus = "pending" | "connected" | "error" | "revoked";

export interface ConnectorProvider {
  id: string;
  name: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  // Map internal scope -> provider's actual scope
  scopeMapping?: Record<string, string>;
}

export interface AgentConnectorRow {
  id: string;
  agentId: string;
  connectorType: string;
  provider: string;
  displayName: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  scopes: string[] | null;
  providerData: Record<string, unknown> | null;
  status: ConnectorStatus;
  errorMessage: string | null;
  connectedAt: Date;
  updatedAt: Date;
}

/**
 * Known OAuth provider configurations - these are the supported connectors
 * Each provider defines its auth flow, scopes, and API endpoints
 */
export const CONNECTOR_PROVIDERS: Record<string, ConnectorProvider> = {
  google_workspace: {
    id: "google_workspace",
    name: "Google Workspace",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/contacts.readonly",
    ],
  },
  microsoft_365: {
    id: "microsoft_365",
    name: "Microsoft 365",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: [
      "Mail.Read",
      "Calendars.Read",
      "Files.ReadWrite",
      "User.Read",
    ],
  },
  slack: {
    id: "slack",
    name: "Slack",
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: [
      "channels:read",
      "channels:history",
      "chat:write",
      "users:read",
      "search:read",
    ],
  },
  github: {
    id: "github",
    name: "GitHub",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: [
      "repo",
      "read:user",
      "read:org",
    ],
  },
  notion: {
    id: "notion",
    name: "Notion",
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [
      "content",
      "database",
    ],
  },
  jira: {
    id: "jira",
    name: "Jira",
    authUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://api.atlassian.com/oauth/token",
    scopes: [
      "read:jira-work",
      "write:jira-work",
      "read:issue",
    ],
  },
  linear: {
    id: "linear",
    name: "Linear",
    authUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear/oauth/token",
    scopes: [
      "read",
      "write",
    ],
  },
  hubspot: {
    id: "hubspot",
    name: "HubSpot",
    authUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    scopes: [
      "crm.objects.contacts.read",
      "crm.objects.companies.read",
      "crm.objects.deals.read",
    ],
  },
  youtube: {
    id: "youtube",
    name: "YouTube",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.force_ssl",
    ],
  },
  twitter: {
    id: "twitter",
    name: "Twitter / X",
    authUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    scopes: [
      "tweet.read",
      "tweet.write",
      "users.read",
    ],
  },
};

export function agentConnectorService(db: Db) {
  async function listByAgentId(agentId: string) {
    return db
      .select()
      .from(agentConnectors)
      .where(eq(agentConnectors.agentId, agentId))
      .orderBy(agentConnectors.connectedAt);
  }

  async function getById(id: string) {
    const rows = await db
      .select()
      .from(agentConnectors)
      .where(eq(agentConnectors.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async function getByAgentAndProvider(agentId: string, provider: string) {
    const rows = await db
      .select()
      .from(agentConnectors)
      .where(
        and(
          eq(agentConnectors.agentId, agentId),
          eq(agentConnectors.provider, provider),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function create(data: {
    agentId: string;
    provider: string;
    displayName?: string;
    connectorType?: string;
  }) {
    const existing = await getByAgentAndProvider(data.agentId, data.provider);
    if (existing) {
      throw conflict(`Connector already exists for provider: ${data.provider}`);
    }

    const providerConfig = CONNECTOR_PROVIDERS[data.provider];
    if (!providerConfig) {
      throw badRequest(`Unknown provider: ${data.provider}`);
    }

    const [created] = await db
      .insert(agentConnectors)
      .values({
        agentId: data.agentId,
        provider: data.provider,
        connectorType: data.connectorType ?? "oauth",
        displayName: data.displayName ?? null,
        status: "pending",
        scopes: providerConfig.scopes,
        connectedAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return created;
  }

  async function update(
    id: string,
    data: {
      accessToken?: string;
      refreshToken?: string;
      tokenExpiresAt?: Date;
      scopes?: string[];
      providerData?: Record<string, unknown>;
      status?: ConnectorStatus;
      errorMessage?: string;
      displayName?: string;
    },
  ) {
    const existing = await getById(id);
    if (!existing) {
      throw notFound("Connector not found");
    }

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (data.accessToken !== undefined) updateData.accessToken = data.accessToken;
    if (data.refreshToken !== undefined) updateData.refreshToken = data.refreshToken;
    if (data.tokenExpiresAt !== undefined) updateData.tokenExpiresAt = data.tokenExpiresAt;
    if (data.scopes !== undefined) updateData.scopes = data.scopes;
    if (data.providerData !== undefined) updateData.providerData = data.providerData;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.errorMessage !== undefined) updateData.errorMessage = data.errorMessage;
    if (data.displayName !== undefined) updateData.displayName = data.displayName;

    const [updated] = await db
      .update(agentConnectors)
      .set(updateData)
      .where(eq(agentConnectors.id, id))
      .returning();

    return updated;
  }

  async function deleteConnector(id: string) {
    const existing = await getById(id);
    if (!existing) {
      throw notFound("Connector not found");
    }

    await db.delete(agentConnectors).where(eq(agentConnectors.id, id));
    return { success: true };
  }

  async function markConnected(
    id: string,
    data: {
      accessToken: string;
      refreshToken?: string;
      tokenExpiresAt?: Date;
      scopes?: string[];
      providerData?: Record<string, unknown>;
    },
  ) {
    return update(id, {
      ...data,
      status: "connected",
      errorMessage: undefined,
    });
  }

  async function markError(id: string, errorMessage: string) {
    return update(id, {
      status: "error",
      errorMessage,
    });
  }

  return {
    listByAgentId,
    getById,
    getByAgentAndProvider,
    create,
    update,
    delete: deleteConnector,
    markConnected,
    markError,
  };
}
