import { logger } from "../middleware/logger.js";
import {
  cloudTenantPrimaryCompanyId,
  getCloudStackContext,
  type CloudInstanceEnv,
} from "./cloud-instance.js";

/**
 * Cloud lifecycle doorbell: when the Cloud-pinned primary company is
 * archived or unarchived on a managed instance, ring the harness
 * (`POST /v1/tenant/lifecycle-changed`) so Paperclip Cloud can converge the
 * stack — an org whose only company is archived should not keep running,
 * and should read "Archived" on /orgs rather than "Live".
 *
 * The ring is a HINT by contract: the harness never trusts it. It reads
 * the primary company's status back through `GET /api/instance/lifecycle`
 * (Cloud control assertion) before changing anything, so the worst a lost,
 * duplicated, or forged ring can do is trigger one verified read.
 *
 * Fire-and-forget with a bounded retry: archiving a company must never
 * block or fail on Cloud availability, and a missed ring only delays the
 * badge/suspend convergence, it cannot corrupt state.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [2_000, 10_000];

export type CloudLifecycleSyncOptions = {
  env?: CloudInstanceEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * True when this company is the Cloud-pinned primary company of a managed
 * instance — the only company whose archive state the harness mirrors.
 */
export function isCloudPinnedPrimaryCompany(
  companyId: string,
  env: CloudInstanceEnv = process.env,
): boolean {
  const stackId = getCloudStackContext(env)?.stackId;
  return Boolean(stackId) && cloudTenantPrimaryCompanyId(stackId!) === companyId;
}

/**
 * Ring the harness about a lifecycle change of the pinned primary company.
 * No-op (resolved promise) on self-hosted instances, non-primary companies,
 * or incomplete Cloud metadata. Never throws.
 */
export async function notifyCloudOfPrimaryCompanyLifecycleChange(
  companyId: string,
  options: CloudLifecycleSyncOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  if (!isCloudPinnedPrimaryCompany(companyId, env)) return;
  const context = getCloudStackContext(env);
  const token = env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim();
  if (!context?.stackId || !context.cloudOrigin || !token) return;

  const fetchImpl = options.fetchImpl ?? fetch;
  // Unreferenced timers: this detached retry loop must never hold the
  // process open — a shutdown mid-retry just drops the ring, which the
  // harness's verified read-back model tolerates by design.
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  const url = `${context.cloudOrigin}/v1/tenant/lifecycle-changed`;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-paperclip-cloud-stack-id": context.stackId,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // Any response means the harness heard the ring — it does its own
      // verified read-back, so even a non-2xx outcome is not retried
      // beyond transient server errors.
      if (response.ok || response.status < 500) return;
      if (attempt >= RETRY_DELAYS_MS.length) {
        logger.warn(
          { status: response.status, url },
          "Cloud lifecycle doorbell got a server error; giving up",
        );
        return;
      }
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        logger.warn({ err, url }, "Cloud lifecycle doorbell unreachable; giving up");
        return;
      }
    }
    await sleep(RETRY_DELAYS_MS[attempt]!);
  }
}
