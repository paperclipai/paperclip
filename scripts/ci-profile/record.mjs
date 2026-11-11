import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// PR processes write timing data only. They never receive a Honeycomb key.
export function recorder(framework, environment = process.env) {
  const enabled = environment.PAPERCLIP_CI_PROFILE === "true";
  const directory = environment.PAPERCLIP_CI_PROFILE_DIR;
  const invocation = environment.PAPERCLIP_CI_PROFILE_INVOCATION || randomUUID();
  const file = directory && path.join(directory, `${framework}-${invocation}.ndjson`);
  let warned = false;
  return (record) => {
    if (!enabled || !file) return;
    try {
      mkdirSync(directory, { recursive: true });
      appendFileSync(file, JSON.stringify({
        version: 1,
        framework,
        invocation,
        job: environment.PAPERCLIP_CI_PROFILE_JOB,
        runId: environment.GITHUB_RUN_ID,
        attempt: environment.GITHUB_RUN_ATTEMPT,
        ...record,
      }) + "\n");
    } catch {
      // Profiling must not change a test's result. The exporter reports gaps.
      if (!warned) console.error("CI profile: unable to write test timing data");
      warned = true;
    }
  };
}

// The launcher records intent before starting the test runner. A reporter that
// never loads or never writes anything must still leave a detectable gap.
export function invocationEnv(framework, environment = process.env) {
  if (environment.PAPERCLIP_CI_PROFILE !== "true") return environment;
  const env = { ...environment, PAPERCLIP_CI_PROFILE_INVOCATION: randomUUID() };
  recorder(framework, env)({ kind: "expected" });
  return env;
}

export function relativeFile(file) {
  return path.relative(process.env.GITHUB_WORKSPACE || process.cwd(), file).replaceAll("\\", "/");
}
