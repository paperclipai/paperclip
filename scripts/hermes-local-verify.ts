#!/usr/bin/env -S node --import tsx
import process from "node:process";
import {
  API_BASE,
  getAdapters,
  getCompanies,
  getHermesTestEnvironment,
  getHermesVersion,
  section,
  step,
  success,
  summarizeCheck,
  warn,
  fail,
  formatJson,
} from "./hermes-local-common.ts";

async function main() {
  section("Paperclip + Hermes 本地一键验证");
  step("API base: " + API_BASE);

  step("检查 Hermes CLI 版本");
  const hermes = await getHermesVersion();
  success(`Hermes 可执行：${hermes.versionLine}`);
  if (hermes.pythonVersion) {
    step(`Hermes runtime Python: ${hermes.pythonVersion}`);
  }

  step("检查 Paperclip adapters 列表");
  const adapters = await getAdapters();
  const hermesAdapter = adapters.find((adapter) => adapter.type === "hermes_local");
  if (!hermesAdapter) {
    fail("/api/adapters 中未发现 hermes_local；请先确认 Paperclip 已启动且 adapter 已正确接入。");
  }
  success(
    `发现 hermes_local（loaded=${String(hermesAdapter.loaded)}, disabled=${String(hermesAdapter.disabled)}, modelsCount=${String(hermesAdapter.modelsCount ?? 0)}）`,
  );

  step("运行 hermes_local test-environment");
  const envResult = await getHermesTestEnvironment({});
  console.log(formatJson(envResult));

  const errorChecks = envResult.checks.filter((check) => check.level === "error");
  const warnChecks = envResult.checks.filter((check) => check.level === "warn");
  const infoChecks = envResult.checks.filter((check) => check.level === "info");

  if (infoChecks.length > 0) {
    step("Info checks:");
    for (const line of infoChecks.map(summarizeCheck)) console.log(`  ${line}`);
  }
  if (warnChecks.length > 0) {
    warn("存在 warning checks：");
    for (const line of warnChecks.map(summarizeCheck)) console.log(`  ${line}`);
  }
  if (envResult.status === "fail" || errorChecks.length > 0) {
    console.error("Error checks:");
    for (const line of errorChecks.map(summarizeCheck)) console.error(`  ${line}`);
    fail("test-environment 返回 fail/error；本地一键验证失败。请先修复上述问题。");
  }

  step("列出现有 companies（帮助确认当前实例是否可读写）");
  const companies = await getCompanies();
  if (companies.length === 0) {
    warn("当前实例还没有 company；这不影响环境验证通过，但会影响 demo 创建/复用。");
  } else {
    for (const company of companies) {
      console.log(`  - ${company.name} (${company.id}) [${company.status ?? "unknown"}]`);
    }
  }

  success("一键验证通过：Paperclip API、hermes_local adapter、Hermes CLI 与 test-environment 均已可用。");
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  fail(detail);
});
