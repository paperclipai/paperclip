import type { ReactNode } from "react";
import { createRoutesFromChildren, matchRoutes, type RouteObject } from "react-router-dom";

/** Reported when no route in the tree matches the path. */
export const UNMATCHED_ROUTE_TEMPLATE = "(unmatched)";

/**
 * The route pattern that renders `pathname`, such as
 * `/:companyPrefix/issues/:issueId`. It is built only from the `path` props in
 * the route tree, so it never contains an id, a slug, a query string, or a
 * hash from the concrete URL. A splat route keeps its `*`.
 */
export function routeTemplateFor(routes: RouteObject[], pathname: string): string {
  const matches = matchRoutes(routes, pathname);
  if (!matches) return UNMATCHED_ROUTE_TEMPLATE;
  const segments: string[] = [];
  for (const match of matches) {
    const path = match.route.path?.replace(/^\/+|\/+$/g, "");
    if (path) segments.push(path);
  }
  return `/${segments.join("/")}`;
}

/** Same as `routeTemplateFor`, from the `<Route>` elements rendered by `<Routes>`. */
export function routeTemplateForElements(routeElements: ReactNode, pathname: string): string {
  return routeTemplateFor(createRoutesFromChildren(routeElements), pathname);
}
