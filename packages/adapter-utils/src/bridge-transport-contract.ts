/**
 * Shared contract for the sandbox callback bridge transports.
 *
 * The retired duplex_v1 broker first defined these symbols. The host
 * broker is gone, but the http2_v1 transport and the ACPX engine
 * run-disposition seam still use them. This leaf module holds the
 * survivors, so a caller of the run-disposition seam does not import the
 * whole HTTP/2 bridge server module graph to reach one error code.
 */

import type { DuplexLossReason } from "./duplex-observability.js";

/**
 * The typed error code the host reports when the bridge control channel
 * died before an orderly completion. Both the ACP lane and the CLI lane
 * report this one code, so the run disposition is identical across the two
 * lanes.
 */
export const DUPLEX_CHANNEL_LOST_ERROR_CODE = "duplex_channel_lost";

/**
 * The terminal run disposition a bridge transport computes from its ordered
 * lifecycle. A `failed` disposition means a terminal loss ordered before an
 * orderly completion, so the run must not report success. The typed loss
 * reason names the cause; it is `null` for a success.
 */
export interface DuplexBrokerRunDisposition {
  /** True when a terminal loss ordered before an orderly completion. */
  failed: boolean;
  /** The typed, closed loss reason on a failure; `null` on a success. */
  lossReason: DuplexLossReason | null;
}

/** The nested timeout budgets. Each inner budget is smaller than its outer budget. */
export interface DuplexBrokerBudgets {
  /** The deadline for one forward call, in milliseconds. */
  forwardTimeoutMs: number;
  /** The deadline for the broker to send one response frame, in milliseconds. */
  responseBudgetMs: number;
  /** The deadline the in-sandbox gateway waits for the response frame, in milliseconds. */
  gatewayWaitMs: number;
}

/** The default nested budgets: forward 30 s, response 32 s, gateway wait 35 s. */
export const DEFAULT_DUPLEX_BROKER_BUDGETS: DuplexBrokerBudgets = {
  forwardTimeoutMs: 30_000,
  responseBudgetMs: 32_000,
  gatewayWaitMs: 35_000,
};

/**
 * The safe HTTP methods. RFC 7231 section 4.2.1 defines this set. A safe method
 * does not change host state, so the host applies no mutation for it. A caller
 * can retry a safe method after a forward failure without a double-apply risk.
 */
const SAFE_BRIDGE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

/** Report whether the method is safe, so a forward failure stays retryable. */
export function isSafeBridgeMethod(method: string): boolean {
  return SAFE_BRIDGE_METHODS.has(method.trim().toUpperCase());
}
