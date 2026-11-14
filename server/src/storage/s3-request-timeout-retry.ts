import type { S3Client } from "@aws-sdk/client-s3";

// Methods that S3 defines as safe to repeat without a request body.
const REPEATABLE_METHODS = new Set(["GET", "HEAD"]);

function isRepeatableRequestTimeout(error: unknown, method: unknown): boolean {
  if (typeof method !== "string" || !REPEATABLE_METHODS.has(method.toUpperCase())) return false;
  if (!error || typeof error !== "object") return false;
  const { $metadata, $retryable } = error as { $metadata?: { httpStatusCode?: unknown }; $retryable?: unknown };
  return $retryable === undefined && $metadata?.httpStatusCode === 408;
}

/**
 * S3-compatible gateways can answer a read that they stopped waiting on with
 * HTTP 408 (for example `RequestCanceled`). The SDK's standard strategy retries
 * only 5xx, throttling and named timeout codes, so one slow read failed the
 * caller at once. Mark 408 on GET and HEAD as transient. The SDK then applies its
 * usual backoff, retry quota and attempt limit. Writes keep their current
 * behavior because a repeated upload needs a replayable body.
 */
export function retryS3RequestTimeouts(client: S3Client): void {
  client.middlewareStack.add(
    (next) => async (args) => {
      try {
        return await next(args);
      } catch (error) {
        // `finalizeRequest` runs after the SDK built the HTTP request.
        if (isRepeatableRequestTimeout(error, (args.request as { method?: unknown } | undefined)?.method)) {
          (error as { $retryable?: { throttling: boolean } }).$retryable = { throttling: false };
        }
        throw error;
      }
    },
    // Inside the retry middleware (finalizeRequest, priority high): it sees the
    // trait before it classifies the error.
    { step: "finalizeRequest", priority: "low", name: "paperclipS3RequestTimeoutRetry" },
  );
}
