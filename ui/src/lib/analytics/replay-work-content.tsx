// Decides whether session replay may show work content (task descriptions,
// document bodies, artifact contents) for the active company.
//
// Work content stays masked unless the company holds no Google or Slack data:
// agents copy connected-account content into tasks and artifacts, and our
// privacy policy and the Google API Limited Use rules say no person may read
// that content in a replay. Every unknown state (analytics off, no company,
// a query loading, failing or waiting on a refresh, a connection list the
// server filtered) keeps it masked, and a new connection or chat channel masks
// it again until the check reruns.

import { useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { connectionSourceSlug, isAppAggregator, type ToolConnection } from "@paperclipai/shared";
import { authApi } from "@/api/auth";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";
import { toolsApi } from "@/api/tools";
import { useCompany } from "@/context/CompanyContext";
import { extractCompanyPrefixFromPath } from "@/lib/company-routes";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation } from "@/lib/router";
import { REPLAY_WORK_CONTENT_ATTRIBUTE } from "./privacy";
import { refreshSessionReplay } from "./product-analytics";

/** Google (Gmail, Drive, Calendar, Docs, ...) and Slack, by slug, name or server URL. */
const CONNECTED_ACCOUNT_PATTERN = /google|gmail|slack/i;

/**
 * Catalog apps that reach Google or Slack data through another service:
 * automation routers (Zapier, Make) and Google Search Console or Google Ads
 * readers (GSC Wizard, Windsor.ai). They count like an aggregator.
 */
const ROUTER_SOURCE_SLUGS = new Set(["zapier", "make", "gsc-wizard", "windsor-ai"]);

/**
 * The server hosts of the aggregators and router apps. "Connect your own MCP
 * server" saves a URL and a free name with no catalog slug, so a gateway
 * added that way is found by its host.
 */
const GATEWAY_SOURCE_HOSTS = [
  "composio.dev", "arcade.dev", "executor.sh",
  "zapier.com", "make.com", "gscwizard.com", "windsor.ai",
];

/** The same services by the name a person is likely to give the connection. */
const GATEWAY_SOURCE_NAME = /\b(?:composio|arcade|executor|zapier|make|windsor(?:\.ai)?|gsc wizard)\b/i;

function isGatewaySourceUrl(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return GATEWAY_SOURCE_HOSTS.some((gatewayHost) => host === gatewayHost || host.endsWith(`.${gatewayHost}`));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * True when a tool connection can bring Google or Slack data into the company.
 * Any status counts (draft, disabled and archived too), because content an
 * agent copied while it was active stays in tasks and artifacts. Aggregators
 * (Composio, Arcade, Executor) and the router apps above count too: they can
 * route Google or Slack.
 */
export function connectionCarriesConnectedAccountData(
  connection: Pick<ToolConnection, "name" | "config" | "transportConfig"> & { metadata?: Record<string, unknown> | null },
): boolean {
  const slug = connectionSourceSlug(connection);
  if (slug && (isAppAggregator(slug) || ROUTER_SOURCE_SLUGS.has(slug))) return true;
  const transport = connection.transportConfig ?? {};
  if (isGatewaySourceUrl(stringValue(transport.url)) || isGatewaySourceUrl(stringValue(transport.serverUrl))) return true;
  if (GATEWAY_SOURCE_NAME.test(connection.name)) return true;
  const haystack = [
    slug ?? "",
    connection.name,
    stringValue(transport.url),
    stringValue(transport.serverUrl),
    stringValue(transport.sourceTemplateKey),
    stringValue(connection.config?.sourceTemplateKey),
    // Chat channel connections (Slack and others) store their provider here,
    // with no template key or URL, and keep a custom name.
    stringValue(connection.config?.provider),
  ].join(" ");
  return CONNECTED_ACCOUNT_PATTERN.test(haystack);
}

/**
 * True when work content may show in replays: both lists loaded, the
 * connection list is complete, and no tool connection or chat endpoint (any
 * status) is Google, Slack, an aggregator or a router app.
 *
 * The server leaves some connections out of a reader's list: another person's
 * draft (a Google or Slack connection returns to draft when its sign-in
 * expires) and a connector whose plugin is unavailable. It reports how many
 * as `hiddenCount`. A hidden row can be Google or Slack, so only a list with
 * `hiddenCount: 0` counts. An older server sends no count, which also masks.
 */
export function companyAllowsReplayWorkContent(
  connectionList: {
    connections: ReadonlyArray<Parameters<typeof connectionCarriesConnectedAccountData>[0]>;
    hiddenCount?: number;
  } | undefined,
  chatEndpoints: ReadonlyArray<Pick<ChatEndpoint, "provider">> | undefined,
): boolean {
  if (!connectionList || !chatEndpoints) return false;
  if (connectionList.hiddenCount !== 0) return false;
  if (connectionList.connections.some(connectionCarriesConnectedAccountData)) return false;
  if (chatEndpoints.some((endpoint) => endpoint.provider === "slack")) return false;
  return true;
}

/**
 * True when the page at `pathname` belongs to the company with this issue
 * prefix, or to no company. The visible flag is the selected company's
 * answer, but the selection follows the URL in an effect after the page
 * renders, and a manual switch delays it. In between, the page can show
 * another company's task under the selected company's flag, so a company
 * page counts only when its prefix is the selected company's.
 */
export function routeShowsCompany(pathname: string, issuePrefix: string | null | undefined): boolean {
  const routePrefix = extractCompanyPrefixFromPath(pathname);
  if (!routePrefix) return true;
  return !!issuePrefix && routePrefix.toUpperCase() === issuePrefix.toUpperCase();
}

function setReplayWorkContent(visible: boolean) {
  const root = document.documentElement;
  if (visible) root.setAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE, "visible");
  else root.removeAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);
}

/**
 * Query keys for this check, kept apart from the Apps page's keys so a reset
 * masks replays without touching other screens.
 */
export const replayWorkContentQueryKeys = {
  all: ["replay-work-content"] as const,
  connections: (companyId: string) => ["replay-work-content", companyId, "connections"] as const,
  chatEndpoints: (companyId: string) => ["replay-work-content", companyId, "chat-endpoints"] as const,
};

/**
 * Activity that can add a Google or Slack source, by the family of the action
 * the server logs: a tool connection or app (`tool_connection.*`,
 * `tool_app.*`, `tool_example.*`, `tool_application.*`,
 * `connection_installs.*`), a model connection (`ai_connection.*`), a chat or
 * email channel (`chat_endpoint.*`, `chat_github.*`, `email_endpoint.*`), or
 * an imported company. Several routes add a connection row and some build the
 * action name at run time, so the check matches the whole family: a new
 * action re-checks without a change here. `LiveUpdatesProvider` resets the
 * check on these, so work content stays masked until the source lists load.
 */
const SOURCE_CHANGE_FAMILIES = [
  "tool_connection.",
  "tool_app.",
  "tool_example.",
  "tool_application.",
  "connection_installs.",
  "ai_connection.",
  "chat_endpoint.",
  "chat_github.",
  "email_endpoint.",
];

const SOURCE_CHANGE_ACTIONS = new Set(["company.imported"]);

/**
 * Frequent actions in those families that cannot add a source: health and
 * catalog checks, credential reads and refreshes, and incoming webhooks. A
 * re-check on each of them would mask work content over and over.
 */
const NOT_A_SOURCE_CHANGE = new Set([
  "tool_connection.health_check",
  "tool_connection.catalog_refresh",
  "tool_connection.credential_resolution",
  "tool_connection.webhook_processed",
  "ai_connection.credential_refreshed",
  "chat_endpoint.webhook_verified",
]);

export function isReplayWorkContentSourceChange(action: string | null | undefined): boolean {
  if (!action || NOT_A_SOURCE_CHANGE.has(action)) return false;
  return SOURCE_CHANGE_ACTIONS.has(action) || SOURCE_CHANGE_FAMILIES.some((family) => action.startsWith(family));
}

/** Backstop refresh, in case a live update is missed (a dropped socket). */
const RECHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Shared options of the two source lists. `staleTime: Infinity` makes a list
 * stale only when something invalidates it, so `isCurrentAnswer` can tell a
 * confirmed answer from one that is waiting on a refresh. `gcTime: 0` drops
 * the answer as soon as the company changes, so a return to that company
 * starts from unknown instead of an old answer.
 */
const SOURCE_LIST_OPTIONS = {
  refetchInterval: RECHECK_INTERVAL_MS,
  staleTime: Infinity,
  gcTime: 0,
} as const;

/**
 * True when a source list holds a confirmed answer: its latest fetch
 * succeeded and nothing has invalidated it since. The live socket closes
 * while the tab is hidden and does not replay events, so
 * `LiveUpdatesProvider` invalidates every active query when the tab returns
 * or the socket reopens. Until that refresh lands, an earlier "no Google or
 * Slack" answer may have missed a new source, so it does not count.
 */
function isCurrentAnswer(query: { status: string; isStale: boolean }): boolean {
  return query.status === "success" && !query.isStale;
}

/**
 * Sets `REPLAY_WORK_CONTENT_ATTRIBUTE` on `<html>` for the active company.
 * Renders nothing. Mount it under `CompanyProvider`. It runs its queries only
 * when session replay is on (hosted Cloud), so self-hosted installs make no
 * extra requests.
 */
export function ReplayWorkContentVisibility() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { pathname } = useLocation();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const workContentEnabled = session?.browserAnalytics?.replayEnabled === true
    && session.browserAnalytics.replayWorkContentEnabled === true;
  const companyId = workContentEnabled ? selectedCompanyId : null;
  const connections = useQuery({
    ...SOURCE_LIST_OPTIONS,
    queryKey: replayWorkContentQueryKeys.connections(companyId ?? ""),
    queryFn: () => toolsApi.listConnections(companyId!),
    enabled: !!companyId,
  });
  const chatEndpoints = useQuery({
    ...SOURCE_LIST_OPTIONS,
    queryKey: replayWorkContentQueryKeys.chatEndpoints(companyId ?? ""),
    queryFn: () => chatEndpointsApi.list(companyId!),
    enabled: !!companyId,
  });
  // Only a confirmed answer counts: while loading, after a reset, while a
  // refresh is pending, when the latest fetch failed (even with older data
  // cached) and while the page shows another company, work content stays
  // masked.
  const visible = !!companyId
    && routeShowsCompany(pathname, selectedCompany?.issuePrefix)
    && isCurrentAnswer(connections)
    && isCurrentAnswer(chatEndpoints)
    && companyAllowsReplayWorkContent(connections.data, chatEndpoints.data);

  // The company whose work content this recording already shows.
  const snapshotCompanyId = useRef<string | null>(null);
  // Layout effect: it runs before rrweb's mutation observer reads a company
  // switch, so the next company's content is never recorded with the last
  // company's setting.
  useLayoutEffect(() => {
    setReplayWorkContent(visible);
    if (!visible) {
      if (snapshotCompanyId.current !== companyId) snapshotCompanyId.current = null;
      return;
    }
    // Text recorded before the first answer for this company is masked, so
    // record the page again once. A later re-check masks only what renders
    // while it runs, which is not worth another full snapshot.
    if (snapshotCompanyId.current !== companyId) {
      snapshotCompanyId.current = companyId;
      refreshSessionReplay();
    }
  }, [visible, companyId]);
  useLayoutEffect(() => () => setReplayWorkContent(false), []);
  return null;
}
