interface ProfileLinkUser {
  id?: string | null;
  name?: string | null;
  email?: string | null;
}

function slugifyUserPart(value: string | null | undefined): string | null {
  const slug = value
    ?.trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

/**
 * In-app path of a user's profile page (`/u/:userSlug`).
 *
 * The profile endpoint resolves `:userSlug` against every member's name,
 * email local part, email, and principal id, and returns the first member
 * that matches. Display names are not unique, so a name-based slug can open a
 * namesake's profile instead of the intended one. The principal id is the one
 * candidate that is unique per member, so links to a known user always use
 * it; name and email slugs are only a fallback for sessions with no user id.
 */
export function userProfilePath(user: ProfileLinkUser | null | undefined): string {
  const candidates = [user?.id, user?.name, user?.email?.split("@")[0], user?.email];
  for (const candidate of candidates) {
    const slug = slugifyUserPart(candidate);
    if (slug) return `/u/${slug}`;
  }
  return "/u/me";
}
