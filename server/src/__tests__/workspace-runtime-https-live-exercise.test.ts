/**
 * Opt-in LIVE exercise of the PAP-17158 in-place HTTPS backfill.
 *
 * Unlike `workspace-runtime.test.ts`, which drives the backfill through an
 * injected broker fake, this test uses the production exposure dependencies: the
 * real Unix-socket broker client, real Tailscale MagicDNS resolution, and a real
 * cert-validating HTTPS probe. It is the check that the fail-closed lifecycle
 * actually terminates in a browser-trusted `https://<node>.<tailnet>.ts.net:<port>`
 * URL rather than only in a mock's return value.
 *
 * It is skipped unless BOTH hold, because it mutates host-level Tailscale serve
 * state and must never run in CI:
 *
 *   - `PAPERCLIP_LIVE_BROKER_EXERCISE=1`
 *   - the broker socket exists (`PAPERCLIP_TAILSCALE_BROKER_SOCKET` or the default)
 *
 * Run it on a broker-provisioned host with:
 *
 *   PAPERCLIP_LIVE_BROKER_EXERCISE=1 pnpm --filter @paperclipai/server exec \
 *     vitest run src/__tests__/workspace-runtime-https-live-exercise.test.ts
 *
 * The caller must be the broker's configured service UID/GID and its listeners
 * must run as `BROKER_RUNTIME_UID`, or the broker correctly refuses to publish.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  reconcilePersistedRuntimeServicesOnStartup,
  resetRuntimeServicesForTests,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForProjectWorkspace,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.ts";

const DEFAULT_BROKER_SOCKET = "/run/paperclip-tailscale-broker/broker.sock";
const brokerSocketPath = process.env.PAPERCLIP_TAILSCALE_BROKER_SOCKET ?? DEFAULT_BROKER_SOCKET;

async function brokerSocketPresent() {
  try {
    return (await fs.stat(brokerSocketPath)).isSocket();
  } catch {
    return false;
  }
}

const optedIn = process.env.PAPERCLIP_LIVE_BROKER_EXERCISE === "1";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const live = optedIn && embeddedPostgresSupport.supported && (await brokerSocketPresent());

if (optedIn && !live) {
  console.warn(
    `[PAP-17158] live exercise opted in but skipped: broker socket at ${brokerSocketPath} `
      + `present=${await brokerSocketPresent()}, embeddedPostgres=${embeddedPostgresSupport.supported}`,
  );
}

(live ? describe : describe.skip)("PAP-17158 live HTTPS backfill exercise", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("pap17158-live");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await resetRuntimeServicesForTests();
    await tempDb?.stop?.();
  }, 60_000);

  it("upgrades a pre-existing HTTP workspace in place to a browser-trusted HTTPS URL", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pap17158-live-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "pap17158-live-home-"));
    const previousHome = process.env.PAPERCLIP_HOME;
    const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
    const previousMode = process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `pap17158-live-${randomUUID()}`;

    // An ephemeral legacy port rather than the real template's 45439, so this
    // never contends with the live workspace runtime on the same host.
    const reservePort = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const probe = net.createServer();
        await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
        const address = probe.address();
        const port = typeof address === "object" && address ? address.port : null;
        await new Promise<void>((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));
        if (port && port <= 55_535 && (port < 42_000 || port > 42_999)) return port;
      }
      throw new Error("failed to reserve a legacy port outside the broker range");
    };

    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const legacyPort = await reservePort();
    // Serves 200 at /api/health on the app port and its HMR companion, loopback
    // only — the shape the broker's /proc ownership proof requires.
    const command =
      "node -e \"const http=require('node:http');const p=Number(process.env.PORT);"
      + "for(const q of [p,p+10000])http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});"
      + "res.end(JSON.stringify({status:'ok',port:q}))}).listen(q,'127.0.0.1');setInterval(()=>{},1000)\"";
    const workspaceRuntime = {
      services: [
        {
          name: "paperclip-dev",
          command,
          port: legacyPort,
          // Pre-feature block: backend URL only, no exposure declaration.
          expose: { type: "url", urlTemplate: "http://127.0.0.1:{{port}}" },
          readiness: {
            type: "http",
            urlTemplate: "http://127.0.0.1:{{port}}/api/health",
            timeoutSec: 20,
            intervalMs: 100,
          },
          lifecycle: "shared",
          reuseScope: "project_workspace",
          stopPolicy: { type: "manual" },
        },
      ],
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "PAP-17158 live exercise",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: workspaceRoot,
      isPrimary: true,
      metadata: {
        runtimeConfig: { workspaceRuntime, desiredState: "running", serviceStates: { "0": "running" } },
      },
    });

    const evidence: Record<string, unknown> = {};
    try {
      // ---- Before: the workspace as it exists today, plain HTTP. ----
      process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = "off";
      const before = await startRuntimeServicesForWorkspaceControl({
        db,
        actor: { id: null, name: "Paperclip", companyId },
        issue: null,
        workspace: {
          baseCwd: workspaceRoot,
          source: "project_primary",
          projectId,
          workspaceId: projectWorkspaceId,
          repoUrl: null,
          repoRef: "HEAD",
          strategy: "project_primary",
          cwd: workspaceRoot,
          branchName: null,
          worktreePath: null,
          warnings: [],
          created: false,
        } satisfies RealizedExecutionWorkspace,
        config: { workspaceRuntime, desiredState: "running", serviceStates: { "0": "running" } },
        adapterEnv: {},
      });
      const runtimeServiceId = before[0]?.id;
      expect(runtimeServiceId).toBeTruthy();
      const [httpRow] = await db.select().from(workspaceRuntimeServices);
      expect(httpRow.exposure).toBeNull();
      evidence.beforeUrl = httpRow.url;
      evidence.beforePort = httpRow.port;
      expect(String(httpRow.url)).toMatch(/^http:\/\//);
      await expect(fetch(`http://127.0.0.1:${legacyPort}/api/health`)).resolves.toMatchObject({ ok: true });

      // ---- Deploy: production exposure deps, automatic default on. ----
      await resetRuntimeServicesForTests(); // restores the real broker client
      delete process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS;

      const result = await reconcilePersistedRuntimeServicesOnStartup(db);
      evidence.reconcile = result;
      expect(result.backfilled).toBe(1);
      expect(result.restartFailed).toBe(0);

      // ---- After: same row, real cert-validated HTTPS URL. ----
      const afterRows = await db.select().from(workspaceRuntimeServices);
      expect(afterRows).toHaveLength(1);
      const httpsRow = afterRows[0]!;
      expect(httpsRow.id).toBe(runtimeServiceId);
      evidence.afterUrl = httpsRow.url;
      evidence.afterPort = httpsRow.port;
      evidence.afterExposureState = httpsRow.exposure?.state;
      expect(httpsRow.status).toBe("running");
      expect(httpsRow.exposure?.state).toBe("ready");
      expect(String(httpsRow.url)).toMatch(/^https:\/\/.+\.ts\.net:\d+$/);
      expect(httpsRow.port).toBeGreaterThanOrEqual(42_000);
      expect(httpsRow.port).toBeLessThanOrEqual(42_999);

      // Strict TLS, no relaxed verification: this is the whole point.
      const probe = await fetch(`${httpsRow.url}/api/health`, { redirect: "error" });
      expect(probe.ok).toBe(true);
      evidence.liveProbeStatus = probe.status;

      // The old HTTP backend is gone, not merely shadowed.
      await expect(fetch(`http://127.0.0.1:${legacyPort}/api/health`)).rejects.toThrow();

      // ---- Repeat: idempotent, no churn. ----
      await resetRuntimeServicesForTests();
      const second = await reconcilePersistedRuntimeServicesOnStartup(db);
      expect(second.backfilled).toBe(0);
      const [repeatRow] = await db.select().from(workspaceRuntimeServices);
      expect(repeatRow.port).toBe(httpsRow.port);
      expect(repeatRow.url).toBe(httpsRow.url);
      evidence.repeatUrl = repeatRow.url;
    } finally {
      // eslint-disable-next-line no-console
      console.log("[PAP-17158 live exercise]", JSON.stringify(evidence, null, 2));
      // Deprovisions the broker lease as well as the backend process.
      await stopRuntimeServicesForProjectWorkspace({
        db,
        projectWorkspaceId,
        workspaceCwd: workspaceRoot,
      }).catch((error) => console.error("[PAP-17158] teardown failed", error));
      await resetRuntimeServicesForTests();
      await fs.rm(paperclipHome, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
      if (previousMode === undefined) delete process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS;
      else process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = previousMode;
    }
  }, 180_000);
});
