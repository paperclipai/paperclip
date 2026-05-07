import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMcpConfigFile, mcpConfigFileName } from "./mcp-config.js";

describe("writeMcpConfigFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-config-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when mcpServers is undefined", async () => {
    const path = await writeMcpConfigFile(dir, undefined);
    expect(path).toBeNull();
  });

  it("returns null when mcpServers is empty", async () => {
    const path = await writeMcpConfigFile(dir, {});
    expect(path).toBeNull();
  });

  it("returns null when mcpServers is not an object", async () => {
    const path = await writeMcpConfigFile(dir, "not an object" as unknown as Parameters<typeof writeMcpConfigFile>[1]);
    expect(path).toBeNull();
  });

  it("writes a JSON file with mcpServers wrapper", async () => {
    const servers = {
      linear: {
        type: "stdio",
        command: "mcp-linear",
        args: [],
        env: { LINEAR_API_KEY: "x" },
      },
    };
    const path = await writeMcpConfigFile(dir, servers);
    expect(path).toBe(join(dir, mcpConfigFileName));
    const written = JSON.parse(readFileSync(path!, "utf-8"));
    expect(written).toEqual({ mcpServers: servers });
  });

  it("file permissions are 0o600 (owner read/write only)", async () => {
    const servers = {
      linear: { type: "stdio", command: "mcp-linear", env: { K: "v" } },
    };
    const path = await writeMcpConfigFile(dir, servers);
    const mode = statSync(path!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("preserves multiple servers and arbitrary keys", async () => {
    const servers = {
      linear: { type: "stdio", command: "mcp-linear", args: ["--flag"], env: { K: "v" } },
      remote: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer token" },
      },
    };
    const path = await writeMcpConfigFile(dir, servers);
    const written = JSON.parse(readFileSync(path!, "utf-8"));
    expect(written.mcpServers.linear.args).toEqual(["--flag"]);
    expect(written.mcpServers.remote.headers.Authorization).toBe("Bearer token");
  });
});
