import { describe, expect, it } from "vitest";
import { DASHBOARD_HOME_PATH, RESPONSIBILITIES_HOME_PATH, resolveCompanyHomePath } from "./company-home";

describe("resolveCompanyHomePath", () => {
  it("is Dashboard while Responsibilities is off", () => {
    expect(resolveCompanyHomePath({ enabled: false, loaded: true })).toBe(DASHBOARD_HOME_PATH);
  });

  it("is Responsibilities while the flag is on", () => {
    expect(resolveCompanyHomePath({ enabled: true, loaded: true })).toBe(RESPONSIBILITIES_HOME_PATH);
  });

  it("is unknown while the flag is loading, so callers wait instead of redirecting twice", () => {
    expect(resolveCompanyHomePath({ enabled: false, loaded: false })).toBeNull();
    expect(resolveCompanyHomePath({ enabled: true, loaded: false })).toBeNull();
  });
});
