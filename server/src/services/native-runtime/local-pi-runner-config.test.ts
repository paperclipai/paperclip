import { afterEach, expect, it, vi } from "vitest";
import { operatorLocalPiConfig } from "./local-pi-runner-config.js";

afterEach(() => vi.unstubAllEnvs());

it("uses only the operator binding for the exact company and saved agent", () => {
  const raw = JSON.stringify({ companyId: "company", agentId: "pi-agent" });
  vi.stubEnv("PAPERCLIP_RUNNER_LOCAL_PI", raw);
  expect(operatorLocalPiConfig("company", "pi-agent")).toBe(raw);
  expect(operatorLocalPiConfig("other-company", "pi-agent")).toBeUndefined();
  expect(operatorLocalPiConfig("company", "other-agent")).toBeUndefined();
});
