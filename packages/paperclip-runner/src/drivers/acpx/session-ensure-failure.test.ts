import { describe, expect, it } from "vitest";

import { classifySessionEnsureFailure } from "./session-ensure-failure.js";

function requestError(code: number): Error {
  return Object.assign(new Error("Internal error: private-provider-detail"), {
    code,
    data: { detail: "private-provider-detail" },
  });
}

describe("ACPX session ensure failure classification", () => {
  it("keeps only a closed JSON-RPC category for provider rejections", () => {
    for (const [code, expected] of [
      [-32700, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_PARSE_ERROR"],
      [-32600, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_INVALID_REQUEST"],
      [-32601, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_METHOD_NOT_FOUND"],
      [-32602, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_INVALID_PARAMS"],
      [-32603, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_INTERNAL_ERROR"],
      [-32800, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_REQUEST_CANCELLED"],
      [-32000, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_AUTH_REQUIRED"],
      [-32002, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_RESOURCE_NOT_FOUND"],
      [-32042, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_OTHER"],
      [-32768, "ACPX_SESSION_ENSURE_FAILED.JSONRPC_OTHER"],
    ] as const) {
      const rejection = requestError(code);
      expect(classifySessionEnsureFailure(rejection)).toBe(rejection);
      expect(rejection).toMatchObject({ code: expected });
      expect(String((rejection as Error & { code: string }).code)).not.toContain(
        "private-provider-detail",
      );
    }
  });

  it("keeps the generic identities for other failures", () => {
    for (const [rejection, expected] of [
      [requestError(20), "ACPX_SESSION_ENSURE_FAILED"],
      [requestError(-31999), "ACPX_SESSION_ENSURE_FAILED"],
      [requestError(-32769), "ACPX_SESSION_ENSURE_FAILED"],
      [requestError(-32603.5), "ACPX_SESSION_ENSURE_FAILED"],
      [new Error("plain ensure failure"), "ACPX_SESSION_ENSURE_FAILED"],
      [new TypeError("bad ensure input"), "ACPX_SESSION_ENSURE_TYPE_ERROR"],
      [
        Object.assign(new Error("stable"), { code: "ACP_SESSION_INIT_FAILED" }),
        "ACP_SESSION_INIT_FAILED",
      ],
    ] as const) {
      expect(classifySessionEnsureFailure(rejection)).toBe(rejection);
      expect(rejection).toMatchObject({ code: expected });
    }
  });

  it("replaces a non-error rejection with a closed error", () => {
    expect(classifySessionEnsureFailure("private-provider-detail")).toMatchObject({
      message: "ACPX session ensure rejected a non-error",
      code: "ACPX_SESSION_ENSURE_NON_ERROR",
    });
  });
});
