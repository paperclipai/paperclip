import { tauriInvoke } from "./tauri-client";

export interface SystemInfo {
  os: string;
  arch: string;
  cpu_count: number;
  hostname: string;
}

export const automationApi = {
  runAppleScript: (script: string) =>
    tauriInvoke<string>("run_applescript", { script }),
  listShortcuts: () =>
    tauriInvoke<string[]>("list_shortcuts"),
  runShortcut: (name: string) =>
    tauriInvoke<string>("run_shortcut", { name }),
  getSystemInfo: () =>
    tauriInvoke<SystemInfo>("get_automation_system_info"),
};
