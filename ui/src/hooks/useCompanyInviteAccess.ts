import { useQuery } from "@tanstack/react-query";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { useOptionalCompany } from "@/context/CompanyContext";

/**
 * Whether a board may invite people to `companyId` on a self-hosted instance,
 * judged from the current board access snapshot.
 *
 * Mirrors the other client-side role gates (`ToolsAdminGate`, the run
 * ledger): local implicit boards and instance admins always pass; otherwise
 * the active company membership must be owner, admin, or operator, the roles
 * that carry the default `users:invite` grant. Legacy members normalize to
 * operator. Resolves to false while the snapshot is unknown.
 * The server stays authoritative; this only decides whether to offer a
 * shortcut that would otherwise end in a permission error.
 */
export function canInviteCompanyMembers(
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

/**
 * Whether the signed-in board may invite people to the selected company on a
 * self-hosted instance. Pass `enabled: false` on Cloud, where invitations live
 * in the stack's People settings and use a different rule
 * (see `useCloudInviteUrl`).
 */
export function useCanInviteCompanyMembers(enabled = true): boolean {
  const company = useOptionalCompany();
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled,
    staleTime: 30_000,
  });
  return enabled && canInviteCompanyMembers(company?.selectedCompanyId, boardAccess.data);
}
