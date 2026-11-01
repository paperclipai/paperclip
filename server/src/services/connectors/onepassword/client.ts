import { Worker } from "node:worker_threads";
import { HttpError } from "../../../errors.js";
import { onePasswordArguments } from "./catalog.js";

const messages: Record<string, [number, string]> = {
  onepassword_request_failed: [502, "1Password could not complete the action. Check the service account token and its vault permissions. A write may have completed; inspect the item before retrying."],
  onepassword_auth_expired: [401, "The 1Password service account token expired or was revoked. Reconnect with a new token."],
  onepassword_access_denied: [403, "1Password denied this action. Check the service account's vault access and Read Items / Write Items permissions. Create a new service account and reconnect if its permissions need to change."],
  onepassword_rate_limited: [429, "1Password's service account request limit was reached. Try again later."],
  onepassword_output_limit: [502, "The 1Password result exceeds the size limit. Request a single item or field."],
  onepassword_timeout: [504, "The 1Password action timed out. A write may have completed; inspect the item before retrying."],
};
function failure(code: string) {
  const [status, message] = messages[code] ?? messages.onepassword_request_failed!;
  return new HttpError(status, message, { code: code in messages ? code : "onepassword_request_failed" });
}

function serviceAccountToken(authorization: string | undefined): string {
  const invalid = () => new HttpError(422, "Enter a valid 1Password service account token for a 1Password.com, .ca, or .eu account.", { code: "onepassword_credential_invalid" });
  if (!authorization?.startsWith("Bearer ops_") || authorization.length > 32_768 || /\s/.test(authorization.slice(7))) throw invalid();
  const token = authorization.slice(7);
  try {
    const { signInAddress } = JSON.parse(Buffer.from(token.slice(4), "base64url").toString("utf8"));
    if (typeof signInAddress !== "string") throw invalid();
    const url = new URL(signInAddress.includes("://") ? signInAddress : `https://${signInAddress}`);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || !/(^|\.)1password\.(com|ca|eu)$/.test(url.hostname)) throw invalid();
  } catch { throw invalid(); }
  return token;
}

export async function callOnePassword(headers: Record<string, string>, tool: string, parameters: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<unknown> {
  const args = onePasswordArguments(tool, parameters);
  if (signal?.aborted) throw failure("onepassword_timeout");
  const token = serviceAccountToken(headers.Authorization);
  const source = import.meta.url.endsWith(".ts");
  const url = new URL(source ? "./worker.ts" : "./worker.js", import.meta.url);
  const worker = source
    ? new Worker(`import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}).then(({tsImport}) => tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)}));`, {
      eval: true, workerData: { token, tool, parameters: args }, env: {}, execArgv: [], stdout: true, stderr: true,
    })
    : new Worker(url, { workerData: { token, tool, parameters: args }, env: {}, execArgv: [], stdout: true, stderr: true });
  worker.stdout.resume(); worker.stderr.resume();
  let abort: (() => void) | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(failure("onepassword_timeout")), Math.max(1, Math.min(timeoutMs, 30_000)));
      abort = () => { clearTimeout(timer); reject(failure("onepassword_timeout")); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      worker.once("message", (message: { code?: string; result?: unknown }) => {
        clearTimeout(timer);
        if (message.code) reject(failure(message.code)); else resolve(message.result);
      });
      worker.once("error", () => { clearTimeout(timer); reject(failure("onepassword_request_failed")); });
      worker.once("exit", () => { clearTimeout(timer); reject(failure("onepassword_request_failed")); });
    });
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}

export function executeOnePasswordTool(input: {
  binding: { companyId: string; agentId?: string | null }; connection: { companyId: string };
  headers: Record<string, string>; toolName: string; parameters: unknown; deadlineAt?: number; signal?: AbortSignal;
}) {
  if (!input.binding.agentId || input.binding.companyId !== input.connection.companyId) {
    throw new HttpError(404, "Connection not found", { code: "onepassword_connection_not_found" });
  }
  const remainingMs = (input.deadlineAt ?? Date.now() + 30_000) - Date.now();
  if (remainingMs <= 0 || input.signal?.aborted) throw failure("onepassword_timeout");
  return callOnePassword(input.headers, input.toolName, input.parameters, remainingMs, input.signal);
}
