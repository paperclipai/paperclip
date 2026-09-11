import { Navigate, Outlet } from "@/lib/router";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";

/**
 * Route gate for instance-settings pages the hosting operator can hide
 * (`instance.access`, `instance.plugins`, `instance.adapters`). Hidden pages
 * redirect to the settings root instead of rendering; until health is cached
 * nothing renders, so a hidden page never flashes. Under CloudAccessGate the
 * health response is always cached before board routes mount.
 */
export function HiddenSettingsPageGate({ pageKey }: { pageKey: string }) {
  const { hidden, loaded } = useHiddenSettings();

  if (!loaded) return null;
  if (hidden.has(pageKey)) return <Navigate to="/company/settings" replace />;
  return <Outlet />;
}
