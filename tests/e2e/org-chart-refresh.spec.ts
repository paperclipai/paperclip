import path from "node:path";
import { expect, test } from "@playwright/test";
import tailwindcss from "../../ui/node_modules/@tailwindcss/vite/dist/index.mjs";
import { createServer, type ViteDevServer } from "../../ui/node_modules/vite/dist/node/index.js";

let server: ViteDevServer;
let origin: string;
const uiRoot = path.resolve(import.meta.dirname, "../../ui");
const probePath = path.join(uiRoot, "src/__org_chart_refresh_probe.tsx");

test.beforeAll(async () => {
  server = await createServer({
    root: uiRoot,
    configFile: false,
    resolve: { alias: { "@": path.join(uiRoot, "src") } },
    esbuild: { jsx: "automatic" },
    optimizeDeps: {
      noDiscovery: true,
      include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "react-router-dom", "lucide-react"],
    },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [tailwindcss(), {
      name: "org-chart-refresh-regression",
      resolveId(id) { if (id.endsWith("__org_chart_refresh_probe.tsx")) return probePath; },
      load(id) {
        if (id.split("?")[0] !== probePath) return;
        return `
          import React, { useEffect, useState } from "react";
          import { createRoot } from "react-dom/client";
          import { MemoryRouter } from "react-router-dom";
          import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
          import { CompanyProvider } from "/src/context/CompanyContext.tsx";
          import { BreadcrumbProvider } from "/src/context/BreadcrumbContext.tsx";
          import { OrgChart } from "/src/pages/OrgChart.tsx";
          import { queryKeys } from "/src/lib/queryKeys.ts";
          import "/src/index.css";
          const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
          client.setQueryData(queryKeys.auth.session, { user: { id: "test-user" }, session: { userId: "test-user" } });
          client.setQueryData(queryKeys.companies.list("test-user"), {
            companies: [{ id: "test-company", name: "Test company", issuePrefix: "ORG", status: "active" }], unauthorized: false,
          });
          function Probe() {
            const [refresh, setRefresh] = useState(0);
            useEffect(() => {
              const timer = setInterval(() => setRefresh(value => value + 1), 1000);
              return () => clearInterval(timer);
            }, []);
            // Each poll creates fresh objects, as the Agents page's filtered tree does.
            const tree = [{ id: "ceo", name: "CEO refresh " + refresh, role: "ceo",
              status: refresh % 2 ? "running" : "idle",
              reports: Array.from({ length: 9 }, (_, index) => ({
                id: "engineer-" + index, name: "Engineer " + index,
                role: "engineer", status: "idle", reports: [],
              })),
            }];
            return <main style={{ display: "flex", flexDirection: "column", width: 900, height: 600 }}>
              <output data-testid="refresh-count">{refresh}</output>
              <OrgChart embedded orgTree={tree} agents={[]} />
            </main>;
          }
          createRoot(document.getElementById("root")).render(
            <MemoryRouter><QueryClientProvider client={client}><CompanyProvider>
              <BreadcrumbProvider><Probe /></BreadcrumbProvider>
            </CompanyProvider></QueryClientProvider></MemoryRouter>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/src/__org_chart_refresh_probe.tsx"></script>');
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

test("embedded org chart retains browser zoom and pan through polling", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const body = pathname === "/api/auth/get-session"
      ? { user: { id: "test-user" }, session: { userId: "test-user" } }
      : pathname === "/api/companies"
        ? [{ id: "test-company", name: "Test company", issuePrefix: "ORG", status: "active" }]
        : [];
    await route.fulfill({ json: body });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  const viewport = page.getByTestId("org-chart-viewport");
  const layer = page.getByTestId("org-chart-card-layer");
  await expect(viewport).toBeVisible();
  await expect(page.getByText("CEO refresh", { exact: false })).toBeVisible();
  await expect.poll(async () => {
    const transform = await layer.evaluate(element => element.style.transform);
    return Number(transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1);
  }).toBeLessThan(1);
  const initial = await layer.evaluate(element => element.style.transform);
  const box = await viewport.boundingBox();
  if (!box) throw new Error("Missing chart viewport");
  await page.mouse.move(box.x + box.width - 25, box.y + box.height - 25);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => layer.evaluate(element => element.style.transform)).not.toBe(initial);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 65, box.y + box.height - 65);
  await page.mouse.up();
  const userTransform = await layer.evaluate(element => element.style.transform);
  const refresh = Number(await page.getByTestId("refresh-count").textContent());
  await expect.poll(async () => Number(await page.getByTestId("refresh-count").textContent())).toBeGreaterThanOrEqual(refresh + 3);
  expect(await layer.evaluate(element => element.style.transform)).toBe(userTransform);
  expect(errors).toEqual([]);
});
