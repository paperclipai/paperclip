import { useQuery } from "@tanstack/react-query";
import { cloudApi } from "@/api/cloud";
import { queryKeys } from "@/lib/queryKeys";
import { cloudStackInviteUrl } from "@/lib/cloudLinks";
import { useCloudInstance } from "./useCloudInstance";

/**
 * Where the signed-in user invites people on a Paperclip Cloud instance, or
 * null when no Cloud invite link should be offered.
 *
 * Mirrors the Members page: Cloud manages human invitations in the current
 * stack's People settings, and only that stack's owner or admin may invite
 * (company roles can differ from Cloud roles, so the company membership is
 * not enough). Resolves to null on self-hosted instances, while the stack
 * portfolio is still loading or has failed, for every other stack role, and
 * when the stack slug or cloud base URL is unknown.
 *
 * Callers must not substitute the in-app Invites tab when this is null on a
 * Cloud instance: that tab drives in-app invitations, a different flow from
 * Cloud People settings. Offer no shortcut instead.
 */
export function useCloudInviteUrl(): string | null {
  const cloud = useCloudInstance();
  const isCloud = Boolean(cloud);
  const cloudStacksQuery = useQuery({
    queryKey: queryKeys.cloud.stacks,
    queryFn: () => cloudApi.listStacks(),
    enabled: isCloud,
    staleTime: 30_000,
    retry: false,
  });
  if (!cloud || cloudStacksQuery.isError) return null;
  const currentStack = cloudStacksQuery.data?.stacks.find((stack) => stack.isCurrent);
  if (currentStack?.role !== "owner" && currentStack?.role !== "admin") return null;
  return cloudStackInviteUrl(cloud.cloudBaseUrl, currentStack.stackSlug);
}
