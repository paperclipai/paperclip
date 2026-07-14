import { Activity, Beaker, Inbox, Settings2, ShieldCheck, Wrench } from "lucide-react";

export const APP_TABS = [
  { key: "setup", label: "Setup", icon: Settings2 },
  { key: "review", label: "Review", icon: Inbox },
  { key: "permissions", label: "Permissions", icon: ShieldCheck },
  { key: "activity", label: "Activity", icon: Activity },
  { key: "test", label: "Test", icon: Beaker },
  { key: "advanced", label: "Advanced", icon: Wrench },
] as const;

export type AppTabKey = (typeof APP_TABS)[number]["key"];

/**
 * Tabs hidden for an application that has no live connection (the
 * `AppNotConnected` shell). The Test tab runs real calls against a connected
 * app, so it only appears once the app is connected.
 */
export const CONNECTED_ONLY_APP_TABS: ReadonlySet<AppTabKey> = new Set<AppTabKey>(["test"]);

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
