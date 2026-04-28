import assert from "node:assert/strict";

import {
  buildLocalDoctorReport,
  classifyLocalDoctorReport,
  type LocalDoctorInput,
} from "../hermes-local-common.ts";

const baseInput: LocalDoctorInput = {
  apiBase: "http://127.0.0.1:3100/api",
  apiReachable: true,
  authTokenAvailable: true,
  health: { status: "ok", deploymentMode: "authenticated" },
  adapters: [{ type: "hermes_local", loaded: true, disabled: false, modelsCount: 0 }],
  companies: [{ id: "co_1", name: "NFC", status: "active" }],
  selectedCompanyId: "co_1",
  hermesVersion: {
    raw: "Hermes Agent v0.11.0\nPython: 3.14.3",
    versionLine: "Hermes Agent v0.11.0",
    pythonVersion: "3.14.3",
  },
  testEnvironment: {
    adapterType: "hermes_local",
    status: "warn",
    checks: [
      { level: "info", code: "hermes_version", message: "Hermes Agent v0.11.0" },
      { level: "warn", code: "hermes_no_api_keys", message: "No LLM API keys found in environment" },
    ],
  },
  automation: {
    launchAgents: ["com.neo.paperclip.service", "com.neo.paperclip.healthcheck"],
    serviceLoaded: true,
    healthcheckLoaded: true,
    patchRefreshLoaded: false,
    upstreamUpgradeLoaded: false,
  },
};

{
  const report = buildLocalDoctorReport(baseInput);
  assert.equal(report.status, "warn");
  assert.equal(report.items.find((item) => item.id === "hermes_no_api_keys")?.severity, "warn");
  assert.match(report.summary, /可用但有非阻塞 warning/);
}

{
  const report = buildLocalDoctorReport({ ...baseInput, adapters: [] });
  assert.equal(report.status, "fail");
  assert.equal(report.items.find((item) => item.id === "hermes_adapter")?.severity, "fail");
}

assert.equal(classifyLocalDoctorReport(["pass", "warn", "fail"]), "fail");
console.log("hermes-local-common tests passed");
