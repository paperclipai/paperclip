import { expect, it } from "vitest";
import { codexShellEnvironmentKeys } from "./codex-shell-environment.js";

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
    PAPERCLIP_GITHUB_BROKER_TOKEN: "broker", PAPERCLIP_NATIVE_MCP_TOKEN: "mcp",
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
