import { afterEach, describe, expect, it } from "bun:test";
import { startExperimentalHttpServer } from "./experimental-server.js";

describe("experimental Bun HTTP server lifecycle", () => {
  const servers: Array<ReturnType<typeof startExperimentalHttpServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(({ stop }) => stop(true)));
  });

  it("starts, serves health/readiness, and stops without Express", async () => {
    const runtime = startExperimentalHttpServer({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    });
    servers.push(runtime);
    await runtime.ready;

    const baseUrl = `http://${runtime.server.hostname}:${runtime.server.port}`;
    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    expect((await health.json()) as { status: string }).toMatchObject({ status: "ok" });

    const readiness = await fetch(`${baseUrl}/api/ready`);
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({
      status: "not_ready",
      reason: "authentication_not_ready",
    });

    await runtime.stop();
    expect(await fetch(`${baseUrl}/api/health`).catch(() => null)).toBeNull();
    servers.splice(servers.indexOf(runtime), 1);
  });
});
