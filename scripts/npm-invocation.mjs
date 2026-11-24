import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function resolveNpmInvocation({ platform = process.platform, env = process.env, execPath = process.execPath, exists = existsSync } = {}) {
  if (platform !== "win32") return { command: "npm", argsPrefix: [] };
  const paths = path.win32;
  const configured = env.npm_execpath;
  const searchPath = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const candidates = [
    ...(configured && paths.basename(configured).toLowerCase() === "npm-cli.js" ? [configured] : []),
    ...[paths.dirname(execPath), ...searchPath.split(";").filter(Boolean)]
      .map(directory => paths.join(directory, "node_modules/npm/bin/npm-cli.js")),
  ];
  const cli = candidates.find(candidate => exists(candidate));
  if (!cli) throw new Error("Cannot find npm-cli.js for this Windows Node installation. Install npm alongside Node or add its installation directory to PATH.");
  return { command: execPath, argsPrefix: [cli] };
}

export function execNpmSync(args, options = {}) {
  const invocation = resolveNpmInvocation({ env: options.env ?? process.env });
  return execFileSync(invocation.command, [...invocation.argsPrefix, ...args], options);
}
