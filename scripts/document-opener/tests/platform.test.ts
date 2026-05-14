import { describe, expect, it, vi } from "vitest";
import { openArgs, revealArgs } from "../src/platform";

describe("platform dispatch", () => {
  it("openArgs darwin → open <path>", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(openArgs("/Users/foo/x.md")).toEqual({
      cmd: "open",
      args: ["/Users/foo/x.md"],
    });
    vi.unstubAllGlobals();
  });

  it("openArgs win32 → cmd /c start \"\" <path>", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(openArgs("C:\\foo\\x.md")).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", "C:\\foo\\x.md"],
    });
    vi.unstubAllGlobals();
  });

  it("revealArgs darwin → open -R <path>", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(revealArgs("/Users/foo/x.md")).toEqual({
      cmd: "open",
      args: ["-R", "/Users/foo/x.md"],
    });
    vi.unstubAllGlobals();
  });

  it("revealArgs win32 → explorer /select,<path>", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(revealArgs("C:\\foo\\x.md")).toEqual({
      cmd: "explorer.exe",
      args: ["/select,C:\\foo\\x.md"],
    });
    vi.unstubAllGlobals();
  });

  it("throws on unsupported platform", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    expect(() => openArgs("/x")).toThrow(/unsupported/i);
    expect(() => revealArgs("/x")).toThrow(/unsupported/i);
    vi.unstubAllGlobals();
  });
});
