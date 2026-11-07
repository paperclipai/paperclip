import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let clockTicksPerSecond: number | undefined;

export interface LinuxProcessStartOptions {
  readFile?: (path: string) => string;
  clockTicksPerSecond?: number;
}

/** /proc/PID directory ctime is lookup metadata, not the process's birth time. */
export function readLinuxProcessStartedAt(pid: number, options: LinuxProcessStartOptions = {}): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Linux process PID");
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const processStat = readFile(`/proc/${pid}/stat`);
  // comm can contain spaces and parentheses. Fields after its final ')' start
  // at field 3 (state), so field 22 (starttime) is index 19 in this suffix.
  const end = processStat.lastIndexOf(") ");
  const fields = end >= 0 ? processStat.slice(end + 2).trim().split(/\s+/) : [];
  const startTicks = fields[19];
  const bootSeconds = /^btime (\d+)$/m.exec(readFile("/proc/stat"))?.[1];
  if (!processStat.startsWith(`${pid} (`) || !/^\d+$/.test(startTicks ?? "") || !bootSeconds) {
    throw new Error("Invalid Linux process birth metadata");
  }
  let ticks = options.clockTicksPerSecond;
  if (ticks === undefined) {
    clockTicksPerSecond ??= Number(execFileSync("getconf", ["CLK_TCK"], {
      encoding: "utf8", timeout: 1_500, windowsHide: true,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    }).trim());
    ticks = clockTicksPerSecond;
  }
  if (!Number.isSafeInteger(ticks) || ticks <= 0) throw new Error("Invalid Linux clock tick frequency");
  const milliseconds = BigInt(bootSeconds) * 1_000n + BigInt(startTicks!) * 1_000n / BigInt(ticks);
  const value = Number(milliseconds);
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
    throw new Error("Invalid Linux process birth timestamp");
  }
  return new Date(value).toISOString();
}

/** OS start time of a local process as an ISO string, or null when it cannot be read. */
export function readLocalProcessStartedAt(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      return readLinuxProcessStartedAt(pid);
    }
    if (
      ["darwin", "freebsd", "openbsd", "aix", "sunos"].includes(
        process.platform,
      )
    ) {
      const raw = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1_500,
        windowsHide: true,
      }).trim();
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    if (process.platform === "win32") {
      const script = [
        `$target = Get-Process -Id ${pid} -ErrorAction Stop`,
        "$target.StartTime.ToUniversalTime().ToString('o')",
      ].join("; ");
      for (const command of ["powershell.exe", "pwsh.exe"]) {
        try {
          const raw = execFileSync(
            command,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            { encoding: "utf8", timeout: 1_500, windowsHide: true },
          ).trim();
          const parsed = new Date(raw);
          if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
        } catch {
          // Try the other supported PowerShell host.
        }
      }
    }
  } catch {
    // Process exit and restricted process metadata both produce no fingerprint.
  }
  return null;
}
