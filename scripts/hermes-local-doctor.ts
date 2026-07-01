#!/usr/bin/env -S node --import tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  API_BASE,
  BOARD_AUTH_TOKEN,
  buildLocalDoctorReport,
  fail,
  formatJson,
  getAdapters,
  getCompanies,
  getHealth,
  getHermesTestEnvironment,
  getHermesVersion,
  section,
  summarizeLaunchAgents,
  step,
  success,
  warn,
  type AdapterSummary,
  type CompanyRecord,
  type HermesVersionInfo,
  type TestEnvironmentResult,
  type LocalDoctorAutomationSummary,
  type LocalDoctorItem,
} from "./hermes-local-common.ts";

interface DoctorOptions {
  companyId?: string;
  json: boolean;
  skipTestEnvironment: boolean;
}

function parseArgs(argv: string[]): DoctorOptions {
  const options: DoctorOptions = {
    companyId: process.env.PAPERCLIP_COMPANY_ID,
    json: false,
    skipTestEnvironment: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--skip-test-environment") {
      options.skipTestEnvironment = true;
    } else if (arg === "--company-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) fail("--company-id requires a value");
      options.companyId = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: pnpm hermes:doctor [--company-id <id>] [--skip-test-environment] [--json]

Checks local Paperclip + Hermes readiness without running a demo issue.`);
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function severityIcon(severity: LocalDoctorItem["severity"]): string {
  if (severity === "pass") return "✅";
  if (severity === "warn") return "⚠️ ";
  return "❌";
}

function detectLaunchAgents(): LocalDoctorAutomationSummary {
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const launchAgents = fs.existsSync(launchAgentsDir)
    ? fs.readdirSync(launchAgentsDir).filter((name) => name.toLowerCase().includes("paperclip") && name.endsWith(".plist"))
    : [];

  return summarizeLaunchAgents(launchAgents);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.json) section("Paperclip + Hermes 本地 doctor");

  let health: Record<string, unknown> | null = null;
  let apiReachable = false;
  let adapters: AdapterSummary[] = [];
  let companies: CompanyRecord[] = [];
  let hermesVersion: HermesVersionInfo | null = null;
  let testEnvironment: TestEnvironmentResult | null = null;
  let selectedCompanyId: string | null = null;

  try {
    if (!options.json) step(`API base: ${API_BASE}`);
    health = await getHealth();
    apiReachable = true;
  } catch (error) {
    if (!options.json) warn(error instanceof Error ? error.message : String(error));
  }

  if (apiReachable) {
    try {
      adapters = await getAdapters();
    } catch (error) {
      if (!options.json) warn(`读取 adapters 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      companies = await getCompanies();
      selectedCompanyId = options.companyId ?? companies[0]?.id ?? null;
    } catch (error) {
      if (!options.json) warn(`读取 companies 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    hermesVersion = await getHermesVersion();
  } catch (error) {
    if (!options.json) warn(error instanceof Error ? error.message : String(error));
  }

  if (apiReachable && selectedCompanyId && !options.skipTestEnvironment) {
    try {
      testEnvironment = await getHermesTestEnvironment(selectedCompanyId, {});
    } catch (error) {
      if (!options.json) warn(`test-environment 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const report = buildLocalDoctorReport({
    apiBase: API_BASE,
    apiReachable,
    authTokenAvailable: Boolean(BOARD_AUTH_TOKEN),
    health,
    adapters,
    companies,
    selectedCompanyId,
    hermesVersion,
    testEnvironment,
    automation: detectLaunchAgents(),
  });

  if (options.json) {
    console.log(formatJson(report));
  } else {
    console.log(`\n${report.summary}`);
    for (const item of report.items) {
      console.log(`${severityIcon(item.severity)} ${item.label}: ${item.detail}`);
      if (item.hint) console.log(`   hint: ${item.hint}`);
    }
  }

  if (report.status === "fail") process.exit(1);
  if (!options.json) success("doctor 完成。阻塞项为 0。warning 需要关注但不阻断本地工作流。 ");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
