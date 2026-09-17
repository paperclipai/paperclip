import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export interface SshConfig {
  sshPrivateKey?: string;
  sshIdentityFile?: string;
  knownHosts?: string;
  strictHostKeyChecking: "yes" | "accept-new";
  timeoutMs: number;
}

export const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

export async function openSsh(config: SshConfig, host: string, command: string, sensitiveCommand = false): Promise<{
  child: ChildProcessWithoutNullStreams;
  cleanup: () => Promise<void>;
}> {
  if (host !== "exe.dev" && !/^[a-z0-9][a-z0-9-]{0,62}\.exe\.xyz$/.test(host)) throw new Error("Invalid exe.dev SSH host");
  const temporary = await mkdtemp(path.join(tmpdir(), "paperclip-exe-"));
  try {
    let identity = config.sshIdentityFile;
    if (config.sshPrivateKey) {
      identity = path.join(temporary, "identity");
      await writeFile(identity, config.sshPrivateKey.trim() + "\n", { mode: 0o600 });
    }
    const hostDirectory = path.join(homedir(), ".ssh");
    await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
    let knownHosts = path.join(hostDirectory, "paperclip-exe-known_hosts");
    if (config.knownHosts) {
      knownHosts = path.join(temporary, "known_hosts");
      await writeFile(knownHosts, config.knownHosts + "\n", { mode: 0o600 });
    }
    let configFile = "/dev/null";
    if (sensitiveCommand) {
      if (/[\r\n\0]/.test(command)) throw new Error("Sensitive SSH commands must be single-line");
      configFile = path.join(temporary, "config");
      // RemoteCommand keeps registry credentials out of the process argv. OpenSSH
      // expands percent tokens in this directive; escape every literal percent.
      await writeFile(configFile, `RemoteCommand ${command.replaceAll("%", "%%")}\n`, { mode: 0o600 });
    }
    const args = ["-F", configFile, "-T", "-o", "BatchMode=yes", "-o", "ForwardAgent=no",
      "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3", "-o", `StrictHostKeyChecking=${config.knownHosts ? "yes" : config.strictHostKeyChecking}`,
      "-o", `UserKnownHostsFile=${knownHosts}`];
    if (identity) args.push("-i", identity, "-o", "IdentitiesOnly=yes");
    args.push(host);
    if (!sensitiveCommand) args.push(command);
    const child = spawn("ssh", args, { stdio: "pipe" });
    child.stdin.on("error", () => {});
    const cleanup = async () => { await rm(temporary, { recursive: true, force: true }); };
    child.once("close", () => { void cleanup(); });
    return { child, cleanup };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function ssh(config: SshConfig, host: string, command: string, stdin?: string, sensitiveCommand = false): Promise<string> {
  const { child } = await openSsh(config, host, command, sensitiveCommand);
  return await new Promise((resolve, reject) => {
    let stdout = ""; let stderr = ""; let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, config.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 32 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8192); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || expired) reject(new Error(expired ? "exe.dev SSH deadline exceeded; remote state requires reconciliation" : `exe.dev SSH failed (${code}): ${stderr}`));
      else resolve(stdout);
    });
    child.stdin.end(stdin);
  });
}
