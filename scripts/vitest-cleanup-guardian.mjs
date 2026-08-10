#!/usr/bin/env node
import { promises as fs } from "node:fs";
import {
  findRootReferences,
  listInvocationProcesses,
  readLinuxProcessIdentity,
  signalProcessIdentity,
} from "./vitest-supervisor.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

const ownerPid = Number(argument("--owner-pid"));
const ownerStartTime = argument("--owner-start-time");
const invocationId = argument("--invocation-id");
const root = argument("--root");
const registryPath = argument("--registry");
const stopPath = argument("--stop-file");
const graceMs = Number(argument("--grace-ms"));

async function ownerIsAlive() {
  const identity = await readLinuxProcessIdentity(ownerPid);
  return identity?.startTime === ownerStartTime;
}

async function waitForEmpty(waitMs) {
  const deadline = Date.now() + waitMs;
  let processes = await listInvocationProcesses(invocationId, root);
  while (processes.length > 0 && Date.now() < deadline) {
    await delay(100);
    processes = await listInvocationProcesses(invocationId, root);
  }
  return processes;
}

async function signalAll(signal) {
  const processes = await listInvocationProcesses(invocationId, root);
  for (const identity of processes) await signalProcessIdentity(identity, signal);
}

while (await ownerIsAlive()) {
  if (await fs.access(stopPath).then(() => true, () => false)) process.exit(0);
  await delay(250);
}

// The owner disappeared without disarming us (including SIGKILL/OOM). Drain
// only processes carrying this invocation's random inherited tag or one of
// its private root paths in the environment.
await signalAll("SIGTERM");
let survivors = await waitForEmpty(graceMs);
if (survivors.length > 0) {
  await signalAll("SIGKILL");
  survivors = await waitForEmpty(Math.max(2_000, Math.floor(graceMs / 2)));
}
const references = await findRootReferences(root, invocationId);
if (survivors.length === 0 && references.length === 0) {
  const current = JSON.parse(await fs.readFile(registryPath, "utf8").catch(() => "{}"));
  await fs.rm(root, { recursive: true, force: true });
  if (current.cgroupPath) await fs.rmdir(current.cgroupPath).catch(() => undefined);
  await fs.rm(registryPath, { force: true });
} else {
  const current = JSON.parse(await fs.readFile(registryPath, "utf8").catch(() => "{}"));
  await fs.writeFile(
    registryPath,
    `${JSON.stringify({
      ...current,
      status: "guardian_invariant_failure",
      survivorCount: survivors.length,
      rootReferenceCount: references.length,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.exitCode = 1;
}
