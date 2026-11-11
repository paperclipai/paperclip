import { chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import type { ProviderObservabilityLaunch } from "./agent-observability.js";

export function selectedCodexProfile(args: readonly string[]): string | undefined {
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile" || args[i] === "-p") names.push(args[++i] ?? "");
    else if (args[i].startsWith("--profile=")) names.push(args[i].slice(10));
    else if (args[i].startsWith("-p") && !args[i].startsWith("--")) names.push(args[i].slice(2));
  }
  if (names.length > 1 || names.some(name => !/^[A-Za-z0-9_-]+$/.test(name))) throw new Error("Invalid Codex profile selection");
  return names[0];
}

export function replaceCodexProfileArgs(args: string[], profile: string): void {
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i].startsWith("--profile=") || args[i].startsWith("-p") && args[i] !== "-p" && !args[i].startsWith("--")) args.splice(i, 1);
    else if (args[i] === "--profile" || args[i] === "-p") args.splice(i, 2);
  }
  args.unshift("--profile", profile);
}

/** Non-secret fail-open overrides preserve the selected profile's other settings. */
export function disableCodexObservabilityArgs(args: string[]): void {
  args.unshift(...["exporter", "trace_exporter", "metrics_exporter"].flatMap(key => ["-c", `otel.${key}="none"`]));
}

export async function prepareCodexObservabilityProfile(input: {
  home: string; runId: string; launch: ProviderObservabilityLaunch; sourceProfile?: string;
}) {
  if (!/^[A-Za-z0-9_-]+$/.test(input.runId)) throw new Error("Invalid observability run identity");
  const name = `paperclip-observability-${input.runId}`;
  const filename = `${name}.config.toml`;
  const file = path.join(input.home, filename);
  let source: Record<string, unknown> = {};
  if (input.sourceProfile) {
    if (!/^[A-Za-z0-9_-]+$/.test(input.sourceProfile)) throw new Error("Invalid source profile");
    const sourcePath = path.join(input.home, `${input.sourceProfile}.config.toml`);
    const stat = await lstat(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Source profile must be a regular file");
    source = parse(await readFile(sourcePath, "utf8"));
  }
  await writeFile(file, stringify({ ...source, otel: input.launch.otelConfig ?? { exporter: "none", trace_exporter: "none", metrics_exporter: "none" } }), { flag: "wx", mode: 0o600 });
  await chmod(file, 0o600);
  return { name, filename, cleanup: () => rm(file, { force: true }) };
}
