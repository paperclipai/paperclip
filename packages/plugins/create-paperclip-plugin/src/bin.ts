#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scaffoldPluginProject, type ScaffoldPluginOptions } from "./index.js";

interface RunCliDeps {
  cwd?: string;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  exit?: (code: number) => never;
}

function parseArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

/** Convert `@scope/name` to an output directory basename (`name`). */
function packageToDirName(pluginName: string): string {
  return pluginName.replace(/^@[^/]+\//, "");
}

/** CLI wrapper for `scaffoldPluginProject`. */
export function runCli(argv = process.argv, deps: RunCliDeps = {}): string | undefined {
  const pluginName = argv[2];
  const stderr = deps.stderr ?? console.error;
  const stdout = deps.stdout ?? console.log;
  const exit = deps.exit ?? process.exit;

  if (!pluginName) {
    stderr("Usage: create-paperclip-plugin <name> [--template default|connector|workspace] [--output <dir>] [--sdk-path <paperclip-sdk-path>]");
    exit(1);
  }

  const template = (parseArg(argv, "--template") ?? "default") as ScaffoldPluginOptions["template"];
  const outputRoot = parseArg(argv, "--output") ?? deps.cwd ?? process.cwd();
  const targetDir = path.resolve(outputRoot, packageToDirName(pluginName));

  const out = scaffoldPluginProject({
    pluginName,
    outputDir: targetDir,
    template,
    displayName: parseArg(argv, "--display-name"),
    description: parseArg(argv, "--description"),
    author: parseArg(argv, "--author"),
    category: parseArg(argv, "--category") as ScaffoldPluginOptions["category"] | undefined,
    sdkPath: parseArg(argv, "--sdk-path"),
  });

  stdout(`Created plugin scaffold at ${out}`);
  return out;
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false;
}

if (isMainModule()) {
  runCli();
}
