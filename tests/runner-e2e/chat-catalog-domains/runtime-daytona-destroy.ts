import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Cookie } from "@playwright/test";
export interface DestroySandboxBinding { companyId: string; environmentId: string; taskId: string; runId: string; leaseId: string; sandboxId: string; actionId: string; attempt: string }
export interface DestroySandboxReceipt extends DestroySandboxBinding { processIsolation: true; testRunnerAttached: false; apiStepRecorder: false; actualOwnedProviderLabels: true; actualDeleteAccepted: true; independentlyAbsent: true }
export function providerSandboxIsOwned(sandbox: { id?: string; name?: string; labels?: Record<string, string> }, binding: DestroySandboxBinding) {
  const labels = sandbox.labels, attempt = labels?.["paperclip-create-attempt"];
  return sandbox.id === binding.sandboxId && !!attempt && /^[a-f0-9-]{36}$/i.test(attempt) && sandbox.name === `paperclip-create-${attempt}` && labels?.["paperclip-provider"] === "daytona"
    && labels["paperclip-company-id"] === binding.companyId && labels["paperclip-environment-id"] === binding.environmentId && labels["paperclip-run-id"] === binding.runId && labels["paperclip-reuse-lease"] === "false";
}
export function validateDestroyedSandboxReceipt(value: unknown, expected: DestroySandboxBinding): DestroySandboxReceipt {
  const r = value as DestroySandboxReceipt;
  const keys = [...Object.keys(expected), "processIsolation", "testRunnerAttached", "apiStepRecorder", "actualOwnedProviderLabels", "actualDeleteAccepted", "independentlyAbsent"];
  if (!r || Object.keys(r).sort().join() !== keys.sort().join() || Object.entries(expected).some(([key, value]) => r[key as keyof DestroySandboxReceipt] !== value)
    || r.processIsolation !== true || r.testRunnerAttached !== false || r.apiStepRecorder !== false || r.actualOwnedProviderLabels !== true || r.actualDeleteAccepted !== true || r.independentlyAbsent !== true) throw new Error("Exact owned sandbox destruction did not return its closed independent receipt");
  return r;
}
export async function destroyOwnedFailedSandbox(input: { scenarioId: "workspaces.recover-lost-sandbox"; executionId: string; binding: DestroySandboxBinding; baseURL: string; cookies: Cookie[]; credential: string }, privateSecrets: string[]): Promise<DestroySandboxReceipt> {
  if (input.credential.length < 12) throw new Error("The exact selected Daytona key is required for the owned sandbox fault");
  privateSecrets.push(input.credential, ...input.cookies.map(row => row.value));
  const directory = await mkdtemp(path.join(tmpdir(), "paperclip-owned-sandbox-fault-")); await chmod(directory, 0o700);
  try {
    const request = path.join(directory, "request.json"); await writeFile(request, JSON.stringify(input), { flag: "wx", mode: 0o600 });
    const loader = fileURLToPath(new URL("../../../server/node_modules/tsx/dist/loader.mjs", import.meta.url)), worker = fileURLToPath(new URL("./runtime-daytona-destroy-worker.ts", import.meta.url));
    let output: string;
    try { output = (await promisify(execFile)(process.execPath, ["--import", loader, worker, request], { timeout: 120000, maxBuffer: 16384, env: { PATH: process.env.PATH ?? "", HOME: directory, TMPDIR: directory, NODE_ENV: "test", DO_NOT_TRACK: "1" } })).stdout; }
    catch { throw new Error("Owned sandbox fault failed; private provider request/diagnostics withheld"); }
    if (privateSecrets.some(secret => secret && [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")].some(value => output.includes(value)))) throw new Error("Owned sandbox fault exceeded its private receipt boundary; output withheld");
    let receipt: unknown; try { receipt = JSON.parse(output); } catch { throw new Error("Owned sandbox fault returned no closed receipt"); }
    return validateDestroyedSandboxReceipt(receipt, input.binding);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
