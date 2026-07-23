import { describe, expect, it } from "vitest";

import { shouldShowInstanceSignOut } from "./InstanceGeneralSettings";

describe("InstanceGeneralSettings sign-out visibility", () => {
  it("shows sign-out only for authenticated deployments", () => {
    expect(shouldShowInstanceSignOut("authenticated")).toBe(true);
    expect(shouldShowInstanceSignOut("local_trusted")).toBe(false);
    expect(shouldShowInstanceSignOut(undefined)).toBe(false);
  });
});
