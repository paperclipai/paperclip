export interface CommandSpec {
  cmd: string;
  args: string[];
}

export function openArgs(path: string): CommandSpec {
  switch (process.platform) {
    case "darwin":
      return { cmd: "open", args: [path] };
    case "win32":
      return { cmd: "cmd", args: ["/c", "start", "", path] };
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

export function revealArgs(path: string): CommandSpec {
  switch (process.platform) {
    case "darwin":
      return { cmd: "open", args: ["-R", path] };
    case "win32":
      return { cmd: "explorer.exe", args: [`/select,${path}`] };
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}
