interface ProjectPermanentUrlInput {
  origin: string;
  pathname: string;
  projectId: string;
  search?: string;
  hash?: string;
}

function normalizeUrlSuffix(value: string | undefined, marker: "?" | "#") {
  if (!value) return "";
  return value.startsWith(marker) ? value : `${marker}${value}`;
}

function normalizeOrigin(origin: string) {
  return origin.replace(/\/+$/, "");
}

export function permanentProjectPath(pathname: string, projectId: string): { path: string; replaced: boolean } {
  const encodedProjectId = encodeURIComponent(projectId);
  const normalizedPathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const segments = normalizedPathname.split("/");
  const projectsIndex = segments.findIndex((segment) => segment.toLowerCase() === "projects");

  if (projectsIndex >= 0 && segments[projectsIndex + 1]) {
    segments[projectsIndex + 1] = encodedProjectId;
    return { path: segments.join("/") || `/projects/${encodedProjectId}`, replaced: true };
  }

  return { path: `/projects/${encodedProjectId}`, replaced: false };
}

export function buildProjectPermanentUrl({
  origin,
  pathname,
  projectId,
  search,
  hash,
}: ProjectPermanentUrlInput): string {
  const permanentPath = permanentProjectPath(pathname, projectId);
  const suffix = permanentPath.replaced
    ? `${normalizeUrlSuffix(search, "?")}${normalizeUrlSuffix(hash, "#")}`
    : "";

  return `${normalizeOrigin(origin)}${permanentPath.path}${suffix}`;
}
