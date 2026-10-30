import path from "node:path";
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "../../ui/node_modules/vite/dist/node/index.js";

let server: ViteDevServer;
let origin: string;
const uiRoot = path.resolve(import.meta.dirname, "../../ui");
const probePath = path.join(uiRoot, "src/__company_context_probe.tsx");

// Use real Vite module instances and React contexts. Re-importing a refreshed
// consumer must still see a provider retained from the previous module version.
test.beforeAll(async () => {
  server = await createServer({
    root: uiRoot,
    configFile: false,
    resolve: { alias: { "@": path.join(uiRoot, "src") } },
    esbuild: { jsx: "automatic" },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "company-context-regression",
      resolveId(id) { if (id === "/src/__company_context_probe.tsx") return probePath; },
      load(id) {
        if (id !== probePath) return;
        return `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
          import { CompanyProvider, useCompany } from "/src/context/CompanyContext.tsx";
          const root = createRoot(document.getElementById("root"));
          const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
          function render(hook, generation) {
            function Consumer() { return <main>{generation + ":" + (hook().selectedCompanyId ?? "loading")}</main>; }
            root.render(<QueryClientProvider client={client}><CompanyProvider><Consumer /></CompanyProvider></QueryClientProvider>);
          }
          render(useCompany, "initial");
          window.refreshConsumer = async () => {
            const refreshed = await import(/* @vite-ignore */ "/src/context/CompanyContext.tsx?t=" + Date.now());
            render(refreshed.useCompany, "refreshed");
          };
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/src/__company_context_probe.tsx"></script>');
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server?.close(); });

test("a refreshed company consumer reads the retained provider", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const body = pathname === "/api/auth/get-session"
      ? { user: { id: "test-user" }, session: { userId: "test-user" } }
      : pathname === "/api/companies"
        ? [{ id: "test-company", name: "Test company", status: "active" }]
        : [];
    await route.fulfill({ json: body });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); });
  await page.goto(origin);
  await expect(page.getByRole("main")).toHaveText("initial:test-company");
  await page.evaluate(() => (window as unknown as { refreshConsumer: () => Promise<void> }).refreshConsumer());
  await expect(page.getByRole("main")).toHaveText("refreshed:test-company");
  expect(errors).toEqual([]);
});
