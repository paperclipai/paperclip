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
    expect(rootPackageJson.pnpm.overrides["@connectrpc/connect-node>undici"]).toBe(
      ">=6.27.0 <7",
    );
    expect(rootPackageJson.pnpm.overrides["jsdom>undici"]).toBe(">=7.28.0 <8");
    expect(rootPackageJson.pnpm.overrides.multer).toBe(">=2.2.0 <3");
    expect(serverPackageJson.dependencies.multer).toBe("^2.2.0");
  });
});
