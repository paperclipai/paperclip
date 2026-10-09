import { Activity, LayoutGrid, KeyRound, Wrench, Boxes } from "lucide-react";

/**
 * Gateway detail tabs (PAP-11200). Terminology is locked by the approved
 * PAP-11178 design of record: Overview · Apps & tools · Tokens · Activity ·
 * Advanced. Raw protocol / JSON / transport details live under Advanced.
 */
export const GATEWAY_TABS = [
  { key: "overview", label: "Overview", icon: LayoutGrid },
  { key: "apps", label: "Apps & tools", icon: Boxes },
  { key: "tokens", label: "Tokens", icon: KeyRound },
  { key: "activity", label: "Activity", icon: Activity },
  { key: "advanced", label: "Advanced", icon: Wrench },
] as const;

export type GatewayTabKey = (typeof GATEWAY_TABS)[number]["key"];

export function gatewayTabHref(gatewayId: string, tab: GatewayTabKey): string {
  return `/apps/gateways/${gatewayId}/${tab}`;
}

export function isGatewayTabKey(value: string | undefined): value is GatewayTabKey {
  return GATEWAY_TABS.some((tab) => tab.key === value);
}

export function gatewayTabLabel(tabKey: GatewayTabKey): string {
  return GATEWAY_TABS.find((tab) => tab.key === tabKey)?.label ?? "Overview";
}
