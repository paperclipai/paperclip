export const INSTANCE_SETTINGS_PATH_PREFIX = "/company/settings/instance";
export const DEFAULT_INSTANCE_SETTINGS_PATH = `${INSTANCE_SETTINGS_PATH_PREFIX}/general`;

const LEGACY_INSTANCE_SETTINGS_PATH_PREFIX = "/instance/settings";
const LEGACY_SETTINGS_PATH_PREFIX = "/settings";

function splitPath(rawPath: string): { pathname: string; search: string; hash: string } {
  const match = rawPath.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    pathname: match?.[1] ?? rawPath,
    search: match?.[2] ?? "",
    hash: match?.[3] ?? "",
  };
}

function normalizePathForMatching(rawPath: string): { pathname: string; search: string; hash: string } {
  const { pathname, search, hash } = splitPath(rawPath);
  const segments = pathname.split("/").filter(Boolean);
  const first = segments[0]?.toLowerCase();
  const second = segments[1]?.toLowerCase();

  if (first === "company") {
    return { pathname: `/${segments.join("/")}`, search, hash };
  }

  if (second === "company" || second === "settings" || second === "instance") {
    return { pathname: `/${segments.slice(1).join("/")}`, search, hash };
  }

  return { pathname, search, hash };
}

function instanceSettingsSuffix(pathname: string): string | null {
  if (pathname === INSTANCE_SETTINGS_PATH_PREFIX) return "/general";
  if (pathname.startsWith(`${INSTANCE_SETTINGS_PATH_PREFIX}/`)) {
    return pathname.slice(INSTANCE_SETTINGS_PATH_PREFIX.length);
  }

  if (pathname === LEGACY_INSTANCE_SETTINGS_PATH_PREFIX || pathname === "/instance") {
    return "/general";
  }
  if (pathname.startsWith(`${LEGACY_INSTANCE_SETTINGS_PATH_PREFIX}/`)) {
    return pathname.slice(LEGACY_INSTANCE_SETTINGS_PATH_PREFIX.length);
  }

  if (pathname === LEGACY_SETTINGS_PATH_PREFIX) return "/general";
  if (pathname.startsWith(`${LEGACY_SETTINGS_PATH_PREFIX}/`)) {
    return pathname.slice(LEGACY_SETTINGS_PATH_PREFIX.length);
  }

  return null;
}

export function normalizeRememberedInstanceSettingsPath(rawPath: string | null): string {
  if (!rawPath) return DEFAULT_INSTANCE_SETTINGS_PATH;

  const { pathname, search, hash } = normalizePathForMatching(rawPath);
  const suffix = instanceSettingsSuffix(pathname);
  if (!suffix) return DEFAULT_INSTANCE_SETTINGS_PATH;

  if (
    suffix === "/profile" ||
    suffix === "/general" ||
    suffix === "/access" ||
    suffix === "/heartbeats" ||
    suffix === "/plugins" ||
    suffix === "/experimental" ||
    suffix === "/data-recovery" ||
    suffix === "/adapters"
  ) {
    return `${INSTANCE_SETTINGS_PATH_PREFIX}${suffix}${search}${hash}`;
  }

  if (/^\/plugins\/[^/?#]+$/.test(suffix)) {
    return `${INSTANCE_SETTINGS_PATH_PREFIX}${suffix}${search}${hash}`;
  }

  return DEFAULT_INSTANCE_SETTINGS_PATH;
}
