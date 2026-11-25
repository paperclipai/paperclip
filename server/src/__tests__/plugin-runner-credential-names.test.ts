import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_TASK_PROVIDER_CREDENTIAL_KEY_SETS } from "@paperclipai/plugin-sdk";
import {
  ACPX_CREDENTIAL_BINDING_ENV, ACPX_CREDENTIAL_NAMES, createAcpxCredentialBinding, createAcpxSidecarHostEnvironment, createSanitizedAcpxSpawnInput,
} from "../../../packages/paperclip-runner/src/drivers/acpx/environment.js";
import { OPEN_CODE_RUNNER_ENVIRONMENT_KEYS } from "../../../packages/paperclip-runner/src/live/runnerd-codex-transport.js";

const runnerSource = (file: string) =>
  readFileSync(resolve(import.meta.dirname, "../../../packages/paperclip-runner/runner/crates/runner-core/src", file), "utf8");
const names = (block: string | undefined) => [...(block ?? "").matchAll(/"([A-Za-z0-9_]+)"/gu)].map(match => match[1]);
const acpxSidecar = runnerSource("acpx_sidecar_transport.rs");
const rustAcpxCredentialNames = (agent: string) =>
  names(new RegExp(`"${agent}" => &\\[([^\\]]*)\\]`, "u").exec(acpxSidecar)?.[1]);
const rustCandidateAgents = names(/if matches!\(agent, ([^)]*)\) \{[^}]*keys\.push\("PAPERCLIP_ACPX_CREDENTIAL_BINDING"\)/u.exec(acpxSidecar)?.[1]);
const rustOpenCodeNames = names(/const OPENCODE_PROVIDER_ENVIRONMENT_KEYS: &\[&str\] = &\[([^\]]*)\];/u.exec(runnerSource("codex_provider.rs"))?.[1]);
const acpxAgents = Object.keys(ACPX_CREDENTIAL_NAMES) as (keyof typeof ACPX_CREDENTIAL_NAMES)[];
const providers = Object.entries(ENVIRONMENT_TASK_PROVIDER_CREDENTIAL_KEY_SETS);

describe("plugin Runner provider credential names", () => {
  it("reads the Runner's Rust allowlists", () => {
    expect(rustAcpxCredentialNames("copilot")).toContain("COPILOT_GITHUB_TOKEN");
    expect(rustCandidateAgents).toContain("copilot");
    expect(rustAcpxCredentialNames("antigravity")).toContain("GEMINI_API_KEY");
    expect(rustAcpxCredentialNames("antigravity")).toContain("PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET");
    expect(rustCandidateAgents).toContain("antigravity");
    expect(rustOpenCodeNames).toContain("OPENROUTER_API_KEY");
  });

  it.each(providers)("routes every %s credential variable through the Runner", (provider, sets) => {
    const variables = sets.flat();
    const environment = Object.fromEntries(variables.map(name => [name, `fixture-${name.toLowerCase()}`]));
    if (provider === "opencode") {
      for (const name of variables) {
        expect(OPEN_CODE_RUNNER_ENVIRONMENT_KEYS.has(name), `${name} reaches the OpenCode proxy`).toBe(true);
        expect(rustOpenCodeNames, `${name} reaches OpenCode from the Runner process`).toContain(name);
      }
      return;
    }
    expect(acpxAgents, `${provider} is an ACPX agent with credential names`).toContain(provider);
    const agent = provider as (typeof acpxAgents)[number];
    const binding = createAcpxCredentialBinding(environment, agent, "session");
    expect(rustCandidateAgents.includes(agent), `${agent} binding forwarding matches the sidecar`).toBe(binding !== undefined);
    const host = createAcpxSidecarHostEnvironment(binding === undefined ? environment : { ...environment, [ACPX_CREDENTIAL_BINDING_ENV]: binding }, agent, "session");
    const spawned = createSanitizedAcpxSpawnInput(host, agent).env;
    for (const name of variables) {
      expect(ACPX_CREDENTIAL_NAMES[agent], `${name} is an ACPX ${agent} credential`).toContain(name);
      expect(rustAcpxCredentialNames(agent), `${name} reaches the ACPX sidecar from the Runner process`).toContain(name);
      expect(host[name], `${name} survives sidecar admission`).toBe(environment[name]);
      if (agent === "antigravity" && name === "PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET") {
        expect(spawned[name], `${name} is staged as a private token file, never the ${agent} process environment`).toBeUndefined();
      } else {
        expect(spawned[name], `${name} reaches the ${agent} process`).toBe(environment[name]);
      }
    }
  });

  it("still strips Google and Gemini routing variables from the Antigravity process", () => {
    const routing = { GOOGLE_API_KEY: "fixture-google", GOOGLE_APPLICATION_CREDENTIALS: "/controller/private/adc.json",
      GOOGLE_CLOUD_PROJECT: "fixture-project", GOOGLE_GEMINI_BASE_URL: "https://router.example.test", GEMINI_HOME: "/controller/private/gemini" };
    const environment = { GEMINI_API_KEY: "fixture-gemini", ...routing, PAPERCLIP_CONFIGURED_ENV_KEYS: JSON.stringify(Object.keys(routing)) };
    const binding = createAcpxCredentialBinding(environment, "antigravity", "session");
    const host = createAcpxSidecarHostEnvironment({ ...environment, [ACPX_CREDENTIAL_BINDING_ENV]: binding }, "antigravity", "session");
    const spawned = createSanitizedAcpxSpawnInput(host, "antigravity").env;
    expect(JSON.parse(binding!).names).toEqual(["GEMINI_API_KEY"]);
    expect(host.GEMINI_API_KEY).toBe("fixture-gemini");
    expect(spawned.GEMINI_API_KEY).toBe("fixture-gemini");
    for (const name of Object.keys(routing)) {
      expect(host[name], `${name} is removed at sidecar admission`).toBeUndefined();
      expect(spawned[name], `${name} never reaches the Antigravity process`).toBeUndefined();
    }
  });
});
