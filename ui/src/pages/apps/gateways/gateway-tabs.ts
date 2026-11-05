import { t as translate } from "@/i18n";
import { Activity, LayoutGrid, KeyRound, Wrench, Boxes } from "lucide-react";

/**
 * Gateway detail tabs (PAP-11200). Terminology is locked by the approved
 * PAP-11178 design of record: Overview · Apps & tools · Tokens · Activity ·
 * Advanced. Raw protocol / JSON / transport details live under Advanced.
 */
export const GATEWAY_TABS = [
  { key: "overview", get label() { return translate("connections:overview_0efc2e6"); }, icon: LayoutGrid },
  { key: "apps", get label() { return translate("connections:apps_tools_dfb535e"); }, icon: Boxes },
  { key: "tokens", get label() { return translate("connections:tokens_c38c6c1"); }, icon: KeyRound },
  { key: "activity", get label() { return translate("connections:activity_81c0d91"); }, icon: Activity },
  { key: "advanced", get label() { return translate("connections:advanced_4d06472"); }, icon: Wrench },
] as const;

export type GatewayTabKey = (typeof GATEWAY_TABS)[number]["key"];

export function gatewayTabHref(gatewayId: string, tab: GatewayTabKey): string {
  return `/apps/gateways/${gatewayId}/${tab}`;
}

export function isGatewayTabKey(value: string | undefined): value is GatewayTabKey {
  return GATEWAY_TABS.some((tab) => tab.key === value);
}

export function gatewayTabLabel(tabKey: GatewayTabKey): string {
  return GATEWAY_TABS.find((tab) => tab.key === tabKey)?.label ?? translate("connections:overview_0efc2e6");
}
