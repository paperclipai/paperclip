export type FixtureState =
  | "ready"
  | "loading"
  | "empty"
  | "failure"
  | "permission"
  | "saving"
  | "mutation-failure"
  | "mutation-permission";
export interface FixtureRequest {
  url: URL;
  method: string;
  body: Record<string, unknown>;
}
export interface FixtureRoute {
  path: string | RegExp;
  method?: string;
  state?: FixtureState;
  read: (
    request: FixtureRequest,
  ) => unknown | Response | Promise<unknown | Response>;
}
const pendingFixtures: Array<() => void> = [];
export function activatePreparedFixtures() {
  for (const activate of pendingFixtures.splice(0)) activate();
}
export function prepareFixtureApi(
  routes: FixtureRoute[],
  state: FixtureState = "ready",
) {
  return installFixtureApi(routes, state, true);
}
export function installFixtureApi(
  routes: FixtureRoute[],
  state: FixtureState = "ready",
  deferred = false,
) {
  let previous = window.fetch;
  const selectedCompany = localStorage.getItem("paperclip.selectedCompanyId");
  localStorage.setItem("paperclip.selectedCompanyId", "company-storybook");
  const requests: FixtureRequest[] = [];
  const fixtureFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), location.origin);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const route = routes.find(
      (candidate) =>
        (typeof candidate.path === "string"
          ? candidate.path === url.pathname
          : candidate.path.test(url.pathname)) &&
        (!candidate.method || candidate.method === method),
    );
    if (!route) {
      if (url.pathname.startsWith("/api/") && method !== "GET") {
        return Response.json(
          { error: `No isolated fixture for ${method} ${url.pathname}` },
          { status: 501 },
        );
      }
      return previous(input, init);
    }
    const routeState = route.state ?? state;
    const rawBody =
      init?.body ??
      (request && method !== "GET" ? await request.clone().text() : null);
    const body = rawBody
      ? (JSON.parse(String(rawBody)) as Record<string, unknown>)
      : {};
    const fixtureRequest = { url, method, body };
    requests.push(fixtureRequest);
    if (
      (routeState === "loading" && method === "GET") ||
      (routeState === "saving" && method !== "GET")
    ) {
      return new Promise<Response>(() => {});
    }
    if (
      routeState === "failure" ||
      routeState === "permission" ||
      (method !== "GET" &&
        (routeState === "mutation-failure" ||
          routeState === "mutation-permission"))
    ) {
      const denied =
        routeState === "permission" || routeState === "mutation-permission";
      return Response.json(
        {
          error: denied
            ? "You do not have permission to perform this action."
            : "The request failed. Please try again.",
        },
        { status: denied ? 403 : 500 },
      );
    }
    const result = await route.read(fixtureRequest);
    return result instanceof Response ? result : Response.json(result);
  };
  let active = !deferred;
  const activate = () => {
    previous = window.fetch;
    window.fetch = fixtureFetch;
    active = true;
  };
  if (deferred) pendingFixtures.push(activate);
  else window.fetch = fixtureFetch;
  return {
    requests,
    cleanup: () => {
      const pendingIndex = pendingFixtures.indexOf(activate);
      if (pendingIndex >= 0) pendingFixtures.splice(pendingIndex, 1);
      if (active) window.fetch = previous;
      if (selectedCompany === null)
        localStorage.removeItem("paperclip.selectedCompanyId");
      else localStorage.setItem("paperclip.selectedCompanyId", selectedCompany);
    },
  };
}
