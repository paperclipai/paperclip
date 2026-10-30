import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";

export function sourceFiles(cwd = process.cwd()) {
  return [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean))].sort();
}

const literalGlob = (file) => file.replace(/([*?{}[\]\\])/g, "\\$1");

const groups = {
  "ci:server": "general-server-without-chat",
  "ci:chat": "general-chat",
  "ci:workspaces-a": "general-workspaces-a",
  "ci:workspaces-b": "general-workspaces-b",
  "ci:db": "general-workspaces-c",
};

export function executionPlan(config, task, args, files = sourceFiles()) {
  const definition = config.tasks[`//#${task}`];
  if (!definition?.cache) throw new Error(`Task is not executable through the cache: ${task}`);
  let target, commandArgs;
  if (groups[task]) {
    target = "//#test:run:general";
    commandArgs = ["--", "--group", groups[task], ...args];
  } else if (task === "ci:serialized") {
    target = "//#test:run:serialized";
    commandArgs = ["--", ...args];
  } else if (task === "ci:runner-rust") {
    target = "@paperclipai/paperclip-runner#check:runner";
    commandArgs = args;
  } else throw new Error(`Missing task command: ${task}`);
  const select = (globs) => files.filter((file) => globs.some((glob) => matchesGlob(file, glob))).map(literalGlob);
  const selectedInputs = select(definition.inputs);
  const inputs = target.startsWith("//#") ? selectedInputs
    : selectedInputs.map((input) => `$TURBO_ROOT$/${input}`);
  return { target, args: commandArgs, config: { ...config,
    globalDependencies: select(config.globalDependencies ?? []), tasks: { [target]: { ...definition, inputs } } } };
}
