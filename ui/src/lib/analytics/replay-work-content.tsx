// Decides whether session replay may show work content (task descriptions,
// document bodies, artifact contents) for the active company.
//
// Work content stays masked unless the company holds no Google or Slack data:
// agents copy connected-account content into tasks and artifacts, and our
// privacy policy and the Google API Limited Use rules say no person may read
// that content in a replay. Every unknown state (analytics off, no company,
// a query loading, failing or waiting on a refresh, a viewer the server may
// hide connections from) keeps it masked, and a new connection or chat channel
// masks it again until the check reruns.

import { useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { connectionSourceSlug, isAppAggregator, type ToolConnection } from "@paperclipai/shared";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { authApi } from "@/api/auth";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";
import { toolsApi } from "@/api/tools";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
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

/** The same apps added by hand, matched by the host of the server URL. */
const ROUTER_SOURCE_HOSTS = ["zapier.com", "make.com", "gscwizard.com", "windsor.ai"];

function isRouterSourceUrl(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ROUTER_SOURCE_HOSTS.some((routerHost) => host === routerHost || host.endsWith(`.${routerHost}`));
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
  if (isRouterSourceUrl(stringValue(transport.url)) || isRouterSourceUrl(stringValue(transport.serverUrl))) return true;
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
 * True when work content may show in replays: both lists loaded, and no tool
 * connection or chat endpoint (any status) is Google, Slack or an aggregator.
 */
export function companyAllowsReplayWorkContent(
  connections: ReadonlyArray<Parameters<typeof connectionCarriesConnectedAccountData>[0]> | undefined,
  chatEndpoints: ReadonlyArray<Pick<ChatEndpoint, "provider">> | undefined,
): boolean {
  if (!connections || !chatEndpoints) return false;
  if (connections.some(connectionCarriesConnectedAccountData)) return false;
  if (chatEndpoints.some((endpoint) => endpoint.provider === "slack")) return false;
  return true;
}

/**
 * True when the server shows this viewer every connection of the company.
 * The connection list hides another person's draft connection from anyone who
 * is not a connection manager, and a Google or Slack connection returns to
 * draft when its sign-in expires. Only an owner, an admin or an instance admin
 * is certain to see the whole list, so only their answer counts. (A member
 * with a custom permission to manage connections also sees it, but the board
 * cannot tell, so that member's replays stay masked.)
 */
export function viewerSeesEveryConnection(
  companyId: string,
  boardAccess: Pick<CurrentBoardAccess, "isInstanceAdmin" | "memberships" | "source"> | undefined,
): boolean {
  if (!boardAccess) return false;
  if (boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin) return true;
  const membership = boardAccess.memberships?.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  return membership?.membershipRole === "owner" || membership?.membershipRole === "admin";
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
 * Activity that can add a Google or Slack source, by the action the server
 * logs: an app connected from the catalog (`tool_app.*`, logged in
 * `server/src/routes/tool-access.ts`), a tool connection added or edited by
 * hand, an example installed, a new or edited chat channel, or an imported
 * company. `LiveUpdatesProvider` resets this check on these, so work content
 * stays masked until the new source lists load.
 */
const SOURCE_CHANGE_ACTIONS = new Set([
  "tool_app.connected",
  "tool_app.oauth_connected",
  "tool_app.reconnected",
  "tool_example.installed",
  "tool_connection.created",
  "tool_connection.updated",
  "connection_installs.changed",
  "chat_endpoint.created",
  "chat_endpoint.updated",
  "chat_endpoint.reconnected",
  "company.imported",
]);

export function isReplayWorkContentSourceChange(action: string | null | undefined): boolean {
  return !!action && SOURCE_CHANGE_ACTIONS.has(action);
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
  const { selectedCompanyId } = useCompany();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const replayEnabled = session?.browserAnalytics?.replayEnabled === true;
  const companyId = replayEnabled ? selectedCompanyId : null;
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: !!companyId,
  });
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
  // cached) and for a viewer who may not see every connection, work content
  // stays masked.
  const visible = !!companyId
    && boardAccess.status === "success"
    && viewerSeesEveryConnection(companyId, boardAccess.data)
    && isCurrentAnswer(connections)
    && isCurrentAnswer(chatEndpoints)
    && companyAllowsReplayWorkContent(connections.data?.connections, chatEndpoints.data);

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
