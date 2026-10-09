import { useEffect } from "react";
import { useSidebar } from "../context/SidebarContext";

/**
 * Back-compat effect for routes that previously requested the app sidebar's
 * retired icon rail. The request remains observable to older integrations,
 * but {@link SidebarContext} keeps the global navigation expanded. Cleanup
 * still clears the request when the route unmounts.
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
