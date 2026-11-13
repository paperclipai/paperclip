import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigationType } from "react-router-dom";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import {
  startBrowserTracingController,
  type BrowserTracingController,
} from "@/lib/browser-tracing/controller";
import { routeTemplateForElements } from "@/lib/browser-tracing/route-template";

/**
 * Browser performance tracing for hosted Paperclip Cloud instances. Renders
 * nothing.
 *
 * It reads the signed-in session, like `SentryGate`. The server sends a
 * `browserTracing` config only for a cloud-managed instance with an operator
 * endpoint, so self-hosted installs, local development, and tests never start
 * the controller and never download the tracing SDK chunk. Sign-out clears the
 * session and stops tracing.
 *
 * `routes` is the same `<Route>` tree that `App` renders, so every page is
 * measured under its route pattern without per-page code.
 */
export function PageLoadTracker({ routes }: { routes: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const config = session?.browserTracing ?? null;
  const configKey = config ? JSON.stringify(config) : null;
  const location = useLocation();
  const navigationType = useNavigationType();
  const routesRef = useRef(routes);
  routesRef.current = routes;
  const controllerRef = useRef<BrowserTracingController | null>(null);

  useEffect(() => {
    if (!config) return;
    const pathname = window.location.pathname;
    const controller = startBrowserTracingController(config, {
      queryClient,
      initialPathname: pathname,
      initialRouteTemplate: routeTemplateForElements(routesRef.current, pathname),
    });
    controllerRef.current = controller;
    return () => {
      controller?.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
    // Keyed by value: the config object identity changes on every session refetch.
  }, [configKey, queryClient]);

  useLayoutEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.onLocationCommitted(
      location.pathname,
      navigationType,
      routeTemplateForElements(routesRef.current, location.pathname),
    );
  }, [location.pathname, navigationType]);

  return null;
}
