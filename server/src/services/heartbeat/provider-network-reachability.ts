import { lookup } from "node:dns";

/**
 * Host-level network reachability, used to stop the retry engine from spending
 * bounded retry attempts into a host that currently has no outbound network.
 *
 * WHY THIS EXISTS
 *   When the host loses DNS, every scheduled retry is a full adapter spawn that
 *   cannot possibly succeed. Measured on one deployment over 72h: 103 runs failed
 *   with "Can't reach the API server ... (ENOTFOUND)", 66 of them scheduled
 *   retries of an earlier run that had already failed the same way, 0 successes
 *   in any outage window, 0 input and 0 output tokens across all of them. Each
 *   attempt also consumes the run's bounded retry budget, and an exhausted budget
 *   parks the issue with no live path.
 *
 *   A reachability probe is cheap and the evidence is already in hand: the
 *   previous run's own failure says the network was down. Confirming that it is
 *   still down before spending the next attempt turns a storm into one spawn.
 */

/**
 * Error codes that mean the HOST could not resolve or route to the provider at
 * all, as distinct from the provider answering with an error.
 *
 * `ECONNREFUSED` is deliberately absent. A refused connection means the name DID
 * resolve, so the DNS probe below cannot confirm it and a gate keyed on it would
 * be guessing. It was also 5 of 180 such failures over 14 days, against 175 for
 * `ENOTFOUND`, so excluding it costs almost nothing.
 */
const HOST_NETWORK_UNREACHABLE_ERROR_CODES = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENODATA",
  "ENETDOWN",
  "ENETUNREACH",
] as const;

const HOST_NETWORK_UNREACHABLE_RE = new RegExp(
  `\\b(?:${HOST_NETWORK_UNREACHABLE_ERROR_CODES.join("|")})\\b`,
);

/** Reported on the deferral so the hold is distinguishable from a real refusal. */
export const PROVIDER_NETWORK_UNREACHABLE_CODE = "provider_network_unreachable";

/**
 * The host to probe, and the timeout.
 *
 * Both match `network-park-sweep.sh` (`PROBE_HOST`, `host -W 3`) on purpose. That
 * sweep already runs this exact check on the same host, and logged it four times
 * while an outage was live and the retry engine was spending attempts through it.
 * Two probes that disagree about whether the network is up would be worse than
 * one, so the host and the timeout are kept identical and the override below uses
 * the sweep's own variable name as a fallback.
 */
export const PROVIDER_REACHABILITY_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_PROVIDER_REACHABILITY_PROBE_HOST = "api.anthropic.com";

/**
 * How long one probe result stands for. During an outage the recovery sweeper can
 * consider many runs in the same pass; they share one probe rather than issuing
 * one resolver query each.
 */
export const PROVIDER_REACHABILITY_CACHE_MS = 15_000;

/**
 * When a held retry asks to be looked at again.
 *
 * Matched to the recovery sweep's own `reconstructionIntervalMs` (30s), and
 * deliberately longer than the probe cache above so the next pass takes a FRESH
 * probe rather than re-reading the cached "down" that caused the hold.
 *
 * This exists because holding a retry also removes the thing that used to bring
 * the sweeper back. Before this gate, the doomed retry run itself was the clock:
 * it spawned, failed, and its terminal state notified the recovery queue, which
 * is what re-examined the issue. Suppress the spawn and that clock stops, and
 * `scoped-deadline-work` drops an entry whose check reports no deadline
 * (`check` returns null -> `entries.delete`), with the scope hint already out of
 * `dirty`. The hold would then wait on an unrelated notification. So the hold
 * MUST hand a deadline back; it is not optional bookkeeping.
 */
export const PROVIDER_NETWORK_UNREACHABLE_RECHECK_MS = 30_000;

export function resolveProviderReachabilityProbeHost(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured =
    env.PAPERCLIP_PROVIDER_PROBE_HOST ?? env.NETWORK_PARK_SWEEP_PROBE_HOST;
  const trimmed = typeof configured === "string" ? configured.trim() : "";
  return trimmed.length > 0 ? trimmed : DEFAULT_PROVIDER_REACHABILITY_PROBE_HOST;
}

/**
 * Adapter types whose provider the DEFAULT probe host answers for.
 *
 * The default host is Anthropic's, so an Anthropic failure is the only one it
 * can confirm. A `codex_local` or `gemini_local` run that failed with ENOTFOUND
 * against its OWN endpoint is not evidence that `api.anthropic.com` is down, and
 * holding its retry on this probe would withhold a spawn that could succeed.
 *
 * `opencode_local` and the ACPX/runner adapters are deliberately absent even
 * though they CAN be pointed at Anthropic: their endpoint is configuration, so
 * this process cannot know it. Leaving them ungated costs only today's
 * behaviour (spend the attempt), which is the safe direction.
 */
const DEFAULT_PROBE_HOST_ADAPTER_TYPES = new Set(["claude_local"]);

/**
 * True when the configured probe host can speak for this run's provider.
 *
 * An explicit operator override answers yes for every adapter: naming the host
 * is taking responsibility for which deployment it represents.
 */
export function isProbeHostRelevantToAdapter(
  adapterType: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const override =
    env.PAPERCLIP_PROVIDER_PROBE_HOST ?? env.NETWORK_PARK_SWEEP_PROBE_HOST;
  if (typeof override === "string" && override.trim().length > 0) return true;
  return (
    typeof adapterType === "string" &&
    DEFAULT_PROBE_HOST_ADAPTER_TYPES.has(adapterType)
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * True when this run's failure says the HOST could not reach the provider.
 *
 * Only adapter-authored error text is read: `run.error` and
 * `resultJson.errorMessage`. The agent's own output (`resultJson.result`,
 * `resultJson.message`) is deliberately NOT scanned, so an agent that merely
 * writes "ENOTFOUND" while debugging cannot classify its own run as a network
 * outage. Every one of the 175 measured failures carries the code in `run.error`.
 */
export function isHostNetworkUnreachableFailure(run: {
  error?: string | null;
  resultJson?: unknown;
}): boolean {
  const resultJson =
    run.resultJson && typeof run.resultJson === "object" && !Array.isArray(run.resultJson)
      ? (run.resultJson as Record<string, unknown>)
      : {};
  const candidates = [
    readNonEmptyString(run.error),
    readNonEmptyString(resultJson.errorMessage),
  ];
  return candidates.some(
    (value) => value !== null && HOST_NETWORK_UNREACHABLE_RE.test(value),
  );
}

/**
 * Resolve `host` with the same system path the provider CLI itself uses.
 *
 * `dns.lookup` (getaddrinfo), not `dns.resolve`: the failure being guarded
 * against is the CLI's own `ENOTFOUND`, which comes from getaddrinfo, so the
 * probe has to fail for the same reasons and only those. getaddrinfo has no
 * built-in deadline, so the call is raced against the timeout and a timeout is
 * reported as unreachable.
 */
export function lookupWithTimeout(
  host: string,
  timeoutMs: number,
  /**
   * Injection seam for tests ONLY, so the real race can be driven without a
   * resolver. getaddrinfo cannot be cancelled, so a lookup that outlives its
   * deadline keeps running and calls back late; the `settled` latch is what
   * makes that late callback a no-op rather than a second settle. A test that
   * mocks `resolveHost` one layer up never exercises either path, which is
   * what `rules/runtime-dependency-boundaries.mdc` asks us to cover.
   */
  lookupFn: (host: string, callback: (error: unknown) => void) => void = (
    target,
    callback,
  ) => lookup(target, callback),
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    lookupFn(host, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(!error);
    });
  });
}

export interface ProviderHostReachabilityProbeOptions {
  host?: string;
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
  /** Injection seam for tests; defaults to a real getaddrinfo with a deadline. */
  resolveHost?: (host: string, timeoutMs: number) => Promise<boolean>;
}

/**
 * A cached reachability probe.
 *
 * FAILS OPEN. Anything unexpected inside the probe reports "reachable", so a bug
 * here can only ever restore today's behaviour (spend the attempt), never
 * withhold retries across a healthy fleet. The probe's job is to confirm an
 * outage that another signal already reported, not to decide on its own that the
 * fleet should stop.
 */
export function createProviderHostReachabilityProbe(
  options: ProviderHostReachabilityProbeOptions = {},
): () => Promise<boolean> {
  const host = options.host ?? resolveProviderReachabilityProbeHost();
  const timeoutMs = options.timeoutMs ?? PROVIDER_REACHABILITY_PROBE_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? PROVIDER_REACHABILITY_CACHE_MS;
  const now = options.now ?? (() => Date.now());
  const resolveHost = options.resolveHost ?? lookupWithTimeout;

  let cachedAt: number | null = null;
  let cachedReachable = true;
  let inFlight: Promise<boolean> | null = null;

  return async function isProviderHostReachable(): Promise<boolean> {
    const at = now();
    if (cachedAt !== null && at - cachedAt < cacheMs) return cachedReachable;
    // One probe at a time. Concurrent callers inside the same pass share it
    // rather than each opening their own resolver query.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        return await resolveHost(host, timeoutMs);
      } catch {
        return true;
      }
    })()
      .then((reachable) => {
        cachedAt = now();
        cachedReachable = reachable;
        return reachable;
      })
      .catch(() => true)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
