import { useEffect } from "react";
import { useSidebar } from "../context/SidebarContext";

/**
 * Effect-only component (renders nothing). While mounted, it asks the app
 * sidebar to default to **collapsed** (still peek-able) — the generic
 * "this route brings its own sidebar, keep the app one out of the way" case.
 *
 * Precedence is enforced by {@link SidebarContext}: an explicit user pin
 * (collapsed *or* expanded) always wins over this route request. When the
 * component unmounts — e.g. navigating away from the route that rendered it —
 * the cleanup clears the request and the global default is restored.
 *
 * Drop it anywhere inside a route's element tree:
 *
 * ```tsx
 * function MyPluginPage() {
 *   return (
 *     <>
 *       <RequestCollapsedSidebar />
 *       …
 *     </>
 *   );
 * }
 * ```
 */
export function RequestCollapsedSidebar() {
  const { setRouteRequestsCollapsed } = useSidebar();

  useEffect(() => {
    setRouteRequestsCollapsed(true);
    return () => setRouteRequestsCollapsed(false);
  }, [setRouteRequestsCollapsed]);

  return null;
}
