import { expect, it } from "vitest";
import { codexShellEnvironmentKeys } from "./codex-shell-environment.js";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

it.skipIf(process.platform !== "win32")("preserves the Windows loader environment needed for tool networking", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end("connected");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    const allowed = new Set(codexShellEnvironmentKeys({}, {}, false).map(key => key.toUpperCase()));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
    const clear = ["SystemRoot", "SystemDrive", "WINDIR"].filter(key => !allowed.has(key.toUpperCase()))
      .map(key => `Remove-Item Env:${key} -ErrorAction SilentlyContinue;`).join(" ");
    const child = spawn("pwsh.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `${clear} $ErrorActionPreference='Stop'; (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${address.port}' -TimeoutSec 5).Content`],
      { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout.trim()).toBe("connected");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 15000);

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
