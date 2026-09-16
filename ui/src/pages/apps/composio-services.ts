import type { ToolConnection } from "@paperclipai/shared";

/**
 * Reading Composio's service endpoints for the Services tab (PAP-17865).
 *
 * A Composio connection is a gateway to many services, not a service itself, so
 * its detail page lists *toolkits* (GitHub, Gmail, …) and each row has its own
 * connection state. The server (PAP-17866) answers two differently shaped
 * payloads for the same row:
 *
 * - the list (`GET …/services`) already classifies each row, and
 * - the poll (`GET …/services/:slug/status`) returns the raw Composio toolkit,
 *   connected account, and child connection, leaving the classification open.
 *
 * Rather than teach the panel both shapes, both are normalized to `ComposioServiceRow`
 * here. That keeps the "what state is this row in" decision in one testable place
 * instead of spread across render branches, and it means a later contract cleanup
 * on the server only has to move these two adapters.
 */

/** Raw Composio toolkit as the server forwards it. Only the display fields are read. */
export interface ComposioToolkitPayload {
  slug: string;
  name: string;
  no_auth?: boolean;
  auth_schemes?: string[];
  composio_managed_auth_schemes?: string[];
  meta?: {
    description?: string | null;
    logo?: string | null;
    tools_count?: number;
  } | null;
}

/** `GET /tool-connections/:id/services` */
export interface ComposioServicesResponse {
  parentConnectionId: string;
  /** Composio `user_id` these accounts belong to (`paperclip:{companyId}`). Not a secret. */
  userId: string;
  services: Array<{
    toolkit: ComposioToolkitPayload;
    status: string;
    connectedAccountId: string | null;
    connectedAccountStatus: string | null;
    childConnectionId: string | null;
  }>;
}

/** `GET /tool-connections/:id/services/:toolkitSlug/status` — the poll target. */
export interface ComposioServiceStatusResponse {
  toolkit: ComposioToolkitPayload;
  account: { id: string; status: string; status_reason?: string | null } | null;
  child: ToolConnection | null;
}

/** `POST /tool-connections/:id/services/:toolkitSlug/connect` — Composio-hosted link. */
export interface ComposioConnectLinkResponse {
  toolkitSlug: string;
  authConfigId: string;
  redirect_url: string;
  expires_at?: string | null;
  connected_account_id?: string | null;
}

/** `DELETE /tool-connections/:id/services/:toolkitSlug` */
export interface ComposioDisconnectResponse {
  toolkitSlug: string;
  disconnectedAccountIds: string[];
  removedChildIds: string[];
}

/**
 * The three states the design asks for, plus `attention`.
 *
 * `attention` is not a fourth visual language — it reuses the same row as
 * `connected` with a warning tone. It exists because Composio can report an
 * account that is neither absent nor usable (expired, revoked upstream), and
 * collapsing that into `pending` would show a spinner that never resolves.
 */
export type ComposioServiceState = "not_connected" | "pending" | "connected" | "attention";

export interface ComposioServiceRow {
  toolkitSlug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  state: ComposioServiceState;
  /** Raw Composio account status (`ACTIVE`, `INITIALIZING`, `EXPIRED`, …), for the detail line. */
  connectedAccountStatus: string | null;
  /** The Paperclip child connection for this toolkit, once one exists. */
  childConnectionId: string | null;
  /** Number of tools the toolkit exposes, when Composio reports it. */
  toolCount: number | null;
  /** True when Composio needs no credential for this toolkit. */
  noAuth: boolean;
}

/** Composio account statuses that mean "there is a credential and it works". */
const ACTIVE_STATUS = "ACTIVE";
/**
 * Statuses that mean a credential exists but cannot be used. Anything else
 * unfinished (`INITIALIZING`, `INITIATED`, …) is treated as still in flight, so a
 * status Composio adds later degrades to `pending` rather than to a wrong verdict.
 */
const FAILED_STATUSES = new Set(["EXPIRED", "INACTIVE", "DISABLED", "FAILED", "REVOKED", "ERROR"]);

export function composioServiceStateFor(accountStatus: string | null | undefined): ComposioServiceState {
  const status = accountStatus?.trim().toUpperCase();
  if (!status) return "not_connected";
  if (status === ACTIVE_STATUS) return "connected";
  if (FAILED_STATUSES.has(status)) return "attention";
  return "pending";
}

function toolkitDisplay(toolkit: ComposioToolkitPayload) {
  return {
    toolkitSlug: toolkit.slug,
    name: toolkit.name || toolkit.slug,
    description: toolkit.meta?.description?.trim() || null,
    logoUrl: toolkit.meta?.logo?.trim() || null,
    toolCount: typeof toolkit.meta?.tools_count === "number" ? toolkit.meta.tools_count : null,
    noAuth: toolkit.no_auth === true,
  };
}

/** Normalizes the list payload. Trusts the account status, not the server's `status` string. */
export function composioServiceRows(response: ComposioServicesResponse | undefined): ComposioServiceRow[] {
  return (response?.services ?? [])
    .map((service) => ({
      ...toolkitDisplay(service.toolkit),
      // `connectedAccountStatus` is the ground truth: the server's `status` field
      // only distinguishes connected/pending/not_connected, so reading it would
      // lose the difference between "still authorizing" and "expired".
      state: composioServiceStateFor(service.connectedAccountStatus),
      connectedAccountStatus: service.connectedAccountStatus,
      childConnectionId: service.childConnectionId,
    }))
    .sort(compareServiceRows);
}

/** Normalizes the poll payload into the same row the list produced. */
export function composioServiceRowFromStatus(
  response: ComposioServiceStatusResponse,
): ComposioServiceRow {
  return {
    ...toolkitDisplay(response.toolkit),
    state: composioServiceStateFor(response.account?.status),
    connectedAccountStatus: response.account?.status ?? null,
    childConnectionId: response.child?.id ?? null,
  };
}

const STATE_ORDER: Record<ComposioServiceState, number> = {
  attention: 0,
  connected: 1,
  pending: 2,
  not_connected: 3,
};

/**
 * Rows that need the reader's attention first, then connected services, then the
 * long alphabetical tail of everything connectable. A Composio project can expose
 * hundreds of toolkits, so the handful that are actually wired up must not be lost
 * in it.
 */
function compareServiceRows(a: ComposioServiceRow, b: ComposioServiceRow): number {
  const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
  return byState !== 0 ? byState : a.name.localeCompare(b.name);
}

/** True while a row should keep polling — the Connect Link is open and unresolved. */
export function composioServiceIsSettling(state: ComposioServiceState): boolean {
  return state === "pending";
}

/**
 * Telling the two kinds of Composio connection apart.
 *
 * The server (PAP-17866) stamps each kind with a different `config` marker, and
 * they are mutually exclusive:
 *
 * - the broker carries the gallery's `sourceTemplateKey: "composio"`, and
 * - a toolkit child carries `provider: "composio"` plus its parent and slug.
 *
 * Both predicates read those markers rather than the connection's name or
 * transport, because a child is an ordinary `mcp_remote` connection and its name
 * is user-renameable.
 */
function configOf(connection: { config?: Record<string, unknown> | null }): Record<string, unknown> {
  return connection.config ?? {};
}

/** The parent: a Composio API-key connection whose Services tab lists toolkits. */
export function isComposioBrokerConnection(
  connection: { config?: Record<string, unknown> | null } | null | undefined,
): boolean {
  if (!connection) return false;
  const config = configOf(connection);
  return config.sourceTemplateKey === "composio" && config.provider !== "composio";
}

/**
 * The toolkit slug a child connection serves, or `null` if it is not a Composio
 * child. Drives the "via Composio" provenance chip.
 */
export function composioChildToolkitSlug(
  connection: { config?: Record<string, unknown> | null } | null | undefined,
): string | null {
  if (!connection) return null;
  const config = configOf(connection);
  if (config.provider !== "composio") return null;
  const slug = config.toolkitSlug;
  return typeof slug === "string" && slug.trim() ? slug.trim() : null;
}

/** The broker a child hangs off, for linking the chip back to the Services tab. */
export function composioChildParentConnectionId(
  connection: { config?: Record<string, unknown> | null } | null | undefined,
): string | null {
  if (!connection) return null;
  const config = configOf(connection);
  if (config.provider !== "composio") return null;
  const parentId = config.parentConnectionId;
  return typeof parentId === "string" && parentId.trim() ? parentId.trim() : null;
}
