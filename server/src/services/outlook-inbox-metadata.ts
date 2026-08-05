/**
 * The one supported app-only Outlook operation.  This module deliberately has
 * no configurable URL, method, mailbox, field list, or OAuth grant: callers
 * get only the Inbox metadata proof shape approved for this capability.
 */

export type OutlookCredentialSecretRef = {
  secretId: string;
  versionSelector?: "latest" | number;
  configPath: string;
  required?: boolean;
};

export type OutlookInboxMetadataConnection = {
  id: string;
  companyId: string;
  config: Record<string, unknown>;
  credentialSecretRefs: OutlookCredentialSecretRef[];
};

type SecretResolver = (
  companyId: string,
  secretId: string,
  version: "latest" | number,
  context: {
    consumerType: "tool_connection";
    consumerId: string;
    configPath: string;
    actorType: "system";
  },
) => Promise<string>;

type OutlookAudit = (event: {
  outcome: "success" | "failure" | "denied";
  reasonCode: string;
  details?: Record<string, unknown>;
}) => Promise<void> | void;

export class OutlookInboxMetadataError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

const REQUIRED_BINDING_PATHS = ["oauth.tenant_id", "oauth.client_id", "oauth.client_secret"] as const;
const FIXED_GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const GRAPH_MESSAGES_PATH_SUFFIX = "/mailFolders/inbox/messages?$top=1&$select=id,receivedDateTime";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function mailboxFromConnection(connection: OutlookInboxMetadataConnection): string {
  const outlook = record(connection.config.outlookInboxMetadata);
  const mailbox = typeof outlook?.mailbox === "string" ? outlook.mailbox.trim() : "";
  if (!mailbox) throw new OutlookInboxMetadataError("Outlook Inbox metadata requires an approved mailbox.", "outlook_mailbox_missing");
  return mailbox;
}

export function validateOutlookInboxMetadataConnection(connection: OutlookInboxMetadataConnection): {
  mailbox: string;
  refs: Record<(typeof REQUIRED_BINDING_PATHS)[number], OutlookCredentialSecretRef>;
} {
  const mailbox = mailboxFromConnection(connection);
  const byPath = new Map(connection.credentialSecretRefs.map((ref) => [ref.configPath, ref]));
  const allowedPaths = new Set([...REQUIRED_BINDING_PATHS, "oauth.access_token"]);
  if (connection.credentialSecretRefs.length < REQUIRED_BINDING_PATHS.length
    || connection.credentialSecretRefs.length > REQUIRED_BINDING_PATHS.length + 1
    || byPath.size !== connection.credentialSecretRefs.length
    || connection.credentialSecretRefs.some((ref) => !allowedPaths.has(ref.configPath))
    || REQUIRED_BINDING_PATHS.some((path) => !byPath.get(path)?.secretId)) {
    throw new OutlookInboxMetadataError(
      "Outlook Inbox metadata requires exactly its three governed OAuth secret references.",
      "outlook_credentials_invalid",
    );
  }
  return {
    mailbox,
    refs: Object.fromEntries(REQUIRED_BINDING_PATHS.map((path) => [path, byPath.get(path)!])) as Record<
      (typeof REQUIRED_BINDING_PATHS)[number], OutlookCredentialSecretRef
    >,
  };
}

function fixedGraphMessagesUrl(mailbox: string): string {
  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}${GRAPH_MESSAGES_PATH_SUFFIX}`;
}

async function audited(audit: OutlookAudit | undefined, event: Parameters<OutlookAudit>[0]) {
  if (audit) await audit(event);
}

/**
 * Executes the fixed operation with values held only in local variables.  It
 * never returns an access token, URL, request form, or provider response body.
 */
export async function executeOutlookInboxMetadata(input: {
  connection: OutlookInboxMetadataConnection;
  mailbox?: string;
  parameters?: unknown;
  resolveSecret: SecretResolver;
  fetch?: typeof globalThis.fetch;
  audit?: OutlookAudit;
  storeAccessToken?: (accessToken: string) => Promise<void>;
}): Promise<{ messages: Array<{ id: string; receivedDateTime: string }> }> {
  if (input.parameters !== undefined && (typeof input.parameters !== "object" || input.parameters === null || Object.keys(input.parameters as Record<string, unknown>).length > 0)) {
    throw new OutlookInboxMetadataError("This Outlook operation accepts no parameters.", "outlook_operation_parameters_forbidden");
  }
  const { mailbox, refs } = validateOutlookInboxMetadataConnection(input.connection);
  if (input.mailbox !== undefined && input.mailbox.trim() !== mailbox) {
    await audited(input.audit, { outcome: "denied", reasonCode: "outlook_mailbox_not_approved" });
    throw new OutlookInboxMetadataError("The requested mailbox is not approved for this connection.", "outlook_mailbox_not_approved");
  }
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const resolve = (path: (typeof REQUIRED_BINDING_PATHS)[number]) => {
    const ref = refs[path];
    return input.resolveSecret(input.connection.companyId, ref.secretId, ref.versionSelector ?? "latest", {
      consumerType: "tool_connection",
      consumerId: input.connection.id,
      configPath: path,
      actorType: "system",
    });
  };

  let tenantId: string;
  let clientId: string;
  let clientSecret: string;
  try {
    [tenantId, clientId, clientSecret] = await Promise.all([
      resolve("oauth.tenant_id"),
      resolve("oauth.client_id"),
      resolve("oauth.client_secret"),
    ]);
  } catch {
    await audited(input.audit, { outcome: "failure", reasonCode: "outlook_secret_resolution_failed" });
    throw new OutlookInboxMetadataError("Outlook credential resolution failed.", "outlook_secret_resolution_failed");
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
        scope: FIXED_GRAPH_SCOPE,
      }),
    });
  } catch {
    await audited(input.audit, { outcome: "failure", reasonCode: "outlook_token_exchange_failed" });
    throw new OutlookInboxMetadataError("Outlook token exchange failed.", "outlook_token_exchange_failed");
  }
  if (!tokenResponse.ok) {
    await audited(input.audit, { outcome: "failure", reasonCode: "outlook_token_exchange_failed", details: { status: tokenResponse.status } });
    throw new OutlookInboxMetadataError("Outlook token exchange failed.", "outlook_token_exchange_failed");
  }
  const token = record(await tokenResponse.json().catch(() => null));
  const accessToken = typeof token?.access_token === "string" && token.access_token ? token.access_token : null;
  if (!accessToken) {
    await audited(input.audit, { outcome: "failure", reasonCode: "outlook_token_exchange_failed" });
    throw new OutlookInboxMetadataError("Outlook token exchange failed.", "outlook_token_exchange_failed");
  }
  try {
    await input.storeAccessToken?.(accessToken);
  } catch {
    await audited(input.audit, { outcome: "failure", reasonCode: "outlook_access_token_store_failed" });
    throw new OutlookInboxMetadataError("Outlook access token storage failed.", "outlook_access_token_store_failed");
  }

  let graphResponse: Response;
  try {
    graphResponse = await fetchImpl(fixedGraphMessagesUrl(mailbox), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
  } catch {
    await audited(input.audit, { outcome: "failure", reasonCode: "outlook_inbox_metadata_failed" });
    throw new OutlookInboxMetadataError("Outlook Inbox metadata request failed.", "outlook_inbox_metadata_failed");
  }
  if (!graphResponse.ok) {
    await audited(input.audit, { outcome: "failure", reasonCode: "outlook_inbox_metadata_failed", details: { status: graphResponse.status } });
    throw new OutlookInboxMetadataError("Outlook Inbox metadata request failed.", "outlook_inbox_metadata_failed");
  }
  const payload = record(await graphResponse.json().catch(() => null));
  const values = Array.isArray(payload?.value) ? payload.value : [];
  const messages = values.flatMap((value) => {
    const message = record(value);
    return typeof message?.id === "string" && typeof message.receivedDateTime === "string"
      ? [{ id: message.id, receivedDateTime: message.receivedDateTime }]
      : [];
  }).slice(0, 1);
  await audited(input.audit, { outcome: "success", reasonCode: "outlook_inbox_metadata_completed", details: { resultCount: messages.length } });
  return { messages };
}

export const outlookInboxMetadataConstants = {
  FIXED_GRAPH_SCOPE,
  GRAPH_MESSAGES_PATH_SUFFIX,
  REQUIRED_BINDING_PATHS,
};
