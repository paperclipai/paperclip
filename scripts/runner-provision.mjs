#!/usr/bin/env node

const [
  ,
  ,
  companyIdArg,
  regionArg = "iad",
] = process.argv;

if (!companyIdArg) {
  console.error("Usage: node scripts/runner-provision.mjs <companyId> [region]");
  process.exit(1);
}

const companyId = companyIdArg;
const region = regionArg;

const flyApiToken = process.env.FLY_API_TOKEN;
const flyRunnerApp = process.env.FLY_RUNNER_APP;
const paperclipApiBase = (process.env.PAPERCLIP_API_BASE_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const paperclipInternalToken = process.env.PAPERCLIP_INTERNAL_TOKEN || process.env.PAPERCLIP_SAAS_CONTROL_TOKEN;

if (!flyApiToken) {
  console.error("Missing FLY_API_TOKEN");
  process.exit(1);
}
if (!flyRunnerApp) {
  console.error("Missing FLY_RUNNER_APP");
  process.exit(1);
}
if (!paperclipInternalToken) {
  console.error("Missing PAPERCLIP_INTERNAL_TOKEN (or PAPERCLIP_SAAS_CONTROL_TOKEN)");
  process.exit(1);
}

const machineRequest = {
  config: {
    image: process.env.FLY_RUNNER_IMAGE || "ghcr.io/paperclipai/openclaw-runner:latest",
    env: {
      RUNNER_MODE: "openclaw_gateway",
      COMPANY_ID: companyId,
      PAPERCLIP_BASE_URL: paperclipApiBase,
    },
  },
  region,
};

const createMachineResponse = await fetch(`https://api.machines.dev/v1/apps/${flyRunnerApp}/machines`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${flyApiToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(machineRequest),
});

if (!createMachineResponse.ok) {
  const payload = await createMachineResponse.text();
  console.error(`Failed to create Fly machine: ${createMachineResponse.status} ${payload}`);
  process.exit(1);
}

const createdMachine = await createMachineResponse.json();
const machineId = createdMachine?.id;
if (!machineId) {
  console.error("Fly API response missing machine id");
  process.exit(1);
}

const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || `wss://${machineId}.vm.${flyRunnerApp}.internal/gateway`;
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || null;

const provisionResponse = await fetch(
  `${paperclipApiBase}/api/internal/companies/${encodeURIComponent(companyId)}/provision-runner`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${paperclipInternalToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      machineId,
      region,
      gatewayUrl,
      gatewayToken,
      paperclipApiUrl: process.env.PAPERCLIP_PUBLIC_URL || paperclipApiBase,
    }),
  },
);

const provisionPayload = await provisionResponse.json().catch(() => ({}));
if (!provisionResponse.ok) {
  console.error("Failed to provision runner in Paperclip:", provisionPayload);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  machineId,
  companyId,
  runner: provisionPayload.runner,
  openclawGatewayDefaults: provisionPayload.openclawGatewayDefaults,
}, null, 2));

