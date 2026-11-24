import { useQuery } from "@tanstack/react-query";
import { cloudApi } from "@/api/cloud";
import type { CloudInstanceHealthStatus } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { cloudStackInviteUrl } from "@/lib/cloudLinks";

/**
 * Resolve the current tenant's feedback and invitation shortcuts from one portfolio read.
 *
 * Cloud owns feedback availability. Its People settings link is limited to
 * stack owners and admins, matching the Members page's invitation shortcut.
 */
export function useCloudSidebarLinks(cloud: CloudInstanceHealthStatus | null) {
  const isCloud = Boolean(cloud);
  const cloudStacksQuery = useQuery({
    queryKey: queryKeys.cloud.stacks,
    queryFn: () => cloudApi.listStacks(),
    enabled: isCloud,
    staleTime: 30_000,
  });
  if (!cloud) return { inviteUrl: null, slackFeedback: undefined };
  // Read from data, not `isError`: a cached stack list stays answerable while
  // a transient refetch fails. A no-data failure leaves the current stack
  // unknown, so the invitation shortcut stays hidden.
  const currentStack = cloudStacksQuery.data?.stacks.find((stack) => stack.isCurrent);
  const inviteUrl = currentStack?.role === "owner" || currentStack?.role === "admin"
    ? cloudStackInviteUrl(cloud.cloudBaseUrl, currentStack.stackSlug)
    : null;
  return { inviteUrl, slackFeedback: cloudStacksQuery.data?.slackFeedback };
}
