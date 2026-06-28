import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const rootPackageJson = JSON.parse(
  await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
);
const serverPackageJson = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);

describe("PEN-1198 audit dependency remediation", () => {
  it("keeps high-risk production dependency paths on patched ranges", () => {
    const overrides = rootPackageJson.pnpm.overrides;

    expect(overrides["@connectrpc/connect-node>undici"]).toBe(
      ">=6.27.0 <7",
    );
    expect(overrides["jsdom>undici"]).toBe(">=7.28.0 <8");
    expect(overrides.multer).toBe(">=2.2.0 <3");
    expect(serverPackageJson.dependencies.multer).toBe("^2.2.0");
  });

  it("documents the advisories that the patched ranges address", () => {
    const remediations = rootPackageJson.securityAuditRemediations["PEN-1198"];

    expect(remediations["@connectrpc/connect-node>undici"]).toMatchObject({
      patchedRange: ">=6.27.0 <7",
      advisories: expect.arrayContaining([
        "GHSA-vrm6-8vpv-qv8q",
        "GHSA-vxpw-j846-p89q",
      ]),
    });
    expect(remediations["jsdom>undici"]).toMatchObject({
      patchedRange: ">=7.28.0 <8",
      advisories: expect.arrayContaining([
        "GHSA-vmh5-mc38-953g",
        "GHSA-hm92-r4w5-c3mj",
      ]),
    });
    expect(remediations.multer).toMatchObject({
      patchedRange: ">=2.2.0 <3",
      advisories: expect.arrayContaining([
        "GHSA-72gw-mp4g-v24j",
        "GHSA-3p4h-7m6x-2hcm",
      ]),
    });
  });
});
