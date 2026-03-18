export const DEFAULT_INSTANCE_SETTINGS_PATH = "/instance/settings/heartbeats";

export function normalizeRememberedInstanceSettingsPath(rawPath: string | null): string {
  if (!rawPath) return DEFAULT_INSTANCE_SETTINGS_PATH;

  const match = rawPath.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const pathname = match?.[1] ?? rawPath;
  const search = match?.[2] ?? "";
  const hash = match?.[3] ?? "";

  if (
    pathname === "/instance/settings/heartbeats" ||
    pathname === "/instance/settings/plugins" ||
    pathname === "/instance/settings/experimental"
  ) {
    return `${pathname}${search}${hash}`;
  }

  if (/^\/instance\/settings\/plugins\/[^/?#]+$/.test(pathname)) {
    return `${pathname}${search}${hash}`;
  }

  return DEFAULT_INSTANCE_SETTINGS_PATH;
}
