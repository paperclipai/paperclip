import {
  resolveDuplexAggregateCeilingBytes,
  type DuplexAggregateCeilingOverrideRejectionReporter,
} from "@paperclipai/adapter-utils/duplex-aggregate-byte-ledger";

/**
 * Resolve the aggregate duplex route byte ceiling from the raw operator override
 * string. The host reads the override from
 * PAPERCLIP_MAX_AGGREGATE_DUPLEX_ROUTE_BYTES.
 *
 * This helper distinguishes an absent variable from a present blank value. An
 * absent variable is `undefined`. The helper then uses the documented default and
 * does not report a rejection. A present variable is a string, even when the
 * string holds only whitespace. The helper sends every present string through
 * `Number`, so a blank or whitespace-only value becomes `0`. The numeric
 * validation in {@link resolveDuplexAggregateCeilingBytes} rejects `0`, reports it
 * through `onRejectedOverride`, and returns the safe default. So a present blank
 * value is visible as invalid instead of silent as absent.
 *
 * `Number` ignores surrounding whitespace, so a valid value with surrounding
 * spaces still parses. The reporter receives only the parsed number, never the raw
 * string, so no operator-supplied text reaches a log line.
 */
export function resolveDuplexAggregateCeilingBytesFromEnv(
  rawOverride: string | undefined,
  onRejectedOverride?: DuplexAggregateCeilingOverrideRejectionReporter,
): number {
  return resolveDuplexAggregateCeilingBytes(
    rawOverride === undefined ? undefined : Number(rawOverride),
    onRejectedOverride,
  );
}
