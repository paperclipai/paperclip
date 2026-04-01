import type { CompanyMember } from "../api/access";

export type SeatAttachMemberOption = {
  userId: string;
  membershipRole: string | null;
};

export function activeUserSeatCandidates(members: CompanyMember[]): SeatAttachMemberOption[] {
  const seen = new Set<string>();
  return members
    .filter((member) => member.principalType === "user" && member.status === "active")
    .sort((left, right) => {
      if ((left.membershipRole ?? "") !== (right.membershipRole ?? "")) {
        return (left.membershipRole ?? "").localeCompare(right.membershipRole ?? "");
      }
      return left.principalId.localeCompare(right.principalId);
    })
    .flatMap((member) => {
      const userId = member.principalId.trim();
      if (!userId || seen.has(userId)) return [];
      seen.add(userId);
      return [{ userId, membershipRole: member.membershipRole ?? null }];
    });
}
