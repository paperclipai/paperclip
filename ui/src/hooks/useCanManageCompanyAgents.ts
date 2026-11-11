import { useQuery } from "@tanstack/react-query";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Whether a board may terminate agents in `companyId`, judged from the current
 * board access snapshot.
 *
 * The terminate route requires the company `agents:create` grant. Local
 * implicit boards and instance admins always pass; otherwise the active
 * company membership must be owner, admin, or operator, the roles that carry
 * that grant by default. Legacy members normalize to operator. Resolves to
 * false while the snapshot is unknown. The server stays authoritative; this
 * only decides whether to offer the action.
 */
export function canManageCompanyAgents(
  companyId: string | null | undefined,
  boardAccess: CurrentBoardAccess | undefined,
): boolean {
  if (!boardAccess) return false;
  if (boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin) return true;
  if (!companyId) return false;
  const membership = boardAccess.memberships?.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  return membership?.membershipRole === "owner" ||
    membership?.membershipRole === "admin" ||
    membership?.membershipRole === "operator" ||
    membership?.membershipRole === "member";
}

export function useCanManageCompanyAgents(companyId: string | null | undefined): boolean {
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: !!companyId,
    staleTime: 30_000,
  });
  return canManageCompanyAgents(companyId, boardAccess.data);
}
