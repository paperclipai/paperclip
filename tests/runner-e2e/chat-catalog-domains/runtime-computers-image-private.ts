import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Cookie } from "@playwright/test";
export const websiteImageTools = ["node", "npm", "git"] as const;
export function validWebsiteToolsManifest(raw: string) {
  try { const v = JSON.parse(raw); return Array.isArray(v) && v.length === websiteImageTools.length && websiteImageTools.every(x => v.includes(x)) && new Set(v).size === v.length; } catch { return false; }
}
export interface ImagePreparationRequest { baseURL: string; companyId: string; environmentId: string; cookies: Cookie[] }
export interface ImagePreparationReceipt { processIsolation: true; testRunnerAttached: false; sessionId: string; templateId: string; templateRefSha256: string; actualToolsVerified: true; promoted: true; sourceEnvironmentId: string }
export function validateImagePreparationReceipt(value: unknown, environmentId: string): ImagePreparationReceipt {
  const r = value as ImagePreparationReceipt;
  if (!r || r.processIsolation !== true || r.testRunnerAttached !== false || r.actualToolsVerified !== true || r.promoted !== true || r.sourceEnvironmentId !== environmentId
    || ![r.sessionId, r.templateId, r.sourceEnvironmentId].every(x => /^[a-f0-9-]{36}$/i.test(x)) || !/^[a-f0-9]{64}$/.test(r.templateRefSha256)
    || Object.keys(r).some(x => !["processIsolation", "testRunnerAttached", "sessionId", "templateId", "templateRefSha256", "actualToolsVerified", "promoted", "sourceEnvironmentId"].includes(x))) throw new Error("Invalid closed actual image preparation receipt");
  return r;
}
export async function privateImagePreparation(request: ImagePreparationRequest) {
  const dir = await mkdtemp(path.join(tmpdir(), "paperclip-image-private-"));
  try {
    const filename = path.join(dir, "request.json"); await writeFile(filename, JSON.stringify({ ...request, executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ?? chromium.executablePath() }), { mode: 0o600 });
    let output: string; try { output = (await promisify(execFile)(process.execPath, ["--import", fileURLToPath(new URL("../../../server/node_modules/tsx/dist/loader.mjs", import.meta.url)), fileURLToPath(new URL("./runtime-computers-image-worker.ts", import.meta.url)), filename], { timeout: 540000, maxBuffer: 16384, env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir, NODE_ENV: "test", DO_NOT_TRACK: "1" } })).stdout; }
    catch (error) { const match = /^image-private-phase:(input|session|terminal-token|browser|terminal|capture|saved-proof)$/.exec(String((error as { stderr?: string }).stderr ?? "").trim()); throw new Error(`Actual operator image preparation failed at ${match?.[1] ?? "child-startup"}; private terminal diagnostics withheld`); }
    let value: unknown; try { value = JSON.parse(output); } catch { throw new Error("No closed actual image preparation receipt"); }
    return validateImagePreparationReceipt(value, request.environmentId);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
