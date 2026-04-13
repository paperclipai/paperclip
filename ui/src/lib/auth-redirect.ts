export function buildAuthRedirectPath(pathname: string, search = ""): string {
  const next = encodeURIComponent(`${pathname}${search}`);
  return `/auth?next=${next}`;
}
