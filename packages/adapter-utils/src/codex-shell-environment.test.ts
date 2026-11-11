import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { codexShellEnvironmentKeys } from "./codex-shell-environment.js";

it("retains Windows host context merged after the shell allowlist is built", () => {
  const names = codexShellEnvironmentKeys({}, {}, false);
  expect(names).toEqual(expect.arrayContaining(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE"]));
  expect(names).not.toContain("*");
  expect(names).not.toContain("OPENAI_API_KEY");
});

it.skipIf(process.platform !== "win32")("lets a filtered Windows shell reach the local control plane", async () => {
  const server = createServer((_req, res) => res.end("paperclip-test-ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const names = new Set(codexShellEnvironmentKeys({}, {}, false).map((name) => name.toUpperCase()));
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => names.has(name.toUpperCase()))
      .map(([name, value]) => [name.toUpperCase(), value]));
    // Node restores an omitted SystemRoot automatically; Codex's shell launcher
    // does not. An empty value prevents Node from hiding the missing-variable bug.
    env.SYSTEMROOT ??= "";
    const { port } = server.address() as AddressInfo;
    const { stdout } = await promisify(execFile)(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe"),
      ["--noproxy", "*", "--silent", "--show-error", "--fail", "--max-time", "5", `http://127.0.0.1:${port}/health`],
      { env, timeout: 7000 },
    );
    expect(stdout).toBe("paperclip-test-ok");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("admits assigned service secrets by name while retaining unassigned secret exclusions", () => {
  const assigned = { SLACK_BOT_TOKEN: "slack-canary", SERVICE_API_KEY: "key-canary", APP_SECRET: "secret-canary" };
  const names = codexShellEnvironmentKeys({ ...assigned, HOST_API_TOKEN: "host-canary" }, assigned, false);
  expect(names).toEqual(expect.arrayContaining(Object.keys(assigned)));
  expect(names).not.toContain("HOST_API_TOKEN");
  for (const value of Object.values(assigned)) expect(JSON.stringify(names)).not.toContain(value);
});

it("keeps Codex authentication, observability and runtime transports out of the service-secret opt-in", () => {
  const configured = {
    SLACK_BOT_TOKEN: "assigned", OPENAI_API_KEY: "openai", CODEX_API_KEY: "codex",
    PAPERCLIP_AI_PROVIDER_KEY: "managed", OTEL_EXPORTER_OTLP_HEADERS: "authorization=export",
    PAPERCLIP_NATIVE_MCP_TOKEN: "mcp",
  };
  const names = codexShellEnvironmentKeys(configured, configured, true);
  expect(names).toContain("SLACK_BOT_TOKEN");
  for (const key of Object.keys(configured).filter(key => key !== "SLACK_BOT_TOKEN")) expect(names).not.toContain(key);
});

it("does not turn a configured glob into permission to inherit other secrets", () => {
  const configured = { "*TOKEN*": "wildcard", "SERVICE[AB]_KEY": "pattern" };
  const names = codexShellEnvironmentKeys({ ...configured, HOST_TOKEN: "host" }, configured, true);
  expect(names).not.toContain("*TOKEN*");
  expect(names).not.toContain("SERVICE[AB]_KEY");
  expect(names).not.toContain("HOST_TOKEN");
});

it("removes the secret opt-in when a binding is removed or has not been resolved", () => {
  const environment = { SLACK_BOT_TOKEN: "old-provider-environment" };
  expect(codexShellEnvironmentKeys(environment, {}, false)).not.toContain("SLACK_BOT_TOKEN");
  expect(codexShellEnvironmentKeys(environment, { SLACK_BOT_TOKEN: { type: "secret_ref" } }, false)).not.toContain("SLACK_BOT_TOKEN");
  expect(codexShellEnvironmentKeys(environment, {}, true)).not.toContain("SLACK_BOT_TOKEN");
});

it("passes the run's GitHub broker capability so the gh and git launchers can fetch its credential", () => {
  const environment = { PAPERCLIP_GITHUB_BROKER_URL: "https://paperclip.example", PAPERCLIP_GITHUB_BROKER_TOKEN: "capability", PAPERCLIP_GITHUB_BRIDGE_TOKEN: "" };
  const names = codexShellEnvironmentKeys(environment, environment, true);
  expect(names).toEqual(expect.arrayContaining(["PAPERCLIP_GITHUB_BROKER_URL", "PAPERCLIP_GITHUB_BROKER_TOKEN"]));
  expect(names).not.toContain("PAPERCLIP_GITHUB_BRIDGE_TOKEN");
  expect(JSON.stringify(names)).not.toContain("capability");
});
