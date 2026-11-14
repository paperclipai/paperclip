import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Cookie } from "@playwright/test";
export interface SshComputerRequest {
  operation: "create" | "probe"; baseURL: string; companyId: string; companyPrefix: string; cookies: Cookie[];
  name: string; environmentId?: string; host: string; port: number; username: string; remoteWorkspacePath: string;
  knownHosts: string; privateKey: string; harness: "claude_local" | "saved-agent"; agentId?: string;
}
export interface SshComputerReceipt {
  processIsolation: true; testRunnerAttached: false; apiStepRecorder: false;
  operation: "create" | "probe"; companyId: string; environmentId: string;
  savedIdentityMatched: true; login: boolean | null; runtimeStatus: "pass" | "warn" | "fail" | null;
  runtimeCodes: string[]; selectedHarness: string | null; agentId?: string;
}
export function validateSshComputerReceipt(value: unknown, request: Pick<SshComputerRequest, "operation" | "companyId" | "environmentId" | "agentId">): SshComputerReceipt {
  const r = value as SshComputerReceipt;
  if (!r || r.processIsolation !== true || r.testRunnerAttached !== false || r.apiStepRecorder !== false || r.savedIdentityMatched !== true
    || r.operation !== request.operation || r.companyId !== request.companyId || !/^[a-f0-9-]{36}$/i.test(r.environmentId)
    || request.environmentId && r.environmentId !== request.environmentId || ![true, false, null].includes(r.login)
    || (r.selectedHarness !== null && !/^[a-z0-9_:-]{1,80}$/.test(r.selectedHarness)) || (r.agentId !== undefined && r.agentId !== request.agentId)
    || !["pass", "warn", "fail", null].includes(r.runtimeStatus) || !Array.isArray(r.runtimeCodes) || !r.runtimeCodes.every(x => /^[a-z0-9_.-]{1,100}$/i.test(x))
    || Object.keys(r).some(k => !["processIsolation", "testRunnerAttached", "apiStepRecorder", "operation", "companyId", "environmentId", "savedIdentityMatched", "login", "runtimeStatus", "runtimeCodes", "selectedHarness", "agentId"].includes(k))) throw new Error("Private SSH child returned invalid closed evidence");
  return r;
}
export async function privateSshComputer(request: SshComputerRequest) {
  const directory = await mkdtemp(path.join(tmpdir(), "paperclip-computer-private-"));
  try {
    const filename = path.join(directory, "request.json"); await writeFile(filename, JSON.stringify({ ...request, executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ?? chromium.executablePath() }), { mode: 0o600 });
    let output: string;
    try { output = (await promisify(execFile)(process.execPath, ["--import", fileURLToPath(new URL("../../../server/node_modules/tsx/dist/loader.mjs", import.meta.url)), fileURLToPath(new URL("./runtime-computers-private-worker.ts", import.meta.url)), filename],
      { timeout: 240000, maxBuffer: 32768, env: { PATH: process.env.PATH ?? "", HOME: directory, TMPDIR: directory, NODE_ENV: "test", DO_NOT_TRACK: "1" } })).stdout; }
    catch { throw new Error("Selected SSH operator journey failed; private inputs and diagnostics withheld"); }
    if ([request.privateKey, encodeURIComponent(request.privateKey), Buffer.from(request.privateKey).toString("base64")].some(x => x && output.includes(x))) throw new Error("SSH private child exceeded closed output boundary");
    let value: unknown; try { value = JSON.parse(output); } catch { throw new Error("Private SSH child returned invalid receipt"); }
    return validateSshComputerReceipt(value, request);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
