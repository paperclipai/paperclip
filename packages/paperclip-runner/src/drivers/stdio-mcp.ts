import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface StdioMcpLaunchBinding {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  sha256: string;
  serialResource: string;
}

export const STDIO_MCP_BINDINGS_ENV = "PAPERCLIP_NATIVE_MCP_STDIO";

export function stdioMcpLaunchBindings(environment: NodeJS.ProcessEnv): StdioMcpLaunchBinding[] {
  const raw = environment[STDIO_MCP_BINDINGS_ENV];
  if (raw === undefined) return [];
  const invalid = () => new Error("assigned stdio MCP launch binding is invalid");
  if (Buffer.byteLength(raw) > 64 * 1024) throw invalid();
  let values: unknown;
  try { values = JSON.parse(raw); } catch { throw invalid(); }
  if (!Array.isArray(values) || values.length > 8) throw invalid();
  const names = new Set<string>(["paperclip", environment.PAPERCLIP_NATIVE_MCP_NAME ?? ""]);
  return values.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const binding = value as Record<string, unknown>;
    if (Object.keys(binding).sort().join(",") !== "args,command,env,name,serialResource,sha256"
      || typeof binding.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(binding.name)
      || names.has(binding.name) || binding.name.startsWith("paperclip_runner_")
      || typeof binding.command !== "string" || !isAbsolute(binding.command)
      || binding.command.includes("\0") || binding.command.length > 4096
      || typeof binding.serialResource !== "string" || !isAbsolute(binding.serialResource) || binding.serialResource.includes("\0")
      || typeof binding.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(binding.sha256)
      || !Array.isArray(binding.args) || binding.args.length > 64
      || binding.args.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.length > 4096)
      || !binding.env || typeof binding.env !== "object" || Array.isArray(binding.env)) throw invalid();
    const env = binding.env as Record<string, unknown>;
    if (Object.keys(env).length > 64 || Object.entries(env).some(([key, value]) =>
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || /^(?:LD_|DYLD_)/.test(key) || ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV"].includes(key) || typeof value !== "string" || value.includes("\0")
    )) throw invalid();
    const metadata = lstatSync(binding.command);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !(metadata.mode & 0o111)
      || (metadata.mode & 0o022) || realpathSync(binding.command) !== binding.command) throw invalid();
    const digest = `sha256:${createHash("sha256").update(readFileSync(binding.command)).digest("hex")}`;
    if (digest !== binding.sha256) throw new Error("assigned stdio MCP executable digest mismatch");
    names.add(binding.name);
    return { name: binding.name, command: binding.command, args: binding.args as string[], env: env as Record<string, string>, sha256: binding.sha256, serialResource: binding.serialResource };
  });
}

export function prepareStdioMcpBindings(environment: NodeJS.ProcessEnv, root: string) {
  const bindings = stdioMcpLaunchBindings(environment);
  const directory = join(root, "stdio-mcp");
  const proxy = environment.PAPERCLIP_NATIVE_MCP_PROXY;
  if (bindings.length && (!proxy || !isAbsolute(proxy) || proxy.includes("\0"))) {
    throw new Error("assigned stdio MCP proxy is unavailable");
  }
  rmSync(directory, { force: true, recursive: true });
  if (!bindings.length) return [];
  mkdirSync(directory, { mode: 0o700 });
  return bindings.map((binding, index) => {
    const path = join(directory, `${index}.json`);
    writeFileSync(path, JSON.stringify(binding), { mode: 0o600, flag: "wx" });
    return { name: binding.name, command: proxy!, args: ["--stdio-mcp", path], env: {}, runnerOwned: false as const };
  });
}
