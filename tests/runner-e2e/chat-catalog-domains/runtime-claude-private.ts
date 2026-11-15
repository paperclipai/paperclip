import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Environment } from "../../../packages/shared/src/types/environment.js";
import type { Cookie } from "@playwright/test";
export function matchesClaudeFixtureTarget(input: { company: { id: string }; expectedCompanyId: string; fixtureEnvironmentId: string; detail: Pick<Environment, "id" | "driver" | "status">; listed: Array<Pick<Environment, "id" | "driver" | "status">> }) {
  // Environments are instance resources, not company rows. The authenticated
  // company read + public inventory authority and exact attempt fixture bind it.
  const { detail } = input;
  return input.company.id === input.expectedCompanyId && detail.id === input.fixtureEnvironmentId && detail.driver === "local" && detail.status === "active"
    && input.listed.some(row => row.id === detail.id && row.driver === detail.driver && row.status === detail.status);
}
export interface ClaudePrivateReceipt {
  processIsolation: true; testRunnerAttached: false; apiStepRecorder: false;
  operation: "check-harness" | "prepare-account" | "validate-saved"; companyId: string; environmentId: string; connectionId?: string; grantId?: string; agentId?: string;
  probeStatus: "pass" | "warn" | "fail"; probeCheckCodes: string[];
}
export function validateClaudePrivateReceipt(value: unknown, expected: Pick<ClaudePrivateReceipt, "operation" | "companyId" | "environmentId">): ClaudePrivateReceipt {
  const r = value as ClaudePrivateReceipt;
  if (!r || r.processIsolation !== true || r.testRunnerAttached !== false || r.apiStepRecorder !== false || r.operation !== expected.operation || r.companyId !== expected.companyId || r.environmentId !== expected.environmentId
    || Object.keys(r).some(key => !["processIsolation", "testRunnerAttached", "apiStepRecorder", "operation", "companyId", "environmentId", "connectionId", "grantId", "agentId", "probeStatus", "probeCheckCodes"].includes(key))
    || ![r.companyId, r.environmentId, ...(r.operation === "check-harness" ? [] : [r.connectionId, r.grantId]), ...(r.agentId ? [r.agentId] : [])].every(id => typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id))
    || !["pass", "warn", "fail"].includes(r.probeStatus) || !Array.isArray(r.probeCheckCodes) || r.probeCheckCodes.length > 100 || !r.probeCheckCodes.every(code => /^[a-z0-9_.-]{1,100}$/i.test(code))) throw new Error("Invalid closed Claude qualification receipt; private diagnostics withheld");
  return r;
}
export type ClaudePrivateRequest = { operation: "check-harness"; harnessExecutable: string } | { operation: "prepare-account"; credential: string; harnessExecutable: string; model: string } | { operation: "validate-saved"; agentId: string; connectionId: string; grantId: string };
/** Only the selected per-attempt key/session crosses the private0600 file.
 * No Test request API, browser arguments, argv, env or raw child diagnostic gets it. */
export async function privateClaudeOperation(input: ClaudePrivateRequest & { companyId: string; environmentId: string; baseURL: string; cookies: Cookie[] }, scanSecret = input.operation === "prepare-account" ? input.credential : undefined) {
  if (!scanSecret || scanSecret.length < 12) throw new Error("Claude private operation requires the actual selected credential for private receipt scanning");
  const directory = await mkdtemp(path.join(tmpdir(), "paperclip-claude-private-"));
  try {
    const request = path.join(directory, "request.json"); await writeFile(request, JSON.stringify(input), { mode: 0o600 });
    const loader = fileURLToPath(new URL("../../../server/node_modules/tsx/dist/loader.mjs", import.meta.url)), worker = fileURLToPath(new URL("./runtime-claude-private-worker.ts", import.meta.url));
    let output: string;
    try { output = (await promisify(execFile)(process.execPath, ["--import", loader, worker, request], { timeout: 180000, maxBuffer: 32768,
      env: { PATH: process.env.PATH ?? "", HOME: directory, TMPDIR: directory, NODE_ENV: "test", DO_NOT_TRACK: "1" } })).stdout; }
    catch { throw new Error("Selected Claude public setup/validation failed; private request and child diagnostics withheld"); }
    if ([scanSecret, encodeURIComponent(scanSecret), Buffer.from(scanSecret).toString("base64")].some(value => output.includes(value))) throw new Error("Claude private child exceeded its secret-free receipt boundary; output withheld");
    let result: unknown; try { result = JSON.parse(output); } catch { throw new Error("Claude private child returned no closed qualification receipt"); }
    return validateClaudePrivateReceipt(result, input);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
