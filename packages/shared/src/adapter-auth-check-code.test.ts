import { describe, it, expect } from "vitest";

import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "./adapter-auth-check-code.js";

describe("ADAPTER_AUTH_MISSING_CHECK_CODE", () => {
  it("keeps the canonical missing-auth check code stable", () => {
    expect(ADAPTER_AUTH_MISSING_CHECK_CODE).toBe("adapter_auth_missing");
  });
});
