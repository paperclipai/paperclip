import { Activity, Beaker, Blocks, Inbox, Settings2, ShieldCheck } from "lucide-react";

export const APP_TABS = [
  { key: "setup", label: "Setup", icon: Settings2 },
  { key: "test", label: "Test", icon: Beaker },
  { key: "services", label: "Services", icon: Blocks },
  { key: "review", label: "Review", icon: Inbox },
  { key: "permissions", label: "Permissions", icon: ShieldCheck },
  { key: "activity", label: "Activity", icon: Activity },
] as const;

export type AppTabKey = (typeof APP_TABS)[number]["key"];

/**
 * Tabs hidden for an application that has no live connection (the
 * `AppNotConnected` shell). The Test tab runs real calls against a connected
 * app, so it only appears once the app is connected. Services lists the toolkits
 * behind a broker's API key, which there is likewise nothing to read without one.
 */
export const CONNECTED_ONLY_APP_TABS: ReadonlySet<AppTabKey> = new Set<AppTabKey>([
  "test",
  "services",
]);

/**
 * Tabs that only make sense for a connection that brokers other services
 * (PAP-17865).
 *
 * Composio is the only broker today: one API-key connection fronts many toolkits,
 * so it is the only connection with per-service state to manage. Every other app
 * *is* the service, so a Services tab there would be an empty page. This is a
 * separate set from `CONNECTED_ONLY_APP_TABS` because the two conditions compose —
 * a broker tab needs both a live connection and a broker.
 */
export const BROKER_ONLY_APP_TABS: ReadonlySet<AppTabKey> = new Set<AppTabKey>(["services"]);

export function appTabHref(connectionId: string, tab: AppTabKey): string {
  return `/apps/${connectionId}/${tab}`;
}

export function appApplicationTabHref(applicationId: string, tab: AppTabKey): string {
  return `/apps/app/${applicationId}/${tab}`;
}

export function isAppTabKey(value: string | undefined): value is AppTabKey {
  return APP_TABS.some((tab) => tab.key === value);
}

export function appTabLabel(tabKey: AppTabKey): string {
  return APP_TABS.find((tab) => tab.key === tabKey)?.label ?? "Setup";
}
