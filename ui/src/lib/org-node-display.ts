import type { OrgNode } from "../api/agents";

export type OrgNodeBadge = {
  key: string;
  label: string;
};

export function orgNodeBadges(node: OrgNode): OrgNodeBadge[] {
  const badges: OrgNodeBadge[] = [];
  if (node.seatType) {
    badges.push({
      key: "seat",
      label: `${node.seatType} seat`,
    });
  }
  if (node.operatingMode) {
    badges.push({
      key: "mode",
      label: node.operatingMode,
    });
  }
  return badges;
}
