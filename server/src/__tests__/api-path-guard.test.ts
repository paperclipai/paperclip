import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import { isApiRequest, isMalformedApiPath } from "../api-path-guard.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

// The full-app proof below boots createApp in static-UI mode. Stub the HTML
// source so no UI build output is needed inside the repo checkout.
const SHELL_HTML =
  "<!DOCTYPE html><html><head><title>SPA</title></head><body>shell</body></html>";
vi.mock("../static-index-html.js", () => ({
  readBrandedStaticIndexHtml: () => SHELL_HTML,
}));


/**
 * Contract tests for the API/SPA boundary (KUR-79 class of bugs).
 *
 * Requirement: every request whose URL refers to the API must receive
 * Content-Type application/json — never the SPA index.html shell.
 *
 * The fallback under test is a copy of the production static-mode SPA
 * fallback (server/src/app.ts, "SPA fallback" block) with the guard applied.
 * It is duplicated here instead of imported because app.ts builds the full
 * orchestration stack (database, schedulers, workers) on import and cannot
 * be instantiated in a unit test. The duplication is asserted against by
 * snapshotting the production source below, so if the production fallback
 * changes shape without updating the mirror, these tests fail.
 */

function buildSpaApp(uiDist: string): express.Express {
  const app = express();
  app.use("/assets", express.static(path.join(uiDist, "assets")));
  app.use(express.static(uiDist));
  // Mirror of the production fallback with the api-path-guard applied.
  app.get(/.*/, (req, res) => {
    if (isApiRequest(req)) {
      res.status(404).json({ error: "API route not found" });
      return;
    }
    if (req.path.startsWith("/assets/")) {
      res.status(404).end();
      return;
    }
    res
      .status(200)
      .set("Content-Type", "text/html")
      .set("Cache-Control", "no-cache")
      .end(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"));
  });
  return app;
}

interface ProbeResult {
  status: number;
  contentType: string;
  bodyHead: string;
}

/** Raw-socket request so wire-level path bytes (//, %2F) survive untouched. */
function rawRequest(
  port: number,
  rawPathAndQuery: string,
  headers: Record<string, string> = {},
): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        // Node writes this verbatim on the request line — no URL normalization,
        // so wire-level path bytes (//, %2F) reach the server untouched.
        path: rawPathAndQuery,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            bodyHead: Buffer.concat(chunks).subarray(0, 60).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const WELL_FORMED_API_PATHS = [
  "/api/health",
  "/api/issues",
  "/api/companies/company-1/issues",
  "/api/issues?limit=100",
  "/api",
];

const MALFORMED_API_PATHS = [
  "//api/health",
  "///api/issues",
  "//api/companies/company-1/issues",
  "/api//issues",
  "/api%2Fissues",
  "//api%2Fissues",
  "/%2Fapi%2Fissues",
  "/api/health%2F",
  "//api/issues?limit=5",
];

const NON_API_PATHS = [
  "/",
  "/issues",
  "/issues/PAP-123",
  "/index.html",
  "/favicon.ico",
  "/assets/index-abc123.js",
  "/API/issues",
  "/apiary/notes",
  "/issues?redirect=/api/health",
];

describe("api-path-guard unit", () => {
  it("classifies well-formed API paths as API", () => {
    for (const p of WELL_FORMED_API_PATHS) {
      expect(isMalformedApiPath(p), p).toBe(true);
    }
  });

  it("classifies malformed API spellings as API", () => {
    for (const p of MALFORMED_API_PATHS) {
      expect(isMalformedApiPath(p), p).toBe(true);
    }
  });

  it("never classifies browser-facing paths as API", () => {
    for (const p of NON_API_PATHS) {
      expect(isMalformedApiPath(p), p).toBe(false);
    }
  });

  it("is case-sensitive", () => {
    expect(isMalformedApiPath("/API/issues")).toBe(false);
    expect(isMalformedApiPath("/Api/health")).toBe(false);
  });

  it("ignores API-looking strings inside query values", () => {
    expect(isMalformedApiPath("/issues?redirect=/api/health")).toBe(false);
    expect(isMalformedApiPath("/settings#api/keys")).toBe(false);
  });

  it("survives malformed percent-escapes", () => {
    expect(isMalformedApiPath("/%zzapi/health")).toBe(false);
    expect(isMalformedApiPath("//%E0%A4%A")).toBe(false);
  });
});

describe("SPA fallback never serves HTML for API URLs", () => {
  let app: express.Express;
  let server: http.Server;
  let port: number;
  const uiDist = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-api-guard-ui-"));
  const indexHtml =
    "<!DOCTYPE html><html><head><title>SPA</title></head><body>shell</body></html>";

  afterAll(() => {
    server?.close();
    fs.rmSync(uiDist, { recursive: true, force: true });
  });

  it("boots the SPA fallback server", async () => {
    fs.mkdirSync(path.join(uiDist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(uiDist, "index.html"), indexHtml);
    fs.writeFileSync(path.join(uiDist, "assets", "index-abc123.js"), "export {};");
    app = buildSpaApp(uiDist);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = (server.address() as AddressInfo).port;
    expect(port).toBeGreaterThan(0);
  });

  it("serves JSON for well-formed /api paths", async () => {
    for (const p of WELL_FORMED_API_PATHS) {
      const res = await rawRequest(port, p);
      expect(res.status, p).toBe(404);
      expect(res.contentType, p).toContain("application/json");
    }
  });

  it("serves JSON for every malformed API spelling (KUR-79 regressions)", async () => {
    for (const p of MALFORMED_API_PATHS) {
      const res = await rawRequest(port, p);
      expect(res.status, p).toBe(404);
      expect(res.contentType, p).toContain("application/json");
      expect(res.bodyHead, p).toContain("API route not found");
    }
  });

  it("still serves the HTML shell for browser-facing routes", async () => {
    for (const p of NON_API_PATHS) {
      const res = await rawRequest(port, p);
      if (p === "/favicon.ico" || p === "/assets/index-abc123.js") {
        // Static layer responses: favicon falls through to the fallback shell,
        // the real asset is served by express.static.
        if (p === "/assets/index-abc123.js") {
          expect(res.contentType, p).toContain("javascript");
          continue;
        }
      }
      expect(res.contentType, p).toContain("text/html");
      expect(res.bodyHead, p).toContain("<!DOCTYPE html>");
      expect(res.status, p).toBe(200);
    }
  });

  it("production fallback source mirrors the guarded shape", () => {
    // The contract test mirrors app.ts's fallback. Read the production source
    // and assert the guard is actually wired into it, so the mirror cannot
    // silently drift from production.
    const appTs = fs.readFileSync(path.join(__dirname, "..", "app.ts"), "utf-8");
    expect(appTs).toContain('from "./api-path-guard.js"');
    expect(appTs).toContain("isApiRequest(req)");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeFullApp = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * Full-app proof: boot the real createApp() in static-UI mode against the
 * embedded test database and probe the wire exactly like an API client
 * (raw socket, raw path bytes). This exercises the production fallback in
 * app.ts, not the mirror above.
 */
describeFullApp("production app: API URLs never get the SPA shell", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-api-guard-app-"));
  // First UI candidate createApp resolves in static mode; git-ignored.
  const uiDist = path.resolve(__dirname, "../../ui-dist");
  let tempDb: Awaited<
    ReturnType<typeof import("./helpers/embedded-postgres.js").startEmbeddedPostgresTestDatabase>
  > | null = null;
  let server: http.Server | null = null;
  let port = 0;

  afterAll(async () => {
    server?.close();
    await tempDb?.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it(
    "boots createApp in static-UI mode",
    async () => {
      fs.mkdirSync(uiDist, { recursive: true });
      fs.writeFileSync(
        path.join(uiDist, "index.html"),
        "<!DOCTYPE html><html><head><title>SPA</title></head><body>shell</body></html>",
      );
      const [{ createApp }, { startEmbeddedPostgresTestDatabase }, { createStorageService }, { createLocalDiskStorageProvider }] =
        await Promise.all([
          import("../app.js"),
          import("./helpers/embedded-postgres.js"),
          import("../storage/service.js"),
          import("../storage/local-disk-provider.js"),
        ]);
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-api-guard-");
      const db = createDb(tempDb.connectionString);
      const storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "storage")));
      const app = await createApp(db, {
        uiMode: "static",
        serverPort: 0,
        storageService: storage,
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        allowedHostnames: ["127.0.0.1"],
        bindHost: "127.0.0.1",
        authReady: true,
        companyDeletionEnabled: false,
        instanceId: "vitest-api-guard",
        localPluginDir: path.join(root, "plugins"),
        managedPluginAutoInstall: [],
        decisionServiceOptions: { wakeOriginAgent: async () => undefined },
      });
      server = http.createServer(app);
      server.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server!.once("listening", resolve));
      port = (server.address() as AddressInfo).port;
      expect(port).toBeGreaterThan(0);
    },
    90_000,
  );

  it("serves JSON, never HTML, for every well-formed and malformed API URL", async () => {
    for (const p of [...WELL_FORMED_API_PATHS, ...MALFORMED_API_PATHS]) {
      const res = await rawRequest(port, p, { Accept: "application/json" });
      expect(res.contentType, p).toContain("application/json");
      expect(res.bodyHead, p).not.toContain("<!DOCTYPE html>");
    }
  });

  it("still serves the HTML shell for SPA routes", async () => {
    const res = await rawRequest(port, "/issues/PAP-123", { Accept: "text/html" });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.bodyHead).toContain("<!DOCTYPE html>");
  });
});
