import type { Page, Request, Response } from "@playwright/test";

/** Private failure evidence only: no response bodies, headers, or query strings. */
export function observeBrowserBootstrap(page: Page) {
  const pending = new Map<Request, string>();
  const moduleResponses: { path: string; status: number }[] = [];
  const pathname = (url: string) => {
    try { return new URL(url).pathname; } catch { return "[invalid URL]"; }
  };
  const isModule = (request: Request) => ["script", "stylesheet"].includes(request.resourceType());
  const onRequest = (request: Request) => {
    if (isModule(request)) pending.set(request, pathname(request.url()));
  };
  const onFinished = (request: Request) => { pending.delete(request); };
  const onResponse = (response: Response) => {
    // A 304 is normally valid, but is useful evidence when module evaluation
    // never mounts the app. It must not itself turn a successful run into a fail.
    if (isModule(response.request()) && (response.status() === 304 || response.status() >= 400)) {
      moduleResponses.push({ path: pathname(response.url()), status: response.status() });
      if (moduleResponses.length > 50) moduleResponses.shift();
    }
  };
  const onNavigation = (frame: ReturnType<Page["mainFrame"]>) => {
    if (frame !== page.mainFrame()) return;
    pending.clear();
    moduleResponses.length = 0;
  };
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFinished);
  page.on("response", onResponse);
  page.on("framenavigated", onNavigation);
  return {
    async snapshot() {
      const state = await page.evaluate(() => ({
        readyState: document.readyState,
        rootPresent: document.getElementById("root") !== null,
        rootChildCount: document.getElementById("root")?.childElementCount ?? 0,
        serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
      })).catch(() => null);
      return { state, pendingModuleCount: pending.size, pendingModules: [...pending.values()].slice(0, 50), moduleResponses: [...moduleResponses] };
    },
    dispose() {
      page.off("request", onRequest);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFinished);
      page.off("response", onResponse);
      page.off("framenavigated", onNavigation);
    },
  };
}
