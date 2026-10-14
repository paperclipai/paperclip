import { paperclipRunnerSupportsPlatform } from "@paperclipai/shared";

export function localAgentRunnerTarget(): { driver: "local"; platform: NodeJS.Platform; architecture: string; libc?: "glibc" | "unknown"; glibcVersion?: string } {
  if (process.platform !== "linux") return { driver: "local", platform: process.platform, architecture: process.arch };
  let libc: "glibc" | "unknown" = "unknown";
  let glibcVersion: string | undefined;
  try {
    const { header } = process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } };
    if (typeof header?.glibcVersionRuntime === "string" && header.glibcVersionRuntime.trim()) {
      libc = "glibc";
      glibcVersion = header.glibcVersionRuntime.trim();
    }
  } catch { /* An unidentified libc must not select a GNU/Linux binary. */ }
  return { driver: "local", platform: process.platform, architecture: process.arch, libc, ...(glibcVersion === undefined ? {} : { glibcVersion }) };
}

export function localPaperclipRunnerSupported(): boolean {
  const target = localAgentRunnerTarget();
  return paperclipRunnerSupportsPlatform("codex_local", target.platform, target.architecture, target.libc, target.glibcVersion);
}
