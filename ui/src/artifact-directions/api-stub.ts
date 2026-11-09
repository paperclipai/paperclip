import { COMPANY } from "./fixtures";

/**
 * The lab's only "server". Every API call in the app goes through `fetch`, so
 * standing in for `/api/` here is enough to render real data-fetching
 * components with no backend and no module mocks. Nothing under `/api/` ever
 * reaches the network; everything else (fonts, assets) passes through.
 *
 * A direction that renders a real component registers the routes it needs.
 * `installApiStub` returns a restore, so a story can scope the stub to itself.
 */

/** Returns the JSON body for a path it owns, or `undefined` to pass. */
export type ApiRoute = (pathname: string, method: string) => unknown | undefined;

const routes: ApiRoute[] = [];

export function registerApiRoute(route: ApiRoute): void {
  routes.push(route);
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function respond(pathname: string, method: string): Response {
  for (const route of routes) {
    const body = route(pathname, method);
    if (body !== undefined) return json(body);
  }
  if (pathname.endsWith("/auth/get-session")) {
    return json({ session: { id: "lab-session", userId: "lab-user" }, user: { id: "lab-user", name: "Lab", email: "lab@acmehats.example" } });
  }
  if (pathname.endsWith("/companies")) return json([COMPANY]);
  // An unhandled call answers empty rather than failing, so it is never the
  // reason a frame looks broken; the debug line says what was asked for.
  console.debug("[artifact-directions] unhandled", method, pathname);
  return json({});
}

let holders = 0;
let realFetch: typeof window.fetch | null = null;
let stubFetch: typeof window.fetch | null = null;

/**
 * Stands in for `/api/` until the returned function is called. The lab page
 * installs once for its lifetime; a Storybook story installs on mount and
 * restores on unmount. Nested installs share one stub, and the last restore
 * puts the real `fetch` back — unless something else replaced it meanwhile.
 */
export function installApiStub(): () => void {
  if (holders === 0) {
    const original = window.fetch;
    const real = original.bind(window);
    realFetch = original;
    stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("/api/")) return real(input as RequestInfo, init);
      const { pathname } = new URL(url, window.location.origin);
      return respond(pathname, (init?.method ?? "GET").toUpperCase());
    }) as typeof window.fetch;
    window.fetch = stubFetch;
  }
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0 && realFetch && window.fetch === stubFetch) window.fetch = realFetch;
  };
}
