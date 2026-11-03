import { t } from "@/i18n";
import { companyUserLabelDisplayLabel, companyUserProfileDisplayLabel, type CompanyUserProfile } from "./company-members";
import { formatAssigneeUserLabel as canonicalAssigneeUserLabel, formatAssigneeUserDisplayLabel } from "./assignees";

/** Task messages load uploaded Paperclip avatars automatically, never remote URLs. */
export function paperclipHumanAvatarUrl(value: string | null | undefined): string | null {
  return value && /^\/api\/assets\/[^/?#]+\/content$/.test(value) ? value : null;
}

export function resolveIssueChatHumanAuthor(args: {
  authorName?: string | null;
  authorUserId?: string | null;
  currentUserId?: string | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
}) {
  const { authorName, authorUserId, currentUserId, userProfileMap } = args;
  const profile = authorUserId ? userProfileMap?.get(authorUserId) : null;
  const isCurrentUser = Boolean(authorUserId && currentUserId && authorUserId === currentUserId);
  return {
    isCurrentUser,
    authorName: profile?.label?.trim() || authorName?.trim() ||
      (authorUserId === "local-board" ? "Board" : isCurrentUser ? "You" : "User"),
    avatarUrl: profile?.image ?? null,
  };
}

/** Render-only projection. The shared adapter above stays locale-independent. */
export function resolveIssueChatHumanAuthorDisplay(args: {
  authorName?: string | null;
  authorUserId?: string | null;
  currentUserId?: string | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
}) {
  const { authorName, authorUserId, currentUserId, userProfileMap, userLabelMap } = args;
  const profile = authorUserId ? userProfileMap?.get(authorUserId) : null;
  const isCurrentUser = Boolean(authorUserId && currentUserId && authorUserId === currentUserId);
  const explicitLabel = companyUserProfileDisplayLabel(profile)?.trim()
    || companyUserLabelDisplayLabel(authorUserId, userLabelMap)?.trim();
  // Only generated fallbacks are translated; directory names and stored metadata stay unchanged.
  const canonicalFallback = canonicalAssigneeUserLabel(authorUserId, currentUserId) ?? "You";
  const displayAuthorName = !explicitLabel && authorName === canonicalFallback
    ? formatAssigneeUserDisplayLabel(authorUserId, currentUserId) ?? t("localizationTaskRuntime.ui_You_1efd4xo")
    : authorName?.trim();
  return {
    isCurrentUser,
    authorName: explicitLabel || displayAuthorName ||
      (authorUserId === "local-board" ? t("localizationTaskRuntime.ui_Board_1hpelzf") : isCurrentUser ? t("localizationTaskRuntime.ui_You_1efd4xo") : t("localizationTaskRuntime.ui_User_1qbyk9e")),
    avatarUrl: profile?.image ?? null,
  };
}
