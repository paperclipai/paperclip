import { spawnSync } from "node:child_process";
import path from "node:path";

export function runStep(label, command, args, { cwd, env = {} }) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env, CI: process.env.CI ?? "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const display = `${Object.entries(env)
    .map(([key, value]) => `${key}=${value} `)
    .join("")}${command} ${args.join(" ")}`;
  return { label, command: display, cwd, ok: result.status === 0, status: result.status, output, error: result.error?.message };
}

export function verificationSteps(ctx, { noBuild = false } = {}) {
  const steps = [
    { label: "storybook catalog", command: "node", args: ["scripts/storybook-catalog.mjs", "--check"], cwd: "." },
    { label: "lab vitest", command: "npx", args: ["vitest", "run", `src/${ctx.slug}-directions`], cwd: "ui" },
  ];
  if (!noBuild) {
    steps.push({
      label: "lab vite build",
      command: "npx",
      args: ["vite", "build", "--config", ctx.configFile],
      cwd: "ui",
      env: { [ctx.envOutDir]: ctx.staticDir },
    });
  }
  return steps;
}

export function runVerification(root, steps, { onStep } = {}) {
  const results = [];
  for (const step of steps) {
    const result = runStep(step.label, step.command, step.args, { cwd: path.join(root, step.cwd), env: step.env });
    results.push(result);
    onStep?.(result);
    if (!result.ok) break;
  }
  return { ok: results.every((result) => result.ok), results };
}

export function describeFailure(result) {
  const header = `FAILED ${result.label}: (cd ${result.cwd} && ${result.command}) exited ${result.status ?? "with no status"}`;
  return `${header}\n${result.error ? `${result.error}\n` : ""}${result.output}`;
}
