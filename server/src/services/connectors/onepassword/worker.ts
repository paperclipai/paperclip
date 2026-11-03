import { parentPort, workerData } from "node:worker_threads";
import { AuthExpiredError, RateLimitExceededError } from "@1password/sdk";
import { executeOnePasswordSdk } from "./sdk.js";

try {
  const result = await executeOnePasswordSdk(workerData.token, workerData.tool, workerData.parameters);
  const json = JSON.stringify(result ?? null).split(workerData.token).join("[REDACTED]");
  parentPort!.postMessage(json.length <= 1024 * 1024
    ? { result: JSON.parse(json) } : { code: "onepassword_output_limit" });
} catch (error) {
  parentPort!.postMessage({ code: error instanceof RateLimitExceededError ? "onepassword_rate_limited"
    : error instanceof AuthExpiredError ? "onepassword_auth_expired"
    : error instanceof Error && /403|forbidden|permission|access denied|not authorized/i.test(error.message)
      ? "onepassword_access_denied" : "onepassword_request_failed" });
}
