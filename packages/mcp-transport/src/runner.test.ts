import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { UnauthorizedError, TokenBindingError } from "./errors.js";
import { parseTransportArgv, runHttp, type McpServerLike } from "./runner.js";

describe("parseTransportArgv", () => {
  const env = {} as NodeJS.ProcessEnv;

  it("defaults to stdio", () => {
    expect(parseTransportArgv([], { env })).toMatchObject({ mode: "stdio" });
  });

  it("selects http on --http", () => {
    expect(parseTransportArgv(["--http"], { env }).mode).toBe("http");
  });

  it("reads --port and --host", () => {
    const parsed = parseTransportArgv(["--http", "--port", "9001", "--host", "0.0.0.0"], { env });
    expect(parsed).toEqual({ mode: "http", port: 9001, host: "0.0.0.0" });
  });

  it("prefers PORT env over --port", () => {
    const parsed = parseTransportArgv(["--http", "--port", "9001"], { env: { PORT: "9999" } as NodeJS.ProcessEnv });
    expect(parsed.port).toBe(9999);
  });

  it("falls back to the provided default port", () => {
    expect(parseTransportArgv(["--http"], { env, port: 1234 }).port).toBe(1234);
  });
});

describe("runHttp auth gate", () => {
  const servers: Array<{ close(): void }> = [];

  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  const neverBuild = () => {
    throw new Error("buildServer should not be called for a rejected request");
  };

  async function startWith(authenticate: (req: unknown) => unknown) {
    const server = await runHttp(
      {
        name: "test",
        buildServer: neverBuild as unknown as (c: unknown) => McpServerLike,
        configFromEnv: () => ({}),
        authenticate: authenticate as never,
      },
      { port: 0 },
    );
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("returns 401 with the error message when authentication fails", async () => {
    const base = await startWith(() => {
      throw new UnauthorizedError("Unauthorized: Invalid token");
    });
    const res = await fetch(base, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized: Invalid token" });
  });

  it("returns 500 for a token-binding error", async () => {
    const base = await startWith(() => {
      throw new TokenBindingError("Invalid token binding format in SSM");
    });
    const res = await fetch(base, { method: "POST", body: "{}" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Invalid token binding format in SSM" });
  });

  it("defaults an unknown thrown error to 401 at the auth stage", async () => {
    const base = await startWith(() => {
      throw new Error("boom");
    });
    const res = await fetch(base, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "boom" });
  });
});
