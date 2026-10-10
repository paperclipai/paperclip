// Server-side wiring for the Linux `oom_score_adj` mitigation.
//
// `bootstrapOomScoreAdjProtection` in @paperclipai/adapter-utils does the kernel
// work; this module owns the log line so the server entrypoint stays a
// one-call site and the wording has one home. See
// packages/adapter-utils/src/oom-score-adj.ts for why the control plane has to
// lose to the workers it hosts.

import {
  bootstrapOomScoreAdjProtection,
  type OomScoreAdjBootstrapSummary,
} from "@paperclipai/adapter-utils/oom-score-adj";
import { logger } from "../middleware/logger.js";

const OOM_PROTECTION_LOG_EMITTED = Symbol.for("@paperclipai/oom-score-adj-log-emitted");

/** Runs the startup adjustment and logs the result once per process. */
export function logOomScoreAdjProtection(): OomScoreAdjBootstrapSummary {
  const summary = bootstrapOomScoreAdjProtection();

  const globalState = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (globalState[OOM_PROTECTION_LOG_EMITTED]) return summary;
  globalState[OOM_PROTECTION_LOG_EMITTED] = true;

  const { policy, self, serverAdj, protected: isProtected } = summary;
  const fields = {
    enabled: policy.enabled,
    ordered: policy.ordered,
    serverAdj,
    requestedServerAdj: policy.serverAdj,
    workerAdj: policy.workerAdj,
    protected: isProtected,
    reason: self.reason,
    detail: self.detail,
  };

  if (!policy.enabled) {
    logger.info(fields, "oom_score_adj protection disabled by configuration");
  } else if (isProtected) {
    logger.info(fields, "oom_score_adj protection active: agent workers outrank the control plane");
  } else {
    // The load-bearing half is the per-spawn worker write, which needs no
    // capability. Losing the server-side write is a degraded margin, not a
    // failure, so this warns rather than blocks startup.
    logger.warn(
      fields,
      "oom_score_adj protection degraded: could not lower the server adjustment; " +
        "agent workers are still raised per spawn. Grant CAP_SYS_RESOURCE to widen the margin.",
    );
  }

  return summary;
}
