import type { OrgNode } from "../api/agents";

export function orgNodeCanManageSeat(node: OrgNode): boolean {
  return Boolean(node.seatId);
}

export function primarySeatAction(node: OrgNode): "attach" | "detach" | null {
  if (!node.seatId) return null;
  return node.operatingMode === "vacant" ? "attach" : "detach";
}
