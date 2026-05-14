import { describe, it, expect } from "vitest";
import { ENVIRONMENT_DRIVERS } from "../constants.js";

describe("ENVIRONMENT_DRIVERS", () => {
  it("includes k8s alongside local, ssh, sandbox, plugin", () => {
    expect(ENVIRONMENT_DRIVERS).toEqual(
      expect.arrayContaining(["local", "ssh", "sandbox", "plugin", "k8s"]),
    );
  });
});
