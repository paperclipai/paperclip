import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type Cookie } from "@playwright/test";
export interface WebhookHumanReceipt { processIsolation: true; testRunnerAttached: false; credentialVisibleInHumanUI: true; setupFinished: true; invalidStatus: number; validStatus: number; invalidCreatedInvocation: boolean; invocationId: string; linkedIssueId: string; triggerId: string }
export async function finishPrivateWebhook(input: { baseURL: string; route: string; routineId: string; triggerId: string; setupPending: boolean; signingMode: string; nonce: string; cookies: Cookie[] }, registerSecret: (value: string) => void): Promise<WebhookHumanReceipt> {
  const dir = await mkdtemp(path.join(tmpdir(), "paperclip-routine-webhook-private-"));
  try {
    const channel = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;
    const request = path.join(dir, "request.json");
    await writeFile(request, JSON.stringify({ ...input, channel, executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ?? (channel ? undefined : chromium.executablePath()) }), { mode: 0o600 });
    const worker = fileURLToPath(new URL("./integrator-webhook-private-worker.ts", import.meta.url)); const loader = fileURLToPath(new URL("../../../server/node_modules/tsx/dist/loader.mjs", import.meta.url));
    let output: string;
    try { output = (await promisify(execFile)(process.execPath, ["--import", loader, worker, request], { timeout: 120_000, maxBuffer: 8192, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", DO_NOT_TRACK: "1", HOME: dir, TMPDIR: dir } })).stdout; }
    catch { throw new Error("Private routine webhook setup failed; credential-bearing child diagnostics withheld"); }
    const secret = await readFile(path.join(dir, "secret.txt"), "utf8"); if (!/^[a-f0-9]{48}$/i.test(secret)) throw new Error("Invalid private one-time webhook credential handoff"); registerSecret(secret);
    const receipt = JSON.parse(output) as WebhookHumanReceipt;
    if (receipt.processIsolation !== true || receipt.testRunnerAttached !== false || receipt.credentialVisibleInHumanUI !== true || receipt.setupFinished !== true || receipt.triggerId !== input.triggerId
      || !/^[a-f0-9-]{36}$/i.test(receipt.invocationId) || !/^[a-f0-9-]{36}$/i.test(receipt.linkedIssueId)
      || Object.keys(receipt).some(key => !["processIsolation", "testRunnerAttached", "credentialVisibleInHumanUI", "setupFinished", "invalidStatus", "validStatus", "invalidCreatedInvocation", "invocationId", "linkedIssueId", "triggerId"].includes(key))) throw new Error("Private webhook child returned an invalid closed receipt");
    return receipt;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
