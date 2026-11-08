import { t as translate } from "@/i18n";
import { Inbox, ShieldCheck } from "lucide-react";

export const APP_TABS = [
  { key: "permissions", get label() { return translate("connections:permissions_d06d555"); }, icon: ShieldCheck },
  { key: "review", get label() { return translate("connections:review_e29a79f"); }, icon: Inbox },
] as const;

export type AppTabKey = (typeof APP_TABS)[number]["key"];

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
  return APP_TABS.find((tab) => tab.key === tabKey)?.label ?? translate("connections:permissions_d06d555");
}
