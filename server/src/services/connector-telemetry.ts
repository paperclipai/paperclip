import { eq } from "drizzle-orm";
import { toolConnections, toolInvocations, type Db } from "@paperclipai/db";
import { isIP } from "node:net";
import { parse as parseHostname } from "tldts";
import { getConnectableAppDefinition, isPluginAppSlug } from "@paperclipai/shared";
import { resolveAggregatorApp, type AppCatalogAggregator } from "@paperclipai/shared/aggregator-app-catalog";
import {
  trackConnectionCreated,
  trackConnectionUpdated,
  trackConnectionInvoked,
  trackConnectionAppLinked,
  trackConnectionAppRequested,
} from "@paperclipai/shared/telemetry";
import { remoteEndpointValue } from "./tool-access/connection-methods.js";
import { composioAddOutcomes } from "./composio-app-setup.js";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";
import { withTelemetryCompany } from "../telemetry-company-scope.js";

type ToolConnectionRow = typeof toolConnections.$inferSelect;
type ToolInvocationRow = typeof toolInvocations.$inferSelect;

export type ConnectorSetupFlow = "gallery" | "api" | "example";
export type ConnectorChangeSource =
  | "api"
  | "gallery"
  | "oauth_callback"
  | "credential_refresh"
  | "archive"
  | "example";

/**
 * Terminal `tool_invocations.status` values. `pending`, `authorized`,
 * `awaiting_approval`, and `executing` are in-flight and never emit: pending
 * approval is not a failure. `cancelled` is declared in the schema enum but no
 * current code path writes it to an invocation (signing-path cancellations
 * land on the action request and fail the invocation); it stays here so a
 * future writer is counted without a telemetry change.
 */
const TERMINAL_INVOCATION_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "timed_out",
  "rate_limited",
]);

/**
 * Connector identity for telemetry is the reviewed first-party catalog slug
 * only: `config.sourceTemplateKey` validated against the shared app-definitions
 * catalog. Anything else — custom MCP servers, user-named connections, keys
 * that no longer resolve to a catalog entry — reports the literal `custom` so
 * no user- or provider-controlled string leaves the process.
 */
export function connectorKeyForConnection(
  connection: Pick<ToolConnectionRow, "config">,
): string {
  const raw = connection.config?.sourceTemplateKey;
  const key = typeof raw === "string" ? raw : null;
  // Only built-in connector keys leave the instance; a plugin's connector
  // names its (possibly private) plugin, so it is reported as custom.
  return key && !isPluginAppSlug(key) && getConnectableAppDefinition(key) ? key : "custom";
}

/** Same bound as the registered `connector_key` and `app` dimensions. */
const TELEMETRY_SLUG_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

/**
 * Lowercase dot-separated DNS labels (punycode for IDNs), at most 253
 * characters: the registered `server_domain` pattern. A final guard so a
 * parser surprise can never emit anything shaped like a URL.
 */
const REGISTRABLE_DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Special-use suffixes that the public suffix list treats as ordinary ICANN
 * suffixes but that only ever name private or overlay hosts.
 */
const SPECIAL_USE_SUFFIXES = ["arpa", "onion"];

/**
 * Reduces a configured remote server address to what telemetry may send for
 * a custom connector: the registrable domain only (ICANN public suffix plus
 * one label, e.g. `mcp.smithery.ai` reports `smithery.ai`). Path, query,
 * port, credentials, and subdomains never leave the process: subdomains can
 * name a customer or tenant, and paths and queries can carry tokens. Private
 * entries of the public suffix list (e.g. `*.github.io`) are not honored, so
 * a user-named subdomain under them is dropped too.
 *
 * Anything that does not name a public internet service reports the literal
 * `private`: IP addresses, loopback, single-label hosts, non-ICANN suffixes
 * such as `.local`, `.internal`, `.lan` or `.corp`, special-use suffixes
 * such as `.home.arpa` or `.onion`, non-HTTP schemes, and unparsable values.
 */
export function serverDomainForUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "private";
  let hostname: string;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return "private";
    hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "private";
  }
  if (!hostname || hostname.startsWith("[") || isIP(hostname)) return "private";
  const parsed = parseHostname(hostname, { allowPrivateDomains: false });
  if (parsed.isIp || !parsed.isIcann || !parsed.domain || !parsed.publicSuffix) return "private";
  const suffixTld = parsed.publicSuffix.split(".").pop();
  if (suffixTld && SPECIAL_USE_SUFFIXES.includes(suffixTld)) return "private";
  const domain = parsed.domain.toLowerCase();
  return domain.length <= 253 && REGISTRABLE_DOMAIN_PATTERN.test(domain) ? domain : "private";
}

/**
 * `server_domain` for a connection event. Only custom connectors carry it,
 * since a catalog `connector_key` already names the service. Local stdio
 * servers report `stdio`; a remote connection with no configured address yet
 * (e.g. a draft) omits it.
 */
export function serverDomainForConnection(
  connection: Pick<ToolConnectionRow, "config" | "transport">,
  connectorKey: string = connectorKeyForConnection(connection),
): string | undefined {
  if (connectorKey !== "custom") return undefined;
  if (connection.transport === "local_stdio") return "stdio";
  const value = remoteEndpointValue(connection.config ?? {});
  if (value === undefined || value === null || value === "") return undefined;
  return serverDomainForUrl(value);
}

function connectionIdentityDims(connection: Pick<ToolConnectionRow, "config" | "transport">) {
  const connectorKey = connectorKeyForConnection(connection);
  const serverDomain = serverDomainForConnection(connection, connectorKey);
  return {
    connector_key: connectorKey,
    ...(serverDomain === undefined ? {} : { server_domain: serverDomain }),
  };
}

/**
 * Setup-test invocations (Apps → Test tab) are separated from agent usage on
 * durable invocation columns, mirroring the gateway's own test-origin
 * predicate, so the split survives reloads and approval-driven completion.
 */
export function invocationOrigin(
  invocation: Pick<
    ToolInvocationRow,
    "actorType" | "runId" | "issueId" | "gatewayId" | "connectionId"
  >,
): string {
  const isTestOrigin =
    invocation.actorType === "user" &&
    invocation.runId === null &&
    invocation.issueId === null &&
    invocation.gatewayId === null &&
    invocation.connectionId !== null;
  return isTestOrigin ? "setup_test" : invocation.actorType;
}

function isToolPurpose(connection: Pick<ToolConnectionRow, "connectionPurpose">): boolean {
  return connection.connectionPurpose === "tool";
}

/**
 * Emits one proposed `connection.created` event for a tool-purpose
 * connection row that a caller already committed. Channel and AI connections
 * never emit. This function never throws; a telemetry failure must never fail
 * a connection setup path.
 */
export function emitConnectionCreated(
  connection: ToolConnectionRow,
  setupFlow: ConnectorSetupFlow,
): void {
  try {
    const client = getTelemetryClient();
    if (!client) return;
    if (!isToolPurpose(connection)) return;
    withTelemetryCompany(connection.companyId, () => trackConnectionCreated(client, {
      ...connectionIdentityDims(connection),
      transport: connection.transport,
      auth_kind: connection.authKind,
      setup_flow: setupFlow,
      status: connection.status,
      enabled: connection.enabled,
    }));
  } catch (err) {
    logger.warn(
      { err, connectionId: connection.id },
      "failed to emit connection.created telemetry",
    );
  }
}

/**
 * Emits one proposed `connection.updated` event when a committed
 * write changed a tool-purpose connection's persisted lifecycle state
 * (`status` or `enabled`). Metadata-only saves, health polls, credential
 * rotation, and catalog refreshes do not change either field and therefore
 * never emit. This function never throws.
 */
export function emitConnectionUpdated(
  connection: ToolConnectionRow,
  previous: Pick<ToolConnectionRow, "status" | "enabled">,
  changeSource: ConnectorChangeSource,
): void {
  try {
    const client = getTelemetryClient();
    if (!client) return;
    if (!isToolPurpose(connection)) return;
    if (
      previous.status === connection.status &&
      previous.enabled === connection.enabled
    ) {
      return;
    }
    withTelemetryCompany(connection.companyId, () => trackConnectionUpdated(client, {
      ...connectionIdentityDims(connection),
      transport: connection.transport,
      auth_kind: connection.authKind,
      change_source: changeSource,
      previous_status: previous.status,
      status: connection.status,
      previous_enabled: previous.enabled,
      enabled: connection.enabled,
    }));
  } catch (err) {
    logger.warn(
      { err, connectionId: connection.id },
      "failed to emit connection.updated telemetry",
    );
  }
}

/**
 * Emits one proposed `connection.invoked` event for an invocation
 * a caller already wrote to a terminal status. Despite the name, this is a
 * completion event: it records finished invocation attempts and their
 * terminal status, never invocation starts. Never await it: like
 * `agent.task_run`, this is best-effort background work and must not delay
 * the caller's own response or lifecycle writes.
 *
 * Call placement inside the gateway is deliberate and asymmetric. Failure
 * paths call it right after their terminal save. Success paths call it only
 * after the post-save bookkeeping (action-request settlement, tool-call
 * event, audit) has completed, because a bookkeeping failure lands in a catch
 * that overwrites the row to `failed` and emits there — emitting the success
 * beforehand would let one execution report both outcomes.
 *
 * Self-guards, so callers do not have to re-check anything: non-terminal
 * statuses, invocations without a tool-purpose connection, and an
 * unregistered (still-proposed) event name all return without emitting. The
 * registration gate keeps the completion path free of telemetry reads until
 * schema adoption: the runtime client drops unregistered names in `track`,
 * so there is no point loading rows for an event that cannot be queued.
 *
 * Delivery is best-effort per execution, not exactly-once. Known residual
 * duplications, accepted for the proposal stage: an outer safety-net catch
 * can re-save `failed` and emit again when a failure path's own bookkeeping
 * throws after its emit (test-invocation approval flow), and a crash-side
 * replay that re-writes a terminal status emits again. Deduplication state
 * is out of scope for this proposal.
 */
export async function emitConnectionInvoked(
  db: Db,
  invocationId: string,
): Promise<void> {
  try {
    const client = getTelemetryClient();
    if (!client) return;
    if (!client.isRegisteredEventName("connection.invoked")) return;

    const joined = await db
      .select({ invocation: toolInvocations, connection: toolConnections })
      .from(toolInvocations)
      .innerJoin(
        toolConnections,
        eq(toolInvocations.connectionId, toolConnections.id),
      )
      .where(eq(toolInvocations.id, invocationId))
      .then((rows) => rows[0] ?? null);
    if (!joined) return;
    const { invocation, connection } = joined;
    if (!TERMINAL_INVOCATION_STATUSES.has(invocation.status)) return;
    if (!isToolPurpose(connection)) return;

    const startedAtMs = invocation.startedAt
      ? new Date(invocation.startedAt).getTime()
      : null;
    const completedAtMs = invocation.completedAt
      ? new Date(invocation.completedAt).getTime()
      : null;
    const durationSeconds =
      startedAtMs !== null && completedAtMs !== null
        ? Math.max(0, Math.round((completedAtMs - startedAtMs) / 1000))
        : undefined;

    withTelemetryCompany(connection.companyId, () => trackConnectionInvoked(client, {
      ...connectionIdentityDims(connection),
      transport: connection.transport,
      status: invocation.status,
      origin: invocationOrigin(invocation),
      ...(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
    }));
  } catch (err) {
    logger.warn(
      { err, invocationId },
      "failed to emit connection.invoked telemetry",
    );
  }
}

export type AggregatorAppRequestOrigin = "user" | "agent";
export type AggregatorAppRequestOutcome = "succeeded" | "failed" | "needs_auth";

/**
 * App identity for aggregator telemetry is the reviewed slug from the shared
 * aggregator app catalog only, resolved from the provider's toolkit name.
 * Anything else — Executor custom integrations, toolkits missing from the
 * catalog, provider-supplied names — reports the literal `other`, the same
 * rule as `connector_key`, so no user- or provider-controlled string leaves
 * the process.
 */
export function aggregatorAppTelemetrySlug(provider: AppCatalogAggregator, toolkit: unknown): string {
  if (typeof toolkit !== "string" || !toolkit.trim()) return "other";
  const { slug } = resolveAggregatorApp(provider, toolkit);
  return !slug.startsWith(`${provider}:`) && TELEMETRY_SLUG_PATTERN.test(slug) ? slug : "other";
}

/**
 * Toolkits whose cached app observation for one person moved to `connected`
 * from anything else, including no observation at all. `previous` maps each
 * toolkit to its stored status before the write; `next` lists the statuses
 * the write committed. A re-sync that finds the app still connected is not a
 * transition, so it never repeats `connection.app_linked`.
 */
export function newlyLinkedToolkits(
  previous: ReadonlyMap<string, string>,
  next: Iterable<{ toolkit: string; status: string }>,
): string[] {
  const linked = new Set<string>();
  for (const { toolkit, status } of next) {
    if (status === "connected" && previous.get(toolkit) !== "connected") linked.add(toolkit);
  }
  return [...linked];
}

/**
 * Emits one `connection.app_linked` per toolkit whose snapshot a caller
 * already committed as newly connected (see `newlyLinkedToolkits`). Delivery
 * is best-effort: two concurrent syncs that both read the old status can each
 * emit once. This function never throws; a telemetry failure must never fail
 * an app sync.
 */
export function emitAggregatorAppsLinked(
  companyId: string,
  provider: AppCatalogAggregator,
  toolkits: Iterable<string>,
): void {
  try {
    const client = getTelemetryClient();
    if (!client) return;
    for (const toolkit of toolkits) {
      withTelemetryCompany(companyId, () => trackConnectionAppLinked(client, {
        provider,
        app: aggregatorAppTelemetrySlug(provider, toolkit),
      }));
    }
  } catch (err) {
    logger.warn({ err, companyId, provider }, "failed to emit connection.app_linked telemetry");
  }
}

/**
 * Emits one `connection.app_requested` per toolkit a person or agent asked an
 * aggregator to add, with the aggregator's answer. A later completed sign-in
 * is recorded separately by `connection.app_linked`. This function never
 * throws; a telemetry failure must never fail an app setup or a tool call.
 */
export function emitAggregatorAppsRequested(
  companyId: string,
  input: {
    provider: AppCatalogAggregator;
    toolkits: Iterable<string>;
    origin: AggregatorAppRequestOrigin;
    outcome: AggregatorAppRequestOutcome;
  },
): void {
  try {
    const client = getTelemetryClient();
    if (!client) return;
    for (const toolkit of new Set(input.toolkits)) {
      withTelemetryCompany(companyId, () => trackConnectionAppRequested(client, {
        provider: input.provider,
        app: aggregatorAppTelemetrySlug(input.provider, toolkit),
        origin: input.origin,
        outcome: input.outcome,
      }));
    }
  } catch (err) {
    logger.warn({ err, companyId, provider: input.provider }, "failed to emit connection.app_requested telemetry");
  }
}

function addedComposioToolkits(parameters: unknown): string[] {
  const toolkits = parameters && typeof parameters === "object" && !Array.isArray(parameters)
    ? (parameters as Record<string, unknown>).toolkits
    : undefined;
  if (!Array.isArray(toolkits)) return [];
  return toolkits.slice(0, 64).flatMap((item) => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : null;
    return entry?.action === "add" && typeof entry.name === "string" ? [entry.name] : [];
  });
}

/**
 * Agent-side app requests seen by the tool gateway: a Composio
 * `COMPOSIO_MANAGE_CONNECTIONS` call whose arguments add one or more
 * toolkits, each with the outcome read from its own result node in the
 * response (`composioAddOutcomes`),
 * or an Arcade tool call that answered with an authorization step (the agent
 * tried to use an app its person has not connected yet; the toolkit is the
 * tool name's prefix, e.g. `Gmail` from `Gmail_SendEmail`). Other tools and
 * providers return without emitting. Never throws.
 */
export function emitAggregatorAppRequestsFromToolCall(input: {
  companyId: string;
  provider: unknown;
  toolName: string;
  parameters: unknown;
  response: unknown;
  origin: AggregatorAppRequestOrigin | null;
  pendingAuthorization: boolean;
}): void {
  try {
    if (!input.origin) return;
    if (input.provider === "composio" && input.toolName === "COMPOSIO_MANAGE_CONNECTIONS") {
      const added = [...new Set(addedComposioToolkits(input.parameters))];
      if (!added.length) return;
      const outcomes = composioAddOutcomes(input.response, added);
      for (const toolkit of added) {
        const outcome = outcomes.get(toolkit);
        emitAggregatorAppsRequested(input.companyId, {
          provider: "composio",
          toolkits: [toolkit],
          origin: input.origin,
          outcome: outcome === "connected" ? "succeeded" : outcome === "authorization_required" ? "needs_auth" : "failed",
        });
      }
      return;
    }
    if (input.provider === "arcade" && input.pendingAuthorization) {
      const toolkit = input.toolName.split(/[._]/)[0];
      if (toolkit) {
        emitAggregatorAppsRequested(input.companyId, { provider: "arcade", toolkits: [toolkit], origin: input.origin, outcome: "needs_auth" });
      }
    }
  } catch (err) {
    logger.warn({ err, companyId: input.companyId }, "failed to emit connection.app_requested telemetry");
  }
}
