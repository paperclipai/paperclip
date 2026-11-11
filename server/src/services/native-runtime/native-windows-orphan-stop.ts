import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";

const execute = promisify(execFile);
export type WindowsOrphanStop = { pid: number; startedAt: string };

/** Only for a fenced runner whose authoritative thread is closed and read-only.
 * Capture a process handle and compare its birth before signalling; never use
 * taskkill or infer Windows process containment from a negative PID. */
export async function stopReadOnlyWindowsOrphans(input: {
  pids: number[]; parentPid: number; executable: string; codexHome: string;
  notBefore: string; notAfter: string;
}): Promise<WindowsOrphanStop[] | null> {
  if (process.platform !== "win32" || !input.pids.length || input.pids.length > 32 ||
      ![input.parentPid, ...input.pids].every(pid => Number.isSafeInteger(pid) && pid > 1 && pid < 2 ** 31 && pid !== process.pid) ||
      !win32.isAbsolute(input.executable) || !input.executable.toLowerCase().endsWith(".exe") ||
      !win32.isAbsolute(input.codexHome)) return null;
  const notBefore = Date.parse(input.notBefore), notAfter = Date.parse(input.notAfter);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notAfter < notBefore) return null;
  const payload = Buffer.from(JSON.stringify({ ...input, executable: win32.resolve(input.executable),
    codexHome: win32.resolve(input.codexHome), notBefore, notAfter })).toString("base64");
  const script = `
$ErrorActionPreference='Stop'
try {
  $request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
  if(Get-CimInstance Win32_Process -Filter ('ProcessId='+$request.parentPid)){ throw 'parent_live' }
  $owned=@()
  foreach($number in $request.pids) {
    $candidate=Get-CimInstance Win32_Process -Filter ('ProcessId='+$number)
    if(!$candidate){ continue }
    $birth=[DateTimeOffset]::new($candidate.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()
    $command=[string]$candidate.CommandLine
    $candidateHome=[string]$request.codexHome
    if($candidate.ParentProcessId -ne $request.parentPid -or !$candidate.ExecutablePath -or
       [IO.Path]::GetFullPath($candidate.ExecutablePath) -ine $request.executable -or
       $birth -lt $request.notBefore -or $birth -gt $request.notAfter -or
       ($command.IndexOf($candidateHome,[StringComparison]::OrdinalIgnoreCase) -lt 0 -and
        $command.IndexOf($candidateHome.Replace('\\','\\\\'),[StringComparison]::OrdinalIgnoreCase) -lt 0)){ throw 'ownership_changed' }
    $handle=[Diagnostics.Process]::GetProcessById([int]$number)
    $null=$handle.Handle
    if([DateTimeOffset]::new($handle.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() -ne $birth){ $handle.Dispose(); throw 'birth_changed' }
    $owned+=@{Handle=$handle;Pid=[int]$number;StartedAt=$handle.StartTime.ToUniversalTime().ToString('o')}
  }
  $stopped=@()
  foreach($item in $owned) {
    if(!$item.Handle.HasExited){ $item.Handle.Kill() }
    if(!$item.Handle.WaitForExit(3000)){ throw 'stop_pending' }
    $stopped+=@{pid=$item.Pid;startedAt=$item.StartedAt}
    $item.Handle.Dispose()
  }
  @{verified=$true;stopped=@($stopped)} | ConvertTo-Json -Compress -Depth 3
} catch { @{verified=$false;stopped=@()} | ConvertTo-Json -Compress }
`;
  try {
    const { stdout } = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 12_000, maxBuffer: 64 * 1024 });
    const result = JSON.parse(stdout.trim());
    if (result.verified !== true || !Array.isArray(result.stopped) || result.stopped.some((row: WindowsOrphanStop) =>
      !input.pids.includes(row.pid) || typeof row.startedAt !== "string" || !Number.isFinite(Date.parse(row.startedAt)))) return null;
    return result.stopped;
  } catch { return null; }
}
