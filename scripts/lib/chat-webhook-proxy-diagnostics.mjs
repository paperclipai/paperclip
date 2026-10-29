const REJECTION_REASONS = new Set([
  "method",
  "host",
  "path",
  "malformed_target",
]);

/**
 * Observe only a classified rejection, without reading or resuming its body.
 * The caller retains all HTTP policy and explicitly counts bytes it consumes.
 * `bytes` means observed body bytes before the terminal response/abort event,
 * not Content-Length and not bytes attributed from a shared keep-alive socket.
 */
export function observeChatWebhookProxyRejection(req, res, options = {}) {
  const now = options.now ?? (() => performance.now());
  const emit = options.emit ?? (() => {});
  const connectionId =
    Number.isSafeInteger(options.connectionId) && options.connectionId > 0
      ? options.connectionId
      : null;
  let start;
  try {
    start = now();
  } catch {
    start = 0;
  }
  let reason = null;
  let bytes = 0;
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    req.removeListener("aborted", record);
    res.removeListener("finish", record);
    res.removeListener("close", record);
    if (reason === null) return;
    try {
      const elapsed = now() - start;
      const result = emit({
        event: "chat_webhook_proxy_rejection",
        reason,
        connectionId,
        statusCode:
          res.headersSent &&
          Number.isInteger(res.statusCode) &&
          res.statusCode >= 100 &&
          res.statusCode <= 599
            ? res.statusCode
            : null,
        durationMs: Number.isFinite(elapsed)
          ? Math.min(86_400_000, Math.max(0, Math.round(elapsed * 1000) / 1000))
          : 0,
        bytes,
      });
      if (result instanceof Promise) void result.catch(() => {});
    } catch {
      // Diagnostics must not change the response or expose arbitrary errors.
    }
  };
  req.once("aborted", record);
  res.once("finish", record);
  res.once("close", record);
  return {
    reject(value) {
      if (!recorded && reason === null && REJECTION_REASONS.has(value))
        reason = value;
    },
    countBytes(length) {
      if (!recorded && Number.isSafeInteger(length) && length > 0) {
        bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + length);
      }
    },
  };
}
