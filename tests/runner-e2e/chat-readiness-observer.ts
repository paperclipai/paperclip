import { retainHealthHelloDetail } from "./chat-readiness-detail.js";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ServerAdapterModule } from "../../server/src/adapters/types.js";

// Exact source-defined codes from OpenCode's existing environment test. Messages,
// hints, command output, config and credentials never cross this boundary.
const codes = new Set([
  "opencode_environment_target", "opencode_cwd_valid", "opencode_cwd_invalid",
  "opencode_openai_api_key_missing", "opencode_headless_permissions_enabled",
  "opencode_command_skipped", "opencode_command_resolvable", "opencode_command_unresolvable",
  "opencode_model_validation_via_probe", "opencode_model_invalid", "opencode_model_validation_skipped_remote",
  "opencode_models_discovered", "opencode_models_empty", "opencode_models_discovery_failed",
  "opencode_model_configured", "opencode_hello_probe_timed_out", "opencode_hello_probe_passed",
  "opencode_hello_probe_unexpected_output", "opencode_hello_probe_model_unavailable",
  "opencode_hello_probe_auth_required", "opencode_hello_probe_failed",
  "paperclip_runner_provider_unsupported", "agent_runner_config_incompatible", "paperclip_runner_mode_invalid", "paperclip_runner_opencode_model_invalid",
]);
const categories = ["authentication", "rate-limit", "network", "permission", "command-missing", "module-missing", "model-unavailable", "timeout", "unknown"] as const;
type Category = typeof categories[number];
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9-]{36}$/i.test(v);
const selected = (ids: readonly string[]) => ids.length > 0 && ids.every(id => id === "chat-setup-health.runner-opencode.local.setup-only" || /^chat-features\.runner-opencode\.local\.[a-z0-9.-]+$/.test(id));
const filename = (root: string) => path.join(root, "artifacts-private", "chat-readiness-probes.jsonl");
export function readinessErrorCategory(value: unknown): Category {
  const text = typeof value === "string" ? value.slice(0, 8192) : "";
  if (/ProviderModelNotFoundError|model.{0,40}not found/i.test(text)) return "model-unavailable";
  if (/\b(?:401|403|unauthorized|authentication|invalid.api.key)\b/i.test(text)) return "authentication";
  if (/\b429\b|rate.?limit/i.test(text)) return "rate-limit";
  if (/EACCES|EPERM|permission denied/i.test(text)) return "permission";
  if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/i.test(text)) return "module-missing";
  if (/ENOENT|command not found/i.test(text)) return "command-missing";
  if (/ETIMEDOUT|timed? ?out/i.test(text)) return "timeout";
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|TLS|certificate/i.test(text)) return "network";
  return "unknown";
}
function closedCheck(value: any) {
  return { code: codes.has(value?.code) ? value.code as string : "unknown",
    level: ["info", "warn", "error"].includes(value?.level) ? value.level as string : "unknown",
    category: categories.includes(value?.category) ? value.category as Category : "unknown" };
}
export async function installChatReadinessObserver(input: {
  executionIds: readonly string[]; temporaryRoot: string; adapter: Pick<ServerAdapterModule, "testEnvironment">;
}) {
  if (!selected(input.executionIds)) return;
  const root = await realpath(input.temporaryRoot), info = await stat(root);
  if (root !== input.temporaryRoot || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Readiness observer requires its owned private attempt root");
  const directory = path.dirname(filename(root)); await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await stat(directory);
  if (await realpath(directory) !== directory || directoryInfo.uid !== info.uid || (directoryInfo.mode & 0o022)) throw new Error("Readiness observer directory is not private and owned");
  const original = input.adapter.testEnvironment;
  let sequence = 0, writes = Promise.resolve();
  const retain = async (companyId: string, result: any, thrown: boolean) => {
    if (++sequence > 100) return;
    const detailRetention = thrown ? undefined : await retainHealthHelloDetail(root, input.executionIds, sequence, result);
    const receipt = { ...(detailRetention ? { detailRetention } : {}), schema: "paperclip.chat-readiness-probe/v1", companyId, sequence,
      status: ["pass", "warn", "fail"].includes(result?.status) ? result.status : "unknown", thrown,
      checks: Array.isArray(result?.checks) ? result.checks.slice(0, 64).map((check: any) => closedCheck({ ...check,
        category: readinessErrorCategory(`${check?.message ?? ""}\n${check?.detail ?? ""}`) })) : [],
      errorCategory: thrown ? readinessErrorCategory(result instanceof Error ? result.message : "") : "unknown" };
    writes = writes.then(async () => {
      const file = await open(filename(root), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const fileInfo = await file.stat();
        if (!fileInfo.isFile() || fileInfo.uid !== info.uid || (fileInfo.mode & 0o077)) throw new Error("Unsafe readiness receipt file");
        await file.writeFile(`${JSON.stringify(receipt)}\n`);
      } finally { await file.close(); }
    }).catch(() => { /* Diagnostic failure must never replace the actual probe result/error. */ });
    await writes;
  };
  input.adapter.testEnvironment = async function (...args) {
    const context = args[0];
    if (context.adapterType !== "paperclip_runner" || context.config.provider !== "opencode" || !uuid(context.companyId)) return original.apply(this, args);
    let result;
    try { result = await original.apply(this, args); }
    catch (error) { await retain(context.companyId, error, true); throw error; }
    await retain(context.companyId, result, false);
    return result;
  };
}
/** Re-project even the private file. No arbitrary file keys/strings enter evidence. */
export interface ClosedReadinessReceipt {
  schema: "paperclip.chat-readiness-probe/v1"; companyId: string; sequence: number; status: string; thrown: boolean;
  checks: Array<{ code: string; level: string; category: Category }>; errorCategory: Category; detailRetention?: "retained" | "withheld";
}
export async function readChatReadinessReceipts(temporaryRoot: string, companyId: string): Promise<ClosedReadinessReceipt[]> {
  if (!temporaryRoot || !uuid(companyId)) return [];
  let bytes: string;
  try { bytes = await readFile(filename(temporaryRoot), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("Readiness receipt unavailable"); }
  if (bytes.length > 1_000_000) throw new Error("Readiness receipt exceeds bound");
  return bytes.trim().split("\n").filter(Boolean).slice(0, 100).flatMap(line => {
    let row; try { row = JSON.parse(line); } catch { return []; }
    if (!row || row.schema !== "paperclip.chat-readiness-probe/v1" || row.companyId !== companyId || !Number.isInteger(row.sequence) || row.sequence < 1 || row.sequence > 100) return [];
    return [{ ...(row.detailRetention === "retained" || row.detailRetention === "withheld" ? { detailRetention: row.detailRetention } : {}), schema: row.schema, companyId, sequence: row.sequence,
      status: ["pass", "warn", "fail"].includes(row.status) ? row.status : "unknown", thrown: row.thrown === true,
      checks: Array.isArray(row.checks) ? row.checks.slice(0, 64).map(closedCheck) : [],
      errorCategory: categories.includes(row.errorCategory) ? row.errorCategory as Category : "unknown" }];
  });
}
