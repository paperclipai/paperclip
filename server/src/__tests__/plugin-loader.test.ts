import { describe, expect, it } from "vitest";
import { getManifestImportTarget, getNpmCommand } from "../services/plugin-loader.js";

describe("plugin-loader windows compatibility helpers", () => {
  it("uses npm.cmd on Windows without enabling a shell", () => {
    expect(getNpmCommand("win32")).toBe("npm.cmd");
    expect(getNpmCommand("linux")).toBe("npm");
  });

  it("converts Windows drive-letter manifest paths into file URLs", () => {
    expect(
      getManifestImportTarget(
        "C:\\Users\\alice\\paperclip-plugin\\dist\\manifest.js",
        "win32",
      ),
    ).toBe("file:///C:/Users/alice/paperclip-plugin/dist/manifest.js");
  });

  it("encodes Windows manifest paths with spaces and URL-special characters", () => {
    expect(
      getManifestImportTarget(
        "C:\\Users\\alice\\paperclip plugin\\100% coverage\\pkg#1\\manifest?.js",
        "win32",
      ),
    ).toBe(
      "file:///C:/Users/alice/paperclip%20plugin/100%25%20coverage/pkg%231/manifest%3F.js",
    );
  });

  it("converts Windows UNC manifest paths into file URLs", () => {
    expect(
      getManifestImportTarget(
        "\\\\server\\share name\\pkg#1\\manifest.js",
        "win32",
      ),
    ).toBe("file://server/share%20name/pkg%231/manifest.js");
  });

  it("leaves non-Windows manifest paths unchanged", () => {
    expect(getManifestImportTarget("/tmp/plugin/dist/manifest.js", "linux")).toBe(
      "/tmp/plugin/dist/manifest.js",
    );
    expect(getManifestImportTarget("./dist/manifest.js", "win32")).toBe("./dist/manifest.js");
  });
});
