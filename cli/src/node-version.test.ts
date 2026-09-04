import { describe, expect, it } from "vitest";
import {
  formatNodeVersionWarning,
  isSupportedNodeVersion,
  MINIMUM_NODE_VERSION,
  NODE_VERSION_INSTALL_GUIDE_URL,
  warnIfUnsupportedNodeVersion,
} from "@paperclipai/shared/node-version";

describe("isSupportedNodeVersion", () => {
  it("accepts the Node 24 LTS floor and newer releases", () => {
    expect(MINIMUM_NODE_VERSION).toBe("24.11.0");
    expect(isSupportedNodeVersion("v24.11.0")).toBe(true);
    expect(isSupportedNodeVersion("24.19.0")).toBe(true);
    expect(isSupportedNodeVersion("v26.0.0")).toBe(true);
  });

  it("rejects pre-LTS Node 24 and older major releases", () => {
    expect(isSupportedNodeVersion("v24.10.0")).toBe(false);
    expect(isSupportedNodeVersion("v22.23.0")).toBe(false);
    expect(isSupportedNodeVersion("unknown")).toBe(false);
  });

  it("provides non-blocking remediation text for unsupported runtimes", () => {
    expect(formatNodeVersionWarning("v24.11.0")).toBeNull();
    const warning = formatNodeVersionWarning("v22.23.0");
    expect(warning).toContain("Node.js v22.23.0 is unsupported");
    expect(warning).toContain("requires Node.js 24.11.0 or newer");
    expect(warning).toContain(NODE_VERSION_INSTALL_GUIDE_URL);
    expect(warning).toContain("piped install.sh form cannot upgrade");
    expect(warning).toContain("Restart Paperclip after upgrading");
  });

  it("emits at most one warning when CLI and server boot in the same process", () => {
    const warnings: string[] = [];
    expect(
      warnIfUnsupportedNodeVersion("22.23.0", (message) => warnings.push(message)),
    ).toBe(true);
    expect(
      warnIfUnsupportedNodeVersion("22.23.0", (message) => warnings.push(message)),
    ).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});
