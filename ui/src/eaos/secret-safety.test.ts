// @vitest-environment node

import { describe, expect, it } from "vitest";
import { sweepForSecrets } from "./secret-safety";
import { EAOS_PRIMARY_NAV, EAOS_KERNEL_NAV, EAOS_ALL_NAV_PATHS } from "./nav-zones";
import {
  DEFAULT_BOTTOM_STRIP_LABEL,
  DEFAULT_TOPBAR_POSTURE_LABEL,
  EAOS_STATE_LABELS,
  KERNEL_POSTURE_LABEL,
} from "./state-labels";

describe("secret-safety regex sweep", () => {
  it("flags a fake AWS access key when one is present", () => {
    const findings = sweepForSecrets(["AKIAABCDEFGHIJKLMNOP", "safe string"]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.pattern).toBe("AWS access key id");
  });

  it("flags a JWT-shaped token", () => {
    const findings = sweepForSecrets([
      "eyJabc1234567890.eyJabc1234567890.eyJabc1234567890",
    ]);
    expect(findings.some((m) => m.pattern === "JWT-shaped token")).toBe(true);
  });

  it("flags a PEM private key block", () => {
    const findings = sweepForSecrets(["-----BEGIN RSA PRIVATE KEY-----"]);
    expect(findings.some((m) => m.pattern === "PEM private key block")).toBe(true);
  });

  it("flags a postgres connection string with credentials", () => {
    const findings = sweepForSecrets([
      "postgres://user:hunter2@db.example.internal/postgres",
    ]);
    expect(
      findings.some((m) => m.pattern === "DB connection string with credentials"),
    ).toBe(true);
  });
});

describe("/eaos static surface secret sweep", () => {
  const staticSurface: readonly string[] = [
    ...EAOS_PRIMARY_NAV.map((zone) => zone.id),
    ...EAOS_PRIMARY_NAV.map((zone) => zone.label),
    ...EAOS_PRIMARY_NAV.map((zone) => zone.path),
    ...EAOS_PRIMARY_NAV.map((zone) => zone.description),
    EAOS_KERNEL_NAV.id,
    EAOS_KERNEL_NAV.label,
    EAOS_KERNEL_NAV.path,
    EAOS_KERNEL_NAV.description,
    ...EAOS_ALL_NAV_PATHS,
    ...EAOS_STATE_LABELS,
    KERNEL_POSTURE_LABEL,
    DEFAULT_TOPBAR_POSTURE_LABEL,
    DEFAULT_BOTTOM_STRIP_LABEL,
  ];

  it("does not leak any known secret pattern from nav labels/paths/state labels", () => {
    const findings = sweepForSecrets(staticSurface);
    expect(findings).toEqual([]);
  });
});
