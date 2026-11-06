import { Activity, LayoutGrid, KeyRound, Wrench, Boxes } from "lucide-react";
import { t } from "@/i18n";

/**
 * Gateway detail tabs (PAP-11200). Terminology is locked by the approved
 * PAP-11178 design of record: Overview · Apps & tools · Tokens · Activity ·
 * Advanced. Raw protocol / JSON / transport details live under Advanced.
 */
export function gatewayTabs() {
  return [
    { key: "overview", label: t("apps.gatewayTabs.overview"), icon: LayoutGrid },
    { key: "apps", label: t("apps.gatewayTabs.apps"), icon: Boxes },
    { key: "tokens", label: t("apps.gatewayTabs.tokens"), icon: KeyRound },
    { key: "activity", label: t("apps.gatewayTabs.activity"), icon: Activity },
    { key: "advanced", label: t("apps.gatewayTabs.advanced"), icon: Wrench },
  ] as const;
}

export type GatewayTabKey = ReturnType<typeof gatewayTabs>[number]["key"];

export function gatewayTabHref(gatewayId: string, tab: GatewayTabKey): string {
  return `/apps/gateways/${gatewayId}/${tab}`;
}

export function isGatewayTabKey(value: string | undefined): value is GatewayTabKey {
  return gatewayTabs().some((tab) => tab.key === value);
}

export function gatewayTabLabel(tabKey: GatewayTabKey): string {
  return gatewayTabs().find((tab) => tab.key === tabKey)?.label ?? t("apps.gatewayTabs.overview");
}
