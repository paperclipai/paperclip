import { constants, promises as fs } from "node:fs";
import path from "node:path";

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

export async function resolveCommandPath(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return await pathExists(absolute) ? absolute : null;
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  const hasExtension = process.platform === "win32" && path.extname(command).length > 0;
  for (const dir of dirs) {
    const candidates = process.platform === "win32"
      ? hasExtension ? [path.join(dir, command)] : exts.map(ext => path.join(dir, `${command}${ext}`))
      : [path.join(dir, command)];
    for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

export function windowsCommandTarget(executable: string, args: string[], env: NodeJS.ProcessEnv) {
  if (!/\.(cmd|bat)$/i.test(executable)) return { command: executable, args };
  // Batch wrappers require cmd.exe even when ComSpec points at PowerShell.
  const root = env.SystemRoot || process.env.SystemRoot || "C:\\Windows";
  return {
    command: path.join(root, "System32", "cmd.exe"),
    args: ["/d", "/s", "/c", [quoteForCmd(executable), ...args.map(quoteForCmd)].join(" ")],
  };
}
