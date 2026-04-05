import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  detectPlatform,
  findPackageRoot,
  xmlEscape,
} from "../commands/service.js";

// ---------------------------------------------------------------------------
// xmlEscape
// ---------------------------------------------------------------------------

describe("xmlEscape", () => {
  it("escapes ampersands", () => {
    expect(xmlEscape("a&b")).toBe("a&amp;b");
  });

  it("escapes angle brackets", () => {
    expect(xmlEscape("<tag>")).toBe("&lt;tag&gt;");
  });

  it("escapes double quotes", () => {
    expect(xmlEscape('key="val"')).toBe("key=&quot;val&quot;");
  });

  it("returns plain strings unchanged", () => {
    expect(xmlEscape("/usr/bin/node")).toBe("/usr/bin/node");
  });
});

// ---------------------------------------------------------------------------
// findPackageRoot
// ---------------------------------------------------------------------------

describe("findPackageRoot", () => {
  it("finds the root from a nested directory", () => {
    // import.meta.dirname is cli/src/__tests__, root has package.json with name "paperclip"
    const root = findPackageRoot(import.meta.dirname);
    expect(root).toBeTruthy();
    expect(existsSync(path.join(root, "package.json"))).toBe(true);
  });

  it("throws when started from a directory with no matching package.json", () => {
    expect(() => findPackageRoot("/")).toThrow("Could not find paperclipai package root");
  });
});

// ---------------------------------------------------------------------------
// Template generation
// ---------------------------------------------------------------------------

describe("generateLaunchdPlist", () => {
  it("produces valid XML with expected keys", () => {
    const plist = generateLaunchdPlist();
    expect(plist).toContain("<?xml version");
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("com.paperclipai.paperclip");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("<integer>10</integer>");
    expect(plist).toContain("server");
    expect(plist).toContain("service.log");
  });

  it("does not reference dev-runner.mjs", () => {
    const plist = generateLaunchdPlist();
    expect(plist).not.toContain("dev-runner.mjs");
  });

  it("uses the current node executable path", () => {
    const plist = generateLaunchdPlist();
    expect(plist).toContain(process.execPath);
  });

  it("sets WorkingDirectory to a valid directory", () => {
    const plist = generateLaunchdPlist();
    expect(plist).toContain("<key>WorkingDirectory</key>");
  });
});

describe("generateSystemdUnit", () => {
  it("produces a valid systemd unit with required sections", () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
  });

  it("sets Restart=always and RestartSec=10", () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=10");
  });

  it("uses %h for home directory in log paths", () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain("%h/.paperclip/logs/service.log");
  });

  it("targets network.target and default.target", () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain("After=network.target");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("quotes paths in ExecStart", () => {
    const unit = generateSystemdUnit();
    const execLine = unit.split("\n").find((l) => l.startsWith("ExecStart="))!;
    // Should have quoted paths
    expect(execLine).toMatch(/^ExecStart="[^"]+"\s+"[^"]+"/);
  });

  it("does not reference dev-runner.mjs", () => {
    const unit = generateSystemdUnit();
    expect(unit).not.toContain("dev-runner.mjs");
  });

  it("quotes WorkingDirectory for paths with spaces", () => {
    const unit = generateSystemdUnit();
    const wdLine = unit.split("\n").find((l) => l.startsWith("WorkingDirectory="))!;
    // Should be wrapped in double quotes
    expect(wdLine).toMatch(/^WorkingDirectory="[^"]+"/);
  });
});

// ---------------------------------------------------------------------------
// OS detection
// ---------------------------------------------------------------------------

describe("detectPlatform", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
  });

  it("returns 'darwin' on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    expect(detectPlatform()).toBe("darwin");
  });

  it("returns 'linux' on Linux", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(detectPlatform()).toBe("linux");
  });

  it("throws on unsupported platforms", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(() => detectPlatform()).toThrow(
      "Platform win32 is not supported",
    );
  });
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe("path resolution in templates", () => {
  it("plist ProgramArguments contains absolute node path", () => {
    const plist = generateLaunchdPlist();
    const nodePathMatch = plist.match(/<string>(\/[^<]+node[^<]*)<\/string>/);
    expect(nodePathMatch).not.toBeNull();
  });

  it("systemd ExecStart contains absolute paths", () => {
    const unit = generateSystemdUnit();
    const execLine = unit.split("\n").find((l) => l.startsWith("ExecStart="))!;
    expect(execLine).toMatch(/^ExecStart="/);
  });
});
