import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRequire } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import { build } from "esbuild";
import { createHostClientHandlers, PLUGIN_RPC_ERROR_CODES, type HostServices, type HostToWorkerMethods } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";
import { company, config, database, envelope, initialise, namespace } from "./helpers.js";
import { createPluginWorkerHandle } from "../../../../server/src/services/plugin-worker-manager.js";

const tsxLoader = createRequire(new URL("../../../../server/package.json", import.meta.url)).resolve("tsx");

vi.mock("../../../../server/src/middleware/logger.js", () => {
  const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: () => logger };
  return { logger, httpLogger: vi.fn() };
});

describe("Slack delivery across the native host invocation lifetime", () => {
  it("drains late socket events with proactive scope and respects revocation after reconfiguration", async () => {
    const root = await mkdtemp(fileURLToPath(new URL("../.invocation-test-", import.meta.url)));
    const pg = new PGlite();
    const db = database(pg);
    const listMembers = vi.fn(async () => [{ companyId: company, principalType: "user", principalId: "human", status: "active", membershipRole: "owner" }]);
    const listIssues = vi.fn(async () => []);
    const handlers = createHostClientHandlers({
      pluginId: manifest.id, capabilities: manifest.capabilities,
      services: {
        db: {
          query: ({ sql, params }: { sql: string; params?: unknown[] }) => db.query(sql, params),
          execute: ({ sql, params }: { sql: string; params?: unknown[] }) => db.execute(sql, params),
        },
        access: { listMembers }, issues: { list: listIssues }, logger: { log: async () => {} },
      } as unknown as HostServices,
    });
    const entrypointPath = join(root, "worker.mjs");
    const handle = createPluginWorkerHandle(manifest.id, {
      entrypointPath, manifest, config: {}, databaseNamespace: namespace, apiVersion: 1,
      execArgv: ["--import", tsxLoader],
      instanceInfo: { instanceId: "synthetic-instance", hostVersion: "1.0.0" },
      hostHandlers: handlers, proactiveCompanyScopes: [company],
    });
    const request = (routeKey: string, body?: unknown) => handle.call("handleApiRequest", {
      routeKey, companyId: company, body, actor: { actorType: "user", actorId: "human" },
    } as HostToWorkerMethods["handleApiRequest"][0]);
    try {
      await initialise(pg);
      await build({ entryPoints: [fileURLToPath(new URL("./fixtures/invocation-worker.ts", import.meta.url))], outfile: entrypointPath,
        bundle: true, platform: "node", format: "esm", target: "node24", packages: "external" });
      await handle.start();
      await handle.call("configChanged", { config: { ...config }, companyId: company });
      await request("release", envelope({ text: "status" }));
      await vi.waitFor(async () => {
        const result = await request("status");
        expect(result.body).toMatchObject({ expiredInvocationCode: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
          replies: 1, recent: [{ phase: "done" }], diagnostics: { received: 1, accepted: 1 } });
      }, { timeout: 15_000, interval: 100 });
      expect(listMembers).toHaveBeenCalledTimes(1);
      expect(listIssues).toHaveBeenCalledTimes(1);

      // Reconfiguration must not replace the setup-created timer with one
      // carrying a new, equally short-lived config invocation.
      await handle.call("configChanged", { config: { ...config }, companyId: company });
      await request("release", { ...envelope({ text: "status" }), event_id: "EvReconfigured" });
      await vi.waitFor(async () => {
        const result = await request("status");
        expect(result.body).toMatchObject({ replies: 2, recent: [{ phase: "done" }, { phase: "done" }] });
      }, { timeout: 15_000, interval: 100 });
      expect(listMembers).toHaveBeenCalledTimes(2);
      expect(listIssues).toHaveBeenCalledTimes(2);

      await handle.call("configChanged", { config: { ...config }, companyId: company });
      handle.setProactiveCompanyScopes([]);
      await request("release", { ...envelope({ text: "status" }), event_id: "EvRevoked" });
      await vi.waitFor(async () => {
        const result = await request("status");
        expect(result.body).toMatchObject({ replies: 2, recent: [{ phase: "uncertain" }, { phase: "done" }, { phase: "done" }] });
      }, { timeout: 15_000, interval: 100 });
      expect(listMembers).toHaveBeenCalledTimes(2);
      expect(listIssues).toHaveBeenCalledTimes(2);
    } finally {
      await handle.stop().catch(() => {});
      await pg.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
