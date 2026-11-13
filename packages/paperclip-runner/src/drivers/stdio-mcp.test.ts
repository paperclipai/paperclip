import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareStdioMcpBindings, stdioMcpLaunchBindings, STDIO_MCP_BINDINGS_ENV } from "./stdio-mcp.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "stdio-binding-")));
  roots.push(root);
  const command = join(root, "server");
  writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o555 });
  const binding = { name: "assigned-desktop", command, args: ["mcp", "--socket", join(root, "cua.sock")], env: { DESKTOP_STATE_DIR: root }, sha256: `sha256:${createHash("sha256").update(readFileSync(command)).digest("hex")}`, serialResource: join(root, "cua.sock") };
  const environment = { [STDIO_MCP_BINDINGS_ENV]: JSON.stringify([binding]), PAPERCLIP_NATIVE_MCP_PROXY: "/verified/runnerd" };
  return { root, binding, environment };
}

describe("assigned stdio MCP bindings", () => {
  it("uses only assigned bindings and creates private session-local config without bypassing approval", () => {
    const { root, binding, environment } = fixture();
    expect(stdioMcpLaunchBindings({})).toEqual([]);
    expect(stdioMcpLaunchBindings(environment)).toEqual([binding]);
    const servers = prepareStdioMcpBindings(environment, root);
    expect(servers).toEqual([{ name: binding.name, command: "/verified/runnerd", args: ["--stdio-mcp", join(root, "stdio-mcp/0.json")], env: {}, runnerOwned: false }]);
    expect(JSON.parse(readFileSync(servers[0]!.args[1]!, "utf8"))).toEqual(binding);
    expect(statSync(servers[0]!.args[1]!).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "stdio-mcp")).mode & 0o777).toBe(0o700);
    prepareStdioMcpBindings({}, root);
    expect(() => statSync(join(root, "stdio-mcp/0.json"))).toThrow();
  });
  it.each([
    ["missing digest", (b: Record<string, unknown>) => { delete b.sha256; }],
    ["dotted server name", (b: Record<string, unknown>) => { b.name = "nested.server"; }],
    ["loader override", (b: Record<string, unknown>) => { b.env = { NODE_OPTIONS: "--require=evil" }; }],
    ["relative command", (b: Record<string, unknown>) => { b.command = "cua-driver"; }],
    ["invalid arguments", (b: Record<string, unknown>) => { b.args = ["mcp", 1]; }],
    ["invalid environment", (b: Record<string, unknown>) => { b.env = { HOME: "bad\0value" }; }],
    ["reserved task bridge", (b: Record<string, unknown>) => { b.name = "paperclip"; }],
    ["reserved preconfigured bridge", (b: Record<string, unknown>) => { b.name = "paperclip_runner_forged"; }],
    ["unknown fields", (b: Record<string, unknown>) => { b.autoApprove = true; }],
  ])("rejects %s", (_name, mutate) => {
    const { binding, environment } = fixture();
    mutate(binding);
    expect(() => stdioMcpLaunchBindings({ ...environment, [STDIO_MCP_BINDINGS_ENV]: JSON.stringify([binding]) })).toThrow();
  });
  it("rejects executable drift, symlinks, and writable-by-others executables", () => {
    for (const mutation of [
      (command: string) => { chmodSync(command, 0o755); writeFileSync(command, "changed"); },
      (command: string) => { rmSync(command); symlinkSync(process.execPath, command); },
      (command: string) => chmodSync(command, 0o777),
    ]) {
      const { binding, environment } = fixture();
      mutation(binding.command);
      expect(() => stdioMcpLaunchBindings(environment)).toThrow();
    }
  });
  it("rejects duplicate names and collisions with the existing HTTP gateway", () => {
    const { binding, environment } = fixture();
    expect(() => stdioMcpLaunchBindings({ ...environment, [STDIO_MCP_BINDINGS_ENV]: JSON.stringify([binding, binding]) })).toThrow();
    expect(() => stdioMcpLaunchBindings({ ...environment, PAPERCLIP_NATIVE_MCP_NAME: binding.name })).toThrow();
  });
});
