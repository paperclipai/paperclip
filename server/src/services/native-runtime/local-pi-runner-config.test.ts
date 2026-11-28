import { afterEach, expect, it, vi } from "vitest";
import { operatorLocalPiConfig } from "./local-pi-runner-config.js";

afterEach(() => vi.unstubAllEnvs());

it("uses only the operator binding for the exact company and saved agent", () => {
  const raw = JSON.stringify({ companyId: "company", agentId: "pi-agent" });
  vi.stubEnv("PAPERCLIP_RUNNER_LOCAL_PI", raw);
  vi.stubEnv("PI_CODING_AGENT_DIR", "/operator/pi");
  const binding = operatorLocalPiConfig("company", "pi-agent");
  expect(JSON.parse(binding!)).toMatchObject({ companyId: "company", agentId: "pi-agent", profile: "/operator/pi", path: process.env.PATH });
  expect(operatorLocalPiConfig("other-company", "pi-agent")).toBeUndefined();
  expect(operatorLocalPiConfig("company", "other-agent")).toBeUndefined();
});
