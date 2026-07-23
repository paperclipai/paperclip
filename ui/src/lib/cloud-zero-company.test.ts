import { describe, expect, it } from "vitest";
import { resolveCloudZeroCompanyState } from "./cloud-zero-company";

const base = { isInstanceAdmin: false, companyIds: [] as string[] };

describe("resolveCloudZeroCompanyState", () => {
  it("returns null (render app) when the user has companies or is instance admin", () => {
    expect(resolveCloudZeroCompanyState({ ...base, companyIds: ["c1"] })).toBeNull();
    expect(resolveCloudZeroCompanyState({ ...base, isInstanceAdmin: true })).toBeNull();
  });

  it("lets stack owners and admins through to onboard", () => {
    expect(
      resolveCloudZeroCompanyState({ ...base, cloudStack: { stackId: "s", stackRole: "owner" } }),
    ).toBe("onboard");
    expect(
      resolveCloudZeroCompanyState({ ...base, cloudStack: { stackId: "s", stackRole: "admin" } }),
    ).toBe("onboard");
  });

  it("parks members and support on the waiting page", () => {
    expect(
      resolveCloudZeroCompanyState({ ...base, cloudStack: { stackId: "s", stackRole: "member" } }),
    ).toBe("waiting");
    expect(
      resolveCloudZeroCompanyState({ ...base, cloudStack: { stackId: "s", stackRole: "support" } }),
    ).toBe("waiting");
  });

  it("falls back to no_access for non-stack users with no memberships", () => {
    expect(resolveCloudZeroCompanyState(base)).toBe("no_access");
    expect(resolveCloudZeroCompanyState({ ...base, cloudStack: null })).toBe("no_access");
  });
});
