const JSON_RPC_ENSURE_FAILURE_CODES = new Map<number, string>([
  [-32700, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_PARSE_ERROR"],
  [-32600, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_INVALID_REQUEST"],
  [-32601, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_METHOD_NOT_FOUND"],
  [-32602, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_INVALID_PARAMS"],
  [-32603, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_INTERNAL_ERROR"],
  [-32800, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_REQUEST_CANCELLED"],
  [-32000, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_AUTH_REQUIRED"],
  [-32002, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_RESOURCE_NOT_FOUND"],
]);

function jsonRpcEnsureFailureCode(code: unknown): string | null {
  if (typeof code !== "number" || !Number.isInteger(code)) return null;
  const known = JSON_RPC_ENSURE_FAILURE_CODES.get(code);
  if (known) return known;
  return code >= -32768 && code <= -32000
    ? "ACPX_SESSION_ENSURE_FAILED.JSONRPC_OTHER"
    : null;
}

export function classifySessionEnsureFailure(error: unknown): Error {
  if (error instanceof Error) {
    const details = error as Error & Record<string, unknown>;
    if (typeof details.code !== "string" || details.code.length === 0) {
      details.code =
        jsonRpcEnsureFailureCode(details.code) ??
        (error instanceof TypeError
          ? "ACPX_SESSION_ENSURE_TYPE_ERROR"
          : "ACPX_SESSION_ENSURE_FAILED");
    }
    return error;
  }
  return Object.assign(new Error("ACPX session ensure rejected a non-error"), {
    code: "ACPX_SESSION_ENSURE_NON_ERROR",
  });
}
