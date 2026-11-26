import { spawn } from "node:child_process";

const jobs = [
  { name: "dev", script: "dev" },
  { name: "mobile", script: "dev:mobile" },
];
const nameWidth = Math.max(...jobs.map((j) => j.name.length));
const children = [];
let stopping = false;

function prefix(name, data) {
  const label = `[${name.padEnd(nameWidth)}] `;
  return label + String(data).replace(/\n(?!$)/g, `\n${label}`);
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(code), 500).unref();
}

for (const job of jobs) {
  const child = spawn("pnpm", ["run", job.script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stdout.on("data", (d) => process.stdout.write(prefix(job.name, d)));
  child.stderr.on("data", (d) => process.stderr.write(prefix(job.name, d)));
  child.on("exit", (code, signal) => {
    process.stderr.write(prefix(job.name, `exited (code=${code} signal=${signal})\n`));
    stopAll(code ?? 1);
  });
  children.push({ name: job.name, child });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => stopAll(0));
}
