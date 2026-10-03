import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeRestartReportVersion, waitForHealth } from "../commands/service.js";

const temporaryDirectories: string[] = [];
const servers: http.Server[] = [];
const savedEnv = {
  home: process.env.PAPERCLIP_HOME,
  config: process.env.PAPERCLIP_CONFIG,
  instance: process.env.PAPERCLIP_INSTANCE_ID,
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  restoreEnv("PAPERCLIP_HOME", savedEnv.home);
  restoreEnv("PAPERCLIP_CONFIG", savedEnv.config);
  restoreEnv("PAPERCLIP_INSTANCE_ID", savedEnv.instance);
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Points the health probe at a local server and the instance root at a temporary home.
 *
 * `body` is read per request, so a case can change what the route reports without
 * restarting the server.
 */
async function withInstance(body: () => Record<string, unknown>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-restart-health-"));
  temporaryDirectories.push(home);
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The test health server did not bind a port.");
  servers.push(server);
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = "default";
  const instanceRoot = path.join(home, "instances", "default");
  await fs.mkdir(instanceRoot, { recursive: true });
  const configPath = path.join(instanceRoot, "config.json");
  await fs.writeFile(configPath, `${JSON.stringify({
    $meta: { version: 1, updatedAt: new Date().toISOString(), source: "onboard" },
    database: { mode: "embedded-postgres" },
    logging: { mode: "file" },
    server: { deploymentMode: "authenticated", host: "127.0.0.1", port: address.port },
  }, null, 2)}\n`, "utf8");
  process.env.PAPERCLIP_CONFIG = configPath;
  return {
    instanceRoot,
    writeReport: async (report: Record<string, unknown>) => {
      await fs.writeFile(path.join(instanceRoot, "hot-restart-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    },
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("restart health validation with a redacted version", () => {
  it("confirms the payload from the hot-restart report when the route omits the version", async () => {
    const instance = await withInstance(() => ({ status: "ok", deploymentMode: "authenticated" }));
    await instance.writeReport({
      version: 1,
      requestedAt: "2026-09-27T17:41:56.193Z",
      completedAt: "2026-09-27T17:42:20.000Z",
      previousServerPid: 100,
      newServerPid: 200,
      previousServerVersion: null,
      newServerVersion: "2026.925.0-nightly.0",
    });

    await expect(waitForHealth("default", "2026.925.0-nightly.0", "2026-09-27T17:41:56.193Z", 5_000))
      .resolves.toEqual({ ok: true, serverVersion: "2026.925.0-nightly.0" });
  });

  it("ignores a report left behind by an earlier restart", async () => {
    const instance = await withInstance(() => ({ status: "ok", deploymentMode: "authenticated" }));
    await instance.writeReport({
      version: 1,
      requestedAt: "2026-09-27T17:18:47.792Z",
      newServerPid: 200,
      newServerVersion: "2026.922.0-canary.5",
    });

    await expect(waitForHealth("default", "2026.925.0-nightly.0", "2026-09-27T17:41:56.193Z", 1_200))
      .rejects.toThrow("Paperclip service did not become healthy at version 2026.925.0-nightly.0");
  });

  it("rejects a report that contradicts a version the health route reports", async () => {
    // The route names a version and the report names a different one. The live answer wins, so
    // the wait must not accept the report and must keep polling until its deadline.
    const instance = await withInstance(() => ({ status: "ok", version: "2026.922.0-canary.5" }));
    await instance.writeReport({
      version: 1,
      requestedAt: "2026-09-27T17:41:56.193Z",
      newServerPid: 200,
      newServerVersion: "2026.925.0-nightly.0",
    });

    await expect(waitForHealth("default", "2026.925.0-nightly.0", "2026-09-27T17:41:56.193Z", 1_200))
      .rejects.toThrow("Paperclip service did not become healthy at version 2026.925.0-nightly.0");
  });

  it("still accepts a version the health route exposes", async () => {
    await withInstance(() => ({ status: "ok", version: "2026.925.0-nightly.0" }));

    await expect(waitForHealth("default", "2026.925.0-nightly.0", null, 5_000))
      .resolves.toEqual({ ok: true, serverVersion: "2026.925.0-nightly.0" });
  });
});

describe("probeRestartReportVersion", () => {
  it("reads only the report written for the requested restart", async () => {
    const instance = await withInstance(() => ({ status: "ok" }));
    await instance.writeReport({ requestedAt: "request-a", newServerVersion: "1.0.0" });

    await expect(probeRestartReportVersion("default", "request-a")).resolves.toBe("1.0.0");
    await expect(probeRestartReportVersion("default", "request-b")).resolves.toBeNull();
  });

  it("reports no version when the report is missing or unreadable", async () => {
    await withInstance(() => ({ status: "ok" }));

    await expect(probeRestartReportVersion("default", "request-a")).resolves.toBeNull();
  });
});
