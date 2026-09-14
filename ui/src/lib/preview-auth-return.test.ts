import { describe, expect, it } from "vitest";
import { previewAuthReturnPath } from "./preview-auth-return";

const callback = "/api/companies/11111111-1111-4111-8111-111111111111/runtime-services/22222222-2222-4222-8222-222222222222/preview-access";
describe("preview sign-in continuation", () => {
  it("preserves an exact local grant path and its nested app query", () => {
    const target = `${callback}?endpoint=web&next=${encodeURIComponent("/nested/page?check=1")}`;
    expect(previewAuthReturnPath(target)).toBe(target);
  });
  it.each([
    `https://other.test${callback}`, `//other.test${callback}`, `/\\other.test${callback}`,
    `javascript:${callback}`, "/api/auth/sign-out", "/api/companies", `${callback}/extra`, "/runtime-services/service",
    `/api/companies/11111111-1111-4111-8111-111111111111/runtime-services/invalid/preview-access`,
  ])("does not authorize a full navigation for %s", (value) => {
    expect(previewAuthReturnPath(value)).toBeNull();
  });
});
