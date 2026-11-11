import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import {
  REDEPLOY_HOSTNAME_ENV, REDEPLOY_PRELOAD_PATH, nextRedeployIdentity, redeployEnvironment, redeployIdentity, redeployNodeArgs,
  redeployReceipt, redeployWave,
} from "./redeploy.js";
import { planTasks } from "./scheduler.js";
import { FAULT_SIGNAL } from "./supervisor.js";
import type { WavePlan } from "./types.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IMAGE = `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"a".repeat(64)}`;

describe("K15 redeploy identity", () => {
  it("keeps the service and volume and changes the host and deployment on every generation", () => {
    const first = redeployIdentity("w-1", 0);
    const second = nextRedeployIdentity("w-1", first);
    expect(second.generation).toBe(1);
    expect(second.hostname).not.toBe(first.hostname);
    expect(second.deploymentId).not.toBe(first.deploymentId);
    for (const key of ["projectId", "environmentId", "serviceId", "volumeId"] as const) expect(second[key]).toBe(first[key]);
    for (const id of [first.projectId, first.environmentId, first.serviceId, first.deploymentId, first.volumeId]) expect(id).toMatch(UUID);
  });

  it("is deterministic per wave, so a replay derives the same identities", () => {
    expect(redeployIdentity("w-1", 3)).toEqual(redeployIdentity("w-1", 3));
    expect(redeployIdentity("w-2", 0).deploymentId).not.toBe(redeployIdentity("w-1", 0).deploymentId);
    expect(() => redeployIdentity("w-1", -1)).toThrow(/non-negative/);
  });

  it("names the Railway variables the server reads as its deployment, with the instance home as the exclusive volume", () => {
    const identity = redeployIdentity("w-1", 2);
    expect(redeployEnvironment(identity, "/tmp/chaos/home")).toEqual({
      [REDEPLOY_HOSTNAME_ENV]: identity.hostname,
      RAILWAY_PROJECT_ID: identity.projectId, RAILWAY_ENVIRONMENT_ID: identity.environmentId, RAILWAY_SERVICE_ID: identity.serviceId,
      RAILWAY_DEPLOYMENT_ID: identity.deploymentId, RAILWAY_VOLUME_ID: identity.volumeId, RAILWAY_VOLUME_MOUNT_PATH: "/tmp/chaos/home",
    });
    expect(redeployReceipt(redeployIdentity("w-1", 0), identity)).toMatchObject({ fromGeneration: 0, toGeneration: 2,
      toDeploymentId: identity.deploymentId, volumeId: identity.volumeId });
  });

  it("loads the preload ahead of the server's own --import loader", () => {
    expect(redeployNodeArgs(["--import", "/x/tsx/loader.mjs", "entry.ts"])).toEqual(["--import", REDEPLOY_PRELOAD_PATH, "--import", "/x/tsx/loader.mjs", "entry.ts"]);
  });

  it("changes os.hostname for both the CommonJS object and ESM named imports, as processSpaceHash reads it", () => {
    const script = "import os from 'node:os'; import { hostname } from 'node:os'; console.log(JSON.stringify([os.hostname(), hostname()]));";
    const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--import", REDEPLOY_PRELOAD_PATH, "--input-type=module", "-e", script],
      { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
    const emulated = run({ [REDEPLOY_HOSTNAME_ENV]: "chaos-deploy-test" });
    expect(emulated.status).toBe(0);
    expect(JSON.parse(emulated.stdout)).toEqual(["chaos-deploy-test", "chaos-deploy-test"]);
    // Without the variable the preload changes nothing.
    const real = run({});
    expect(real.status).toBe(0);
    const [cjs, esm] = JSON.parse(real.stdout) as string[];
    expect(cjs).toBe(esm);
    expect(cjs).not.toBe("chaos-deploy-test");
  });
});

describe("K15 wave options", () => {
  it("is a graceful stop, selectable on local and Daytona like K2", () => {
    expect(FAULT_SIGNAL.K15).toBe("SIGTERM");
    const local = parseCommand(["--faults", "K15", "--adapters", "opencode", "--workloads", "A1,C1", "--seed", "1"]);
    expect(local.mode === "wave" && local.options.faults).toEqual(["K15"]);
    const daytona = parseCommand(["--env", "daytona", "--daytona-image", IMAGE, "--faults", "K2,K15", "--adapters", "opencode",
      "--workloads", "C1", "--daytona-reuse-lease", "--seed", "1"]);
    if (daytona.mode !== "wave") throw new Error("expected a wave");
    expect(daytona.options.faults).toEqual(["K2", "K15"]);
    expect(daytona.options.daytonaReuseLease).toBe(true);
  });

  it("refuses a second server beside an emulated deploy", () => {
    expect(() => parseCommand(["--faults", "K15,MS1", "--workloads", "B5,Q1", "--concurrency", "1", "--seed", "1"])).toThrow(/K15 \(redeploy\) does not combine with MS1-MS3/);
  });

  it("plans K15 cells with no hold and marks the wave as a redeploy wave", () => {
    const parsed = parseCommand(["--faults", "K15", "--adapters", "codex,opencode", "--workloads", "A1,C1", "--tasks", "4", "--seed", "7"]);
    if (parsed.mode !== "wave") throw new Error("expected a wave");
    const tasks = planTasks(parsed.options);
    expect(tasks.every(task => task.fault === "K15" && task.holdMs === 0)).toBe(true);
    const plan = { options: parsed.options, tasks } as Pick<WavePlan, "options" | "tasks" | "storm">;
    expect(redeployWave(plan)).toBe(true);
    const k2 = parseCommand(["--faults", "K2", "--workloads", "A1", "--tasks", "2", "--seed", "7"]);
    if (k2.mode !== "wave") throw new Error("expected a wave");
    expect(redeployWave({ options: k2.options, tasks: planTasks(k2.options) })).toBe(false);
    // A replay of a K2 task that a K15 crossed still needs the emulated identity.
    expect(redeployWave({ options: k2.options, tasks: [{ ...planTasks(k2.options)[0]!,
      replayFaults: [{ kind: "K15", holdMs: 0, atMs: 1_000 }] }] })).toBe(true);
  });
});
