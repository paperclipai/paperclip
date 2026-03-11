import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildSandboxConfig } from "./build-config.js";

const baseValues: CreateConfigValues = {
  adapterType: "sandbox",
  sandboxProviderType: "cloudflare",
  sandboxAgentType: "codex_local",
  sandboxBaseUrl: "",
  sandboxNamespace: "paperclip",
  sandboxInstanceType: "standard",
  sandboxImage: "",
  sandboxTemplate: "",
  sandboxDomain: "",
  sandboxKeepAlive: true,
  sandboxBootstrapCommand: "",
  cwd: "",
  instructionsFilePath: "",
  promptTemplate: "",
  model: "",
  thinkingEffort: "",
  chrome: false,
  dangerouslySkipPermissions: false,
  search: false,
  dangerouslyBypassSandbox: false,
  command: "",
  args: "",
  extraArgs: "",
  envVars: "",
  envBindings: {},
  url: "",
  bootstrapPrompt: "",
  maxTurnsPerRun: 80,
  heartbeatEnabled: false,
  intervalSec: 300,
};

describe("buildSandboxConfig", () => {
  it("builds Cloudflare provider config", () => {
    const config = buildSandboxConfig({
      ...baseValues,
      sandboxProviderType: "cloudflare",
      sandboxBaseUrl: "https://gateway.example",
      sandboxNamespace: "team-a",
      sandboxInstanceType: "heavy",
      sandboxImage: "ghcr.io/paperclipai/cloudflare-agent-sandbox:latest",
    });

    expect(config.providerConfig).toEqual({
      baseUrl: "https://gateway.example",
      namespace: "team-a",
      instanceType: "heavy",
      image: "ghcr.io/paperclipai/cloudflare-agent-sandbox:latest",
    });
  });

  it("builds E2B provider config", () => {
    const config = buildSandboxConfig({
      ...baseValues,
      sandboxProviderType: "e2b",
      sandboxTemplate: "paperclip-codex",
      sandboxDomain: "e2b.app",
      sandboxBootstrapCommand: "sh -lc 'echo ready'",
    });

    expect(config.providerConfig).toEqual({
      template: "paperclip-codex",
      domain: "e2b.app",
    });
    expect(config.bootstrapCommand).toBe("sh -lc 'echo ready'");
  });

  it("builds OpenSandbox provider config", () => {
    const config = buildSandboxConfig({
      ...baseValues,
      sandboxProviderType: "opensandbox",
      sandboxDomain: "api.opensandbox.io",
      sandboxImage: "ghcr.io/paperclipai/agent-sandbox:latest",
    });

    expect(config.providerConfig).toEqual({
      domain: "api.opensandbox.io",
      image: "ghcr.io/paperclipai/agent-sandbox:latest",
    });
  });
});
