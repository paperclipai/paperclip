import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  readSshEnvLabFixtureStatus,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
} from "@paperclipai/adapter-utils/ssh";
import { resolvePaperclipInstanceId, resolvePaperclipInstanceRoot } from "../config/home.js";

export function resolveEnvLabSshStatePath(instanceId?: string): string {
  const resolvedInstanceId = resolvePaperclipInstanceId(instanceId);
  return path.resolve(
    resolvePaperclipInstanceRoot(resolvedInstanceId),
    "env-lab",
    "ssh-fixture",
    "state.json",
  );
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function summarizeFixture(state: {
  host: string;
  port: number;
  username: string;
  workspaceDir: string;
  sshdLogPath: string;
}) {
  p.log.message(`Host: ${pc.cyan(state.host)}:${pc.cyan(String(state.port))}`);
  p.log.message(`User: ${pc.cyan(state.username)}`);
  p.log.message(`Workspace: ${pc.cyan(state.workspaceDir)}`);
  p.log.message(`Log: ${pc.dim(state.sshdLogPath)}`);
}

export async function collectEnvLabDoctorStatus(opts: { instance?: string }) {
  const statePath = resolveEnvLabSshStatePath(opts.instance);
  const [sshSupport, sshStatus] = await Promise.all([
    getSshEnvLabSupport(),
    readSshEnvLabFixtureStatus(statePath),
  ]);
  const environment = sshStatus.state ? await buildSshEnvLabFixtureConfig(sshStatus.state) : null;

  return {
    statePath,
    ssh: {
      supported: sshSupport.supported,
      reason: sshSupport.reason,
      running: sshStatus.running,
      state: sshStatus.state,
      environment,
    },
  };
}

export async function envLabUpCommand(opts: { instance?: string; json?: boolean }) {
  const statePath = resolveEnvLabSshStatePath(opts.instance);
  const state = await startSshEnvLabFixture({ statePath });
  const environment = await buildSshEnvLabFixtureConfig(state);

  if (opts.json) {
    printJson({ state, environment });
    return;
  }

  p.log.success("SSH env-lab fixture is running.");
  summarizeFixture(state);
  p.log.message(`State: ${pc.dim(statePath)}`);
}

export async function envLabStatusCommand(opts: { instance?: string; json?: boolean }) {
  const statePath = resolveEnvLabSshStatePath(opts.instance);
  const status = await readSshEnvLabFixtureStatus(statePath);
  const environment = status.state ? await buildSshEnvLabFixtureConfig(status.state) : null;

  if (opts.json) {
    printJson({ ...status, environment, statePath });
    return;
  }

  if (!status.state || !status.running) {
    p.log.info(`SSH env-lab fixture is not running (${pc.dim(statePath)}).`);
    return;
  }

  p.log.success("SSH env-lab fixture is running.");
  summarizeFixture(status.state);
  p.log.message(`State: ${pc.dim(statePath)}`);
}

export async function envLabDownCommand(opts: { instance?: string; json?: boolean }) {
  const statePath = resolveEnvLabSshStatePath(opts.instance);
  const stopped = await stopSshEnvLabFixture(statePath);

  if (opts.json) {
    printJson({ stopped, statePath });
    return;
  }

  if (!stopped) {
    p.log.info(`No SSH env-lab fixture was running (${pc.dim(statePath)}).`);
    return;
  }

  p.log.success("SSH env-lab fixture stopped.");
  p.log.message(`State: ${pc.dim(statePath)}`);
}

// Quote one argument for a POSIX shell. The env-lab cleanup hint is copyable, so
// a contributor can paste it into a shell. A checkout path can hold shell
// metacharacters, such as `$`, a backtick, or a double quote. Inside double
// quotes a POSIX shell still expands `$(...)`, a backtick pair, and `$NAME`, and
// a double quote in the path ends the quoted span. So double quotes do not make
// the path safe. Single quotes stop every expansion. This function wraps the
// value in single quotes and rewrites each embedded single quote as the `'\''`
// sequence. The shell then reads the exact path and runs no embedded command.
function shellQuoteArgument(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// Describe how to re-run the env-lab CLI to stop the fixture. The bundled build
// emits one `dist/index.js` file, so node runs that file directly and `tsxBin`
// is `null`. A source checkout runs `src/index.ts` through the checked-out tsx
// runner, because the entry is TypeScript.
interface EnvLabCliInvocation {
  entry: string;
  tsxBin: string | null;
}

// Resolve how to re-run the CLI from the running module location. The cleanup
// hint must run the same CLI that prints it, so it stops the correct version.
// `import.meta.url` gives the running module. The bundled build runs this module
// from `<cli>/dist/index.js`, so the hint runs that exact file with node. The
// published package ships no `src` directory and no tsx runner. A source
// checkout runs this module from `<cli>/src/commands/env-lab.ts`, so the hint
// runs `<cli>/src/index.ts` through the checked-out tsx runner. This resolver
// reads an absolute path from the module location, so the hint works from any
// working directory. The `modulePath` parameter is a test seam; production
// callers use the running module path.
export function resolveEnvLabCliInvocation(
  modulePath: string = fileURLToPath(import.meta.url),
): EnvLabCliInvocation {
  const moduleDir = path.dirname(modulePath);
  const isSourceCheckout =
    path.basename(moduleDir) === "commands" && path.basename(path.dirname(moduleDir)) === "src";
  if (isSourceCheckout) {
    const cliRoot = path.resolve(moduleDir, "..", "..");
    return {
      entry: path.join(cliRoot, "src", "index.ts"),
      tsxBin: path.join(cliRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    };
  }
  return { entry: modulePath, tsxBin: null };
}

// Build the env-lab cleanup hint as a copyable shell command. The hint stops the
// fixture that `env-lab doctor` inspected. It runs the same CLI that prints it,
// so it stops the correct version, and it forwards the inspected instance, so it
// stops the correct instance. It passes an inert `argv` value, so no shell reads
// the argument. Each path and the instance id pass through `shellQuoteArgument`,
// so a shell metacharacter stays inert when a contributor pastes the command.
// The `invocation` parameter is a test seam; production callers use the resolved
// running-module invocation.
export function buildEnvLabCleanupCommand(
  opts: { instance?: string; invocation?: EnvLabCliInvocation } = {},
): string {
  const invocation = opts.invocation ?? resolveEnvLabCliInvocation();
  const parts = ["node"];
  if (invocation.tsxBin !== null) {
    parts.push(shellQuoteArgument(invocation.tsxBin));
  }
  parts.push(shellQuoteArgument(invocation.entry), "env-lab down");
  if (opts.instance !== undefined) {
    parts.push("--instance", shellQuoteArgument(opts.instance));
  }
  return parts.join(" ");
}

export async function envLabDoctorCommand(opts: { instance?: string; json?: boolean }) {
  const status = await collectEnvLabDoctorStatus(opts);

  if (opts.json) {
    printJson(status);
    return;
  }

  if (status.ssh.supported) {
    p.log.success("SSH fixture prerequisites are installed.");
  } else {
    p.log.warn(`SSH fixture prerequisites are incomplete: ${status.ssh.reason ?? "unknown reason"}`);
  }

  if (status.ssh.state && status.ssh.running) {
    p.log.success("SSH env-lab fixture is running.");
    summarizeFixture(status.ssh.state);
    p.log.message(`Private key: ${pc.dim(status.ssh.state.clientPrivateKeyPath)}`);
    p.log.message(`Known hosts: ${pc.dim(status.ssh.state.knownHostsPath)}`);
  } else if (status.ssh.state) {
    p.log.warn("SSH env-lab fixture state exists, but the process is not running.");
    p.log.message(`State: ${pc.dim(status.statePath)}`);
  } else {
    p.log.info("SSH env-lab fixture is not running.");
    p.log.message(`State: ${pc.dim(status.statePath)}`);
  }

  // The cleanup hint runs the same CLI that prints it, so it stops the correct
  // version. The bundled build runs `dist/index.js`; a source checkout runs
  // `src/index.ts` through the checked-out tsx runner. The hint uses absolute
  // paths, so it works from any working directory. It passes an inert `argv`
  // value, so no shell reads the argument. See `doc/CLI.md`, "safe invocation".
  //
  // The doctor diagnoses the instance that `resolvePaperclipInstanceId` selects
  // from `opts.instance` or the `PAPERCLIP_INSTANCE_ID` environment variable.
  // The hint pins that resolved instance, so a contributor who pastes the hint
  // in a shell without `PAPERCLIP_INSTANCE_ID` stops the diagnosed fixture, not
  // the default instance.
  const cleanupInstance = resolvePaperclipInstanceId(opts.instance);
  p.log.message(`Cleanup: ${pc.dim(buildEnvLabCleanupCommand({ instance: cleanupInstance }))}`);
}

export function registerEnvLabCommands(program: Command) {
  const envLab = program.command("env-lab").description("Deterministic local environment fixtures");

  envLab
    .command("up")
    .description("Start the default SSH env-lab fixture")
    .option("-i, --instance <id>", "Paperclip instance id (default: current/default)")
    .option("--json", "Print machine-readable fixture details")
    .action(envLabUpCommand);

  envLab
    .command("status")
    .description("Show the current SSH env-lab fixture state")
    .option("-i, --instance <id>", "Paperclip instance id (default: current/default)")
    .option("--json", "Print machine-readable fixture details")
    .action(envLabStatusCommand);

  envLab
    .command("down")
    .description("Stop the default SSH env-lab fixture")
    .option("-i, --instance <id>", "Paperclip instance id (default: current/default)")
    .option("--json", "Print machine-readable stop details")
    .action(envLabDownCommand);

  envLab
    .command("doctor")
    .description("Check SSH fixture prerequisites and current status")
    .option("-i, --instance <id>", "Paperclip instance id (default: current/default)")
    .option("--json", "Print machine-readable diagnostic details")
    .action(envLabDoctorCommand);
}
