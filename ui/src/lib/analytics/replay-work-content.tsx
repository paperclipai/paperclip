// Decides whether session replay may show work content (task descriptions,
// document bodies, artifact contents) for the active company.
//
// Work content stays masked unless the company holds no Google or Slack data:
// agents copy connected-account content into tasks and artifacts, and our
// privacy policy and the Google API Limited Use rules say no person may read
// that content in a replay. Every unknown state (analytics off, no company,
// a query loading or failing, no permission to list connections) keeps it
// masked.

import { useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { connectionSourceSlug, isAppAggregator, type ToolConnection } from "@paperclipai/shared";
import { authApi } from "@/api/auth";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";
import { toolsApi } from "@/api/tools";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { REPLAY_WORK_CONTENT_ATTRIBUTE } from "./privacy";
import { refreshSessionReplay } from "./product-analytics";

/** Google (Gmail, Drive, Calendar, Docs, ...) and Slack, by slug, name or server URL. */
const CONNECTED_ACCOUNT_PATTERN = /google|gmail|slack/i;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * True when a tool connection can bring Google or Slack data into the company.
 * Any status counts (draft, disabled and archived too), because content an
 * agent copied while it was active stays in tasks and artifacts. Aggregators
 * (Composio, Arcade, Executor) count too: they can route Google or Slack.
 */
export function connectionCarriesConnectedAccountData(
  connection: Pick<ToolConnection, "name" | "config" | "transportConfig"> & { metadata?: Record<string, unknown> | null },
): boolean {
  const slug = connectionSourceSlug(connection);
  if (slug && isAppAggregator(slug)) return true;
  const transport = connection.transportConfig ?? {};
  const haystack = [
    slug ?? "",
    connection.name,
    stringValue(transport.url),
    stringValue(transport.serverUrl),
    stringValue(transport.sourceTemplateKey),
    stringValue(connection.config?.sourceTemplateKey),
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

function setReplayWorkContent(visible: boolean) {
  const root = document.documentElement;
  if (visible) root.setAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE, "visible");
  else root.removeAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);
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
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId ?? ""),
    queryFn: () => toolsApi.listConnections(companyId!),
    enabled: !!companyId,
    retry: false,
  });
  const chatEndpoints = useQuery({
    queryKey: queryKeys.chatEndpoints.list(companyId ?? ""),
    queryFn: () => chatEndpointsApi.list(companyId!),
    enabled: !!companyId,
    retry: false,
  });
  const visible = !!companyId
    && !connections.isError
    && !chatEndpoints.isError
    && companyAllowsReplayWorkContent(connections.data?.connections, chatEndpoints.data);

  const wasVisible = useRef(false);
  // Layout effect: it runs before rrweb's mutation observer reads a company
  // switch, so the next company's content is never recorded with the last
  // company's setting.
  useLayoutEffect(() => {
    setReplayWorkContent(visible);
    if (visible && !wasVisible.current) refreshSessionReplay();
    wasVisible.current = visible;
  }, [visible]);
  useLayoutEffect(() => () => setReplayWorkContent(false), []);
  return null;
}
