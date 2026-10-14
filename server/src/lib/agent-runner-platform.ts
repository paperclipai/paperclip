import { paperclipRunnerSupportsPlatform } from "@paperclipai/shared";

type LinuxLibc = { libc: "glibc" | "unknown"; glibcVersion?: string };

// `excludeNetwork` is part of the Node 24 report API, but the installed Node
// type definitions do not declare it yet.
type ProcessReportWithNetworkSetting = NodeJS.ProcessReport & { excludeNetwork: boolean };

let cachedLinuxLibc: LinuxLibc | undefined;

// The C library cannot change while the process runs, so detect it once.
// `process.report.getReport()` blocks the event loop. Unless `excludeNetwork`
// is set, it also resolves the endpoints of every open socket with synchronous
// reverse DNS. A slow resolver then stalls the server for seconds per socket,
// on every caller, so the report always excludes network data.
function detectLinuxLibc(): LinuxLibc {
  if (cachedLinuxLibc) return cachedLinuxLibc;
  let detected: LinuxLibc = { libc: "unknown" };
  const report = process.report as ProcessReportWithNetworkSetting;
  const previousExcludeNetwork = report.excludeNetwork;
  try {
    report.excludeNetwork = true;
    const { header } = report.getReport() as { header?: { glibcVersionRuntime?: unknown } };
    if (typeof header?.glibcVersionRuntime === "string" && header.glibcVersionRuntime.trim()) {
      detected = { libc: "glibc", glibcVersion: header.glibcVersionRuntime.trim() };
    }
  } catch {
    /* An unidentified libc must not select a GNU/Linux binary. */
  } finally {
    report.excludeNetwork = previousExcludeNetwork;
  }
  cachedLinuxLibc = detected;
  return detected;
}

export function resetLocalAgentRunnerTargetCacheForTests(): void {
  cachedLinuxLibc = undefined;
}

export function localAgentRunnerTarget(): { driver: "local"; platform: NodeJS.Platform; architecture: string; libc?: "glibc" | "unknown"; glibcVersion?: string } {
  if (process.platform !== "linux") return { driver: "local", platform: process.platform, architecture: process.arch };
  const { libc, glibcVersion } = detectLinuxLibc();
  return { driver: "local", platform: process.platform, architecture: process.arch, libc, ...(glibcVersion === undefined ? {} : { glibcVersion }) };
}

export function localPaperclipRunnerSupported(): boolean {
  const target = localAgentRunnerTarget();
  return paperclipRunnerSupportsPlatform("codex_local", target.platform, target.architecture, target.libc, target.glibcVersion);
}
