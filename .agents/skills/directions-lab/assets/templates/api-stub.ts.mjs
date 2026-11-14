export default (ctx) => `import { COMPANY } from "./fixtures";

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
    return json({ session: { id: "lab-session", userId: "lab-user" }, user: { id: "lab-user", name: "Lab", email: \`lab@\${COMPANY.name}.example\` } });
  }
  if (pathname.endsWith("/companies")) return json([COMPANY]);
  console.debug("${ctx.tag} unhandled", method, pathname);
  return json({});
}

let holders = 0;
let realFetch: typeof window.fetch | null = null;
let stubFetch: typeof window.fetch | null = null;

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
`;
