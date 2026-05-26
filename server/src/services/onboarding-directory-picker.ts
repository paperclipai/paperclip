import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { unprocessable } from "../errors.js";

const execFileAsync = promisify(execFile);
const PICKER_TIMEOUT_MS = 120_000;

export interface DirectoryPickerCommand {
  command: string;
  args: string[];
}

export function buildDirectoryPickerCommand(platform = process.platform): DirectoryPickerCommand | null {
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: [
        "-e",
        'POSIX path of (choose folder with prompt "Select a project folder for Paperclip onboarding")',
      ],
    };
  }

  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-STA",
        "-Command",
        [
          "Add-Type -AssemblyName System.Windows.Forms;",
          "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
          '$dialog.Description = "Select a project folder for Paperclip onboarding";',
          "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
          "  [Console]::WriteLine($dialog.SelectedPath)",
          "}",
        ].join(" "),
      ],
    };
  }

  if (platform === "linux") {
    return {
      command: "zenity",
      args: [
        "--file-selection",
        "--directory",
        "--title=Select a project folder for Paperclip onboarding",
      ],
    };
  }

  return null;
}

function isPickerCancel(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return message.toLowerCase().includes("user canceled") || code === 1 || code === "1";
}

export async function pickOnboardingDirectory(): Promise<{ path: string | null; cancelled: boolean }> {
  const picker = buildDirectoryPickerCommand();
  if (!picker) {
    throw unprocessable("Folder browsing is not supported on this operating system. Paste an absolute folder path instead.");
  }

  try {
    const { stdout } = await execFileAsync(picker.command, picker.args, {
      timeout: PICKER_TIMEOUT_MS,
      maxBuffer: 32 * 1024,
    });
    const selectedPath = stdout.trim();
    return selectedPath ? { path: selectedPath, cancelled: false } : { path: null, cancelled: true };
  } catch (error) {
    if (isPickerCancel(error)) {
      return { path: null, cancelled: true };
    }
    throw unprocessable("Unable to open the folder picker. Paste an absolute folder path instead.");
  }
}
