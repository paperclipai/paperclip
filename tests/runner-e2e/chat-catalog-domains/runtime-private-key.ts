import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type Cookie } from "@playwright/test";
export interface PrivateKeyReceipt {
  privateBrowserProcessIsolated: true; privateBrowserTestRunnerAttached: false; privateBrowserApiStepRecorder: false;
  createdKey?: { id: string; name: string; revokedAt: null }; createdKeyAgentId?: string; createdKeyCompanyId?: string;
  humanCreated?: boolean; tokenShownOnce?: boolean; tokenAbsentAfterReload?: boolean; revokedCredentialStatus?: number;
  privateScanComplete?: boolean; artifactScanComplete?: boolean; runEvidenceScanComplete?: boolean; tokenLeaked?: boolean;
  canaryContained?: boolean;
}
/** Return only a verdict; credentials and matched evidence never escape. */
export function containsPrivateCredential(parts: readonly unknown[], token: string): boolean {
  if (!token) return true;
  const variants = [token, Buffer.from(token).toString("base64"), encodeURIComponent(token)];
  return parts.some(part => { const value = typeof part === "string" ? part : JSON.stringify(part); return variants.some(variant => value?.includes(variant)); });
}
export function validatePrivateKeyReceipt(value: unknown): PrivateKeyReceipt {
  if (!value || typeof value !== "object") throw new Error("Missing private key process receipt");
  const row = value as PrivateKeyReceipt;
  if (row.privateBrowserProcessIsolated !== true || row.privateBrowserTestRunnerAttached !== false || row.privateBrowserApiStepRecorder !== false
    || Object.keys(row).some(key => !["privateBrowserProcessIsolated", "privateBrowserTestRunnerAttached", "privateBrowserApiStepRecorder", "createdKey", "createdKeyAgentId", "createdKeyCompanyId", "humanCreated", "tokenShownOnce", "tokenAbsentAfterReload", "revokedCredentialStatus", "privateScanComplete", "artifactScanComplete", "runEvidenceScanComplete", "tokenLeaked", "canaryContained"].includes(key))) throw new Error("Private key process receipt exceeds its closed boundary");
  if (row.createdKey && (Object.keys(row.createdKey).some(key => !["id", "name", "revokedAt"].includes(key)) || row.createdKey.name !== "local integration" || row.createdKey.revokedAt !== null
    || !/^[a-f0-9-]{36}$/i.test(row.createdKey.id))) throw new Error("Invalid private key metadata receipt");
  for (const key of ["createdKeyAgentId", "createdKeyCompanyId"] as const) if (row[key] && !/^[a-f0-9-]{36}$/i.test(row[key]!)) throw new Error("Invalid private key identity receipt");
  for (const key of ["humanCreated", "tokenShownOnce", "tokenAbsentAfterReload", "privateScanComplete", "artifactScanComplete", "runEvidenceScanComplete", "tokenLeaked", "canaryContained"] as const)
    if (row[key] !== undefined && typeof row[key] !== "boolean") throw new Error("Invalid private key boolean receipt");
  if (row.revokedCredentialStatus !== undefined && ![200, 401, 403].includes(row.revokedCredentialStatus)) throw new Error("Invalid revocation status receipt");
  return row;
}
export async function privateKeyBrowser(input: { mode: "agent-key" | "canary"; baseURL: string; profileURL?: string; companyId?: string; agentId?: string; sourceIssueId?: string; cookies: Cookie[]; canary?: string }) {
  const directory = await mkdtemp(path.join(tmpdir(), "paperclip-private-key-"));
  try {
    const request = path.join(directory, "request.json"), channel = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;
    await writeFile(request, JSON.stringify({ ...input, executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ?? (channel ? undefined : chromium.executablePath()), channel }), { mode: 0o600 });
    const worker = fileURLToPath(new URL("./runtime-private-key-worker.ts", import.meta.url)), loader = fileURLToPath(new URL("../../../server/node_modules/tsx/dist/loader.mjs", import.meta.url));
    let output: string;
    try { output = (await promisify(execFile)(process.execPath, ["--import", loader, worker, request], { timeout: 150_000, maxBuffer: 16_384,
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", DO_NOT_TRACK: "1", HOME: directory, TMPDIR: directory } })).stdout; }
    catch { throw new Error("Private key browser failed; credential-bearing request and child diagnostics withheld"); }
    let value: unknown; try { value = JSON.parse(output); } catch { throw new Error("Invalid closed private key process receipt"); }
    return validatePrivateKeyReceipt(value);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
