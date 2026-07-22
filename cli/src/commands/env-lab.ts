import path from "node:path";
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

  p.log.message(`Cleanup: ${pc.dim("pnpm paperclipai env-lab down")}`);
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
