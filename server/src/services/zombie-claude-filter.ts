/** Shared logic for identifying zombie claude processes from ps output. */

export const CPU_THRESHOLD_SECONDS = 21600; // 360 minutes * 60

export interface ProcessInfo {
  cpuSeconds: number;
  pid: number;
  command: string;
}

/**
 * Parse a line of `ps -o cputime=,pid=,command=` output.
 * Format: "HH:MM:SS  PID COMMAND..."
 */
export function parseProcessLine(line: string): ProcessInfo | null {
  const match = line.trim().match(/^(\d+):(\d+):(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return null;
  const hours = parseInt(match[1]!, 10);
  const minutes = parseInt(match[2]!, 10);
  const seconds = parseInt(match[3]!, 10);
  return {
    cpuSeconds: hours * 3600 + minutes * 60 + seconds,
    pid: parseInt(match[4]!, 10),
    command: match[5]!,
  };
}

/**
 * Determine whether a process should be killed as a zombie claude process.
 * Must be a claude process (command contains "claude" but not the paperclip server)
 * AND exceed the CPU threshold.
 */
export function shouldKillProcess(info: ProcessInfo): boolean {
  const cmd = info.command.toLowerCase();
  const isClaude = cmd.includes("claude") && !cmd.includes("paperclip");
  return isClaude && info.cpuSeconds > CPU_THRESHOLD_SECONDS;
}
