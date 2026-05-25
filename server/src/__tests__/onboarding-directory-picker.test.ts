import { describe, expect, it } from "vitest";

import { buildDirectoryPickerCommand } from "../services/onboarding-directory-picker.js";

describe("onboarding directory picker", () => {
  it("builds a macOS folder picker command without shell interpolation", () => {
    expect(buildDirectoryPickerCommand("darwin")).toEqual({
      command: "osascript",
      args: [
        "-e",
        'POSIX path of (choose folder with prompt "Select a project folder for Paperclip onboarding")',
      ],
    });
  });

  it("builds platform-specific commands for common desktop hosts", () => {
    expect(buildDirectoryPickerCommand("win32")?.command).toBe("powershell.exe");
    expect(buildDirectoryPickerCommand("linux")).toEqual({
      command: "zenity",
      args: [
        "--file-selection",
        "--directory",
        "--title=Select a project folder for Paperclip onboarding",
      ],
    });
  });

  it("returns null for unsupported platforms", () => {
    expect(buildDirectoryPickerCommand("freebsd")).toBeNull();
  });
});
